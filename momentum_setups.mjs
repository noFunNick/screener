import fs from 'fs/promises';
import path from 'path';
import PropertiesReader from 'properties-reader';
import yahooFinanceModule from 'yahoo-finance2';
import { SMA, RSI, ATR, MACD, ADX } from 'technicalindicators';

const rawYahooFinance = yahooFinanceModule.default || yahooFinanceModule;
let yahooFinance = null;
try {
  // v4 exports a class that needs instantiation: `new YahooFinance()`
  yahooFinance = (typeof rawYahooFinance === 'function')
    ? new rawYahooFinance({ suppressNotices: ['ripHistorical', 'yahooSurvey'] })
    : rawYahooFinance;
} catch (e) {
  yahooFinance = rawYahooFinance;
}

const root = process.cwd();

function readConfig(file = 'config.properties') {
  try {
    const props = PropertiesReader(file);
    return {
      TICKER: props.get('TICKER'),
      TEMPLATE: props.get('TEMPLATE'),
      TICKERS: props.get('TICKERS'),
      NYSE: props.get('NYSE'),
      NASDAQ1B: props.get('NASDAQ1B'),
      TEST: props.get('TEST'),
      RISK_MODE: props.get('RISK_MODE'),
      INDUSTRY_MIN_BREADTH: props.get('INDUSTRY_MIN_BREADTH'),
      INDUSTRY_MIN_COUNT: props.get('INDUSTRY_MIN_COUNT')
    };
  } catch (e) {
    console.error('Failed to read config.properties', e);
    return {};
  }
}

function formatDate(d) {
  return d.toISOString().slice(0, 10);
}

function tomorrow() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return formatDate(d);
}

function parseNumOr(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeSymbol(sym) {
  return String(sym || '').trim().replace(/[./]/g, '-');
}

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === ',' && !inQuotes) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

async function loadIndustryMap(csvPath) {
  try {
    const txt = await fs.readFile(csvPath, 'utf8');
    const lines = txt.split(/\r?\n/).filter(Boolean);
    if (!lines.length) return new Map();
    const headers = parseCsvLine(lines[0]);
    const symbolIdx = headers.findIndex(h => /symbol/i.test(h));
    const industryIdx = headers.findIndex(h => /^industry$/i.test(h.trim()));
    if (symbolIdx < 0 || industryIdx < 0) return new Map();

    const map = new Map();
    for (let i = 1; i < lines.length; i++) {
      const cols = parseCsvLine(lines[i]);
      const symbolRaw = (cols[symbolIdx] || '').trim();
      const industry = (cols[industryIdx] || '').trim();
      if (!symbolRaw || !industry) continue;
      map.set(symbolRaw, industry);
      map.set(normalizeSymbol(symbolRaw), industry);
    }
    return map;
  } catch {
    return new Map();
  }
}

async function loadIndustryRanks(filePath) {
  try {
    const txt = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(txt);
    const rows = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.rankings) ? parsed.rankings : []);
    const rankMap = new Map();
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const industry = (r.industry || r.name || '').trim();
      if (!industry) continue;
      const rank = Number(r.rank) || (i + 1);
      rankMap.set(industry, {
        rank,
        breadth: parseNumOr(r.breadth, 0),
        count: parseNumOr(r.count, 0),
        industry_score: parseNumOr(r.industry_score, 0)
      });
    }
    return rankMap;
  } catch {
    return new Map();
  }
}

function industryBonusFromStats(stats, opts) {
  if (!stats) return 0;
  const rank = Number(stats.rank);
  const breadth = parseNumOr(stats.breadth, 0);
  const count = parseNumOr(stats.count, 0);
  if (!Number.isFinite(rank)) return 0;
  if (breadth < opts.minBreadth || count < opts.minCount) return 0;
  if (rank <= 5) return 12;
  if (rank <= 10) return 8;
  if (rank <= 20) return 4;
  return 0;
}

function normalizeRiskMode(cfg) {
  const raw = process.env.RISK_MODE ?? cfg.RISK_MODE ?? 'normal';
  const mode = String(raw).trim().toLowerCase();
  return (mode === 'risk-off' || mode === 'riskoff' || mode === 'defensive') ? 'risk-off' : 'normal';
}

async function hasLiquidOptions(symbol, min_oi = 800, max_spread_pct = 0.20, min_volume = 10) {
  try {
    const opt = await yahooFinance.options(symbol);
    if (!opt || !opt.options || !opt.options.length){
        console.log(`[${symbol}] no option chains found`);
        return false;
    } 
    const maxExpiryMs = 7 * 24 * 60 * 60 * 1000;
    const shortDatedChains = opt.options.filter(chain => {
      const expiry = chain.expirationDate ? new Date(chain.expirationDate) : null;
      return expiry && Number.isFinite(expiry.getTime()) && (expiry.getTime() - Date.now()) <= maxExpiryMs;
    });
    if (!shortDatedChains.length) {
        console.log(`[${symbol}] no short-dated option chains found (<=7 days to expiry)`);
      return false;
    }

    const price = opt.quote?.regularMarketPrice || opt.quote?.price || 0;

    return shortDatedChains.some(chain => {
      const calls = chain.calls || [];
      const puts = chain.puts || [];
      const allContracts = [...calls, ...puts];
      if (!allContracts.length){
        console.log(`[${symbol}] no calls or puts found for chain expiring ${chain.expirationDate}`);
        return false;
      } 

      const otm_pct = 0.10;
      const lo = price * (1 - otm_pct);
      const hi = price * (1 + otm_pct);

      return allContracts.some(c => {
        const strike = Number(c.strike);
        if (price > 0 && (strike < lo || strike > hi)) return false;
        const oi = Number(c.openInterest) || 0;
        if (oi < min_oi){
            console.log(`[${symbol}] skipping contract with low OI: strike=${strike}, OI=${oi}, bid=${c.bid}, ask=${c.ask}`);
            return false;

        } 
        const bid = Number(c.bid) || 0;
        const ask = Number(c.ask) || 0;
        const vol = Number(c.volume) || 0;
        const mid = (bid + ask) / 2;
        if (mid > 0) {
          return (ask - bid) / mid <= max_spread_pct;
        }
        return vol >= min_volume;
      });
    });
  } catch (e) {
    return false;
  }
}

function lastAdxParts(adxArr) {
  if (!adxArr || !adxArr.length) {
    return { adx: 0, pdi: 0, mdi: 0 };
  }
  const last = adxArr[adxArr.length - 1];
  const prev = adxArr.length > 1 ? adxArr[adxArr.length - 2] : last;
  return {
    adx: Number(last.adx ?? last) || 0,
    pdi: Number(last.pdi ?? 0) || 0,
    mdi: Number(last.mdi ?? 0) || 0,
    prevAdx: Number(prev.adx ?? prev) || 0
  };
}

async function analyze(symbol, periodStart, riskMode = 'normal', spyClose = [], industryCtx = null) {
  try {
    const debugSkip = process.env.DEBUG_SKIP === '1';
    const skip = (reason) => {
      if (debugSkip) console.log(`  [skip] ${symbol}: ${reason}`);
      return null;
    };

    const sym = normalizeSymbol(symbol);
    const chartData = await yahooFinance.chart(sym, {
      period1: periodStart,
      period2: tomorrow(),
      interval: '1d'
    });
    if (!chartData || !Array.isArray(chartData.quotes) || chartData.quotes.length === 0) return skip('no chart quotes');

    const hist = chartData.quotes.filter(h => h.close != null && h.high != null && h.low != null && h.volume != null);
    if (!Array.isArray(hist) || hist.length < 120) return skip(`insufficient history (${hist?.length || 0})`);

    const close = hist.map(h => h.close);
    const high = hist.map(h => h.high);
    const low = hist.map(h => h.low);
    const volume = hist.map(h => h.volume);

    const sma20 = SMA.calculate({ period: 20, values: close });
    const sma50 = SMA.calculate({ period: 50, values: close });
    const sma200 = SMA.calculate({ period: 200, values: close });
    const rsi = RSI.calculate({ period: 14, values: close });
    const atr = ATR.calculate({ period: 14, high, low, close });
    let adx = [];
    try {
      adx = ADX.calculate({ period: 14, high, low, close });
    } catch (e) { /* ignore */ }
    const macd = MACD.calculate({
      values: close,
      fastPeriod: 12,
      slowPeriod: 26,
      signalPeriod: 9,
      SimpleMAOscillator: false,
      SimpleMASignal: false
    });

    const lastIdx = close.length - 1;
    const adxParts = lastAdxParts(adx);
    const latest = {
      Close: close[lastIdx],
      High: high[lastIdx],
      Low: low[lastIdx],
      ATR: atr.length ? atr[atr.length - 1] : 0,
      RSI: rsi.length ? rsi[rsi.length - 1] : 0,
      ADX: adxParts.adx,
      PLUS_DI: adxParts.pdi,
      MINUS_DI: adxParts.mdi,
      MACD_hist: macd.length ? (macd[macd.length - 1].histogram || macd[macd.length - 1].hist || 0) : 0
    };

    if (latest.Close < 3) return skip('price below 3');
    if (latest.Close > 2000) return skip('price above 2000');

    const closes20 = close.slice(-20);
    const vols20 = volume.slice(-20);
    const dollarVol = closes20.reduce((s, c, idx) => s + c * vols20[idx], 0) / Math.min(20, closes20.length);
    if (dollarVol < 15_000_000) return skip(`dollar volume too low (${Math.round(dollarVol)})`);

    const options_ok = await hasLiquidOptions(symbol, 1000, 0.20, 10);

    const commonLen = Math.min(spyClose.length, close.length);
    const lookback = Math.min(63, Math.max(commonLen - 1, 1));
    const stock_perf = close[close.length - 1] / close[close.length - 1 - lookback] - 1;
    const spy_perf = spyClose.length >= lookback + 1
      ? spyClose[spyClose.length - 1] / spyClose[spyClose.length - 1 - lookback] - 1
      : 0;
    const rs = (1 + spy_perf) !== 0 ? (1 + stock_perf) / (1 + spy_perf) : 1;

    const pct_from_high = (latest.High - latest.Close) / latest.Close * 100;
    const atr_from_high = latest.ATR > 0 ? (latest.High - latest.Close) / latest.ATR : 99;

    const vol20 = volume.slice(-20).reduce((s, v) => s + v, 0) / 20;
    const vol5slice = volume.slice(-5);
    const vol5 = vol5slice.reduce((s, v) => s + v, 0) / Math.max(vol5slice.length, 1);
    const rel_vol_today = volume[volume.length - 1] / (vol20 || 1);
    const rel_vol_5d = vol5 / (vol20 || 1);

    // Skip only extremely quiet names; previous thresholds were filtering too broadly.
    if (rel_vol_today < 0.55 && rel_vol_5d < 0.9) return skip(`too quiet (relVol=${rel_vol_today.toFixed(2)}, relVol5d=${rel_vol_5d.toFixed(2)})`);

    const prev = { High: high[high.length - 2], Close: close[close.length - 2] };
    const prev2 = { High: high[high.length - 3], Close: close[close.length - 3] };
    const higher_high = latest.High > prev.High && prev.High > prev2.High;
    const higher_close = latest.Close > prev.Close && prev.Close > prev2.Close;
    const consecutive_up = latest.Close > prev.Close && prev.Close > prev2.Close;

    let score = 0.0;
    const riskOff = riskMode === 'risk-off';
    const rsiVal = latest.RSI;

    if (riskOff) {
      if (rel_vol_5d < 1.15) score -= 10;
      if (pct_from_high > 1.4 || atr_from_high > 1.0) score -= 10;
    }

    // A. Proximity to prior-day high
    if (pct_from_high <= 0.3 || atr_from_high <= 0.25) score += 35;
    else if (pct_from_high <= 0.7 || atr_from_high <= 0.5) score += 28;
    else if (pct_from_high <= 1.2 || atr_from_high <= 0.8) score += 18;
    else if (pct_from_high <= 2.0) score += 8;

    // B. Volume
    if (rel_vol_today >= 2.5 || rel_vol_5d >= 2.0) score += 30;
    else if (rel_vol_today >= 1.8 || rel_vol_5d >= 1.6) score += 24;
    else if (rel_vol_today >= 1.4 || rel_vol_5d >= 1.3) score += 16;
    else if (rel_vol_today >= 1.1) score += 8;

    // C. Trend structure
    const sma20v = sma20[sma20.length - 1];
    const sma50v = sma50[sma50.length - 1];
    const sma200v = sma200[sma200.length - 1];
    if (latest.Close > sma20v && sma20v > sma50v && sma50v > sma200v) score += 20;
    else if (latest.Close > sma20v && sma20v > sma50v) score += 14;
    else if (latest.Close > sma50v) score += 8;
    else if (sma50v > sma200v) score += 3;

    // Stretch vs SMA20 — penalize already-hot names
    const stretch = sma20v > 0 ? (latest.Close / sma20v - 1) * 100 : 0;
    if (stretch > 8) score -= 12;
    else if (stretch > 5) score -= 6;

    // D. Directional movement
    const plus_di = latest.PLUS_DI;
    const minus_di = latest.MINUS_DI;
    const di_spread = plus_di - minus_di;
    if (plus_di > minus_di) {
      if (di_spread >= 12) score += 15;
      else if (di_spread >= 8) score += 11;
      else if (di_spread >= 4) score += 7;
      else score += 3;
    }

    // E. ADX
    const adxv = latest.ADX;
    const adx_rising = adxv > adxParts.prevAdx;
    if (riskOff) {
      if (di_spread < 6 || !adx_rising) score -= 8;
      if (adxv >= 35 && adx_rising) score += 12;
      else if (adxv >= 30 && adx_rising) score += 9;
      else if (adxv >= 25 && adx_rising) score += 6;
      else score -= 8;
    } else {
      if (adxv >= 35 && adx_rising) score += 12;
      else if (adxv >= 30) score += 9;
      else if (adxv >= 25) score += 6;
      else if (adxv >= 20) score += 3;
    }

    // F. Consecutive strength — do not stack this on already-extended names
    if (rsiVal < 70) {
      if (higher_high && higher_close) score += 10;
      else if (consecutive_up) score += 6;
      else if (latest.Close > prev.Close) score += 3;
    }

    // G. Relative strength
    if (rs >= 1.20) score += 8;
    else if (rs >= 1.10) score += 6;
    else if (rs >= 1.03) score += 4;
    else if (rs >= 0.98) score += 1;

    // H. RSI — actually punish extended names
    if (riskOff) {
      if (rsiVal > 72) score -= 16;
      else if (rsiVal > 68) score -= 8;
      else if (rsiVal >= 52 && rsiVal <= 66) score += 8;
      else if (rsiVal < 45) score -= 8;
    } else {
      if (rsiVal > 78) score -= 14;
      else if (rsiVal > 72) score -= 8;
      else if (rsiVal > 68) score -= 3;
      else if (rsiVal >= 52 && rsiVal <= 68) score += 8;
      else if (rsiVal < 42) score -= 6;
    }

    // I. MACD
    if (riskOff) {
      if (latest.MACD_hist > 0) score += 2;
      else score -= 3;
    } else if (latest.MACD_hist > 0) {
      score += 2;
    }

    if (!options_ok) score -= 4;

    const industry = industryCtx?.industryBySymbol?.get(symbol) || industryCtx?.industryBySymbol?.get(sym) || null;
    const industryStats = industry ? industryCtx?.rankByIndustry?.get(industry) : null;
    const industryRank = industryStats?.rank ?? null;
    const industry_bonus = industryBonusFromStats(industryStats, industryCtx?.bonusOpts || { minBreadth: 0.2, minCount: 4 });
    score += industry_bonus;

    const entry = latest.Close;
    const stop = entry - 1.2 * latest.ATR;
    const target = entry + 2.5 * latest.ATR;
    const risk_reward = (target - entry) / (entry - stop > 0 ? (entry - stop) : 1);

    return {
      symbol,
      score: Math.round(score * 10) / 10,
      close: Math.round(entry * 100) / 100,
      pct_from_high: Math.round(pct_from_high * 100) / 100,
      atr_from_high: Math.round(atr_from_high * 100) / 100,
      stretch_sma20: Math.round(stretch * 100) / 100,
      rel_vol_today: Math.round(rel_vol_today * 100) / 100,
      rel_vol_5d: Math.round(rel_vol_5d * 100) / 100,
      rsi: Math.round(rsiVal * 10) / 10,
      adx: Math.round(adxv * 10) / 10,
      plus_di: Math.round(plus_di * 10) / 10,
      rs_3m: Math.round(rs * 100) / 100,
      atr: Math.round(latest.ATR * 100) / 100,
      stop: Math.round(stop * 100) / 100,
      target: Math.round(target * 100) / 100,
      risk_reward: Math.round(risk_reward * 100) / 100,
      dollar_vol_20d: Math.round(dollarVol),
      options_ok: Boolean(options_ok),
      industry,
      industry_rank: industryRank || null,
      industry_breadth: industryStats?.breadth ?? null,
      industry_count: industryStats?.count ?? null,
      industry_bonus,
      higher_high: Boolean(higher_high),
      consecutive_up: Boolean(consecutive_up),
      extended: Boolean(rsiVal > 70 || stretch > 5)
    };
  } catch (e) {
    console.error(`  [!] ${symbol}: ${e.message}`);
    return null;
  }
}

async function main() {
  const cfg = readConfig();
  const riskMode = normalizeRiskMode(cfg);
  const bonusOpts = {
    minBreadth: parseNumOr(process.env.INDUSTRY_MIN_BREADTH ?? cfg.INDUSTRY_MIN_BREADTH, 0.22),
    minCount: parseNumOr(process.env.INDUSTRY_MIN_COUNT ?? cfg.INDUSTRY_MIN_COUNT, 5)
  };
  const industryBySymbol = await loadIndustryMap(path.join(root, 'all_1bn_MarketCap.csv'));
  const rankByIndustry = await loadIndustryRanks(path.join(root, 'industry_rankings_latest.json'));
  console.log(`Industry map loaded: ${industryBySymbol.size} symbol keys`);
  console.log(`Industry ranks loaded: ${rankByIndustry.size} industries`);
  console.log(`Industry bonus gates: breadth>=${bonusOpts.minBreadth}, count>=${bonusOpts.minCount}`);
  const industryCtx = { industryBySymbol, rankByIndustry, bonusOpts };
  const tickerStr = cfg.NASDAQ1B //|| cfg.TICKERS || cfg.TEST || '';
  const tickers = tickerStr.split(/\s+/).filter(Boolean);
  if (!tickers.length) {
    console.error('No tickers in config (NASDAQ1B, TICKERS, or TEST)');
    process.exit(1);
  }

  const start = new Date();
  start.setDate(start.getDate() - 365);
  const startStr = formatDate(start);

  console.log(`Fetching SPY once for RS...`);
  const spyData = await yahooFinance.chart('SPY', {
    period1: startStr,
    period2: tomorrow(),
    interval: '1d'
  });
  const spyClose = (spyData?.quotes || []).filter(q => q.close != null).map(q => q.close);

  console.log(`Scoring ${tickers.length} tickers (mode=${riskMode})...`);
  const results = [];
  for (let i = 0; i < tickers.length; i++) {
    const s = tickers[i];
    process.stdout.write(`[${i + 1}/${tickers.length}] ${s}...`);
    const r = await analyze(s, startStr, riskMode, spyClose, industryCtx);
    if (r) {
      results.push(r);
      console.log(` score=${r.score}${r.extended ? ' [extended]' : ''}`);
    } else {
      console.log(' skipped');
    }
  }

  results.sort((a, b) => b.score - a.score);
  const top40 = results.slice(0, 40);
  const honorableMentions = top40.slice(20, 40);

  const outFile = path.join(root, `momentum_results_${formatDate(new Date())}.json`);
  await fs.writeFile(outFile, JSON.stringify(top40, null, 2), 'utf8');
  console.log('Wrote', outFile);

  const honorableMentionsFile = path.join(root, `momentum_honorable_mentions_${formatDate(new Date())}.json`);
  await fs.writeFile(honorableMentionsFile, JSON.stringify(honorableMentions, null, 2), 'utf8');
  console.log('Wrote', honorableMentionsFile);

  const honorableMentionsLatestFile = path.join(root, 'momentum_honorable_mentions.json');
  await fs.writeFile(honorableMentionsLatestFile, JSON.stringify(honorableMentions, null, 2), 'utf8');
  console.log('Wrote', honorableMentionsLatestFile);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});