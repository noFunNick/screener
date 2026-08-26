import fs from 'fs/promises';
import path from 'path';
import PropertiesReader from 'properties-reader';
import yahooFinanceModule from 'yahoo-finance2';
const rawYahooFinance = yahooFinanceModule.default || yahooFinanceModule;
let yahooFinance = null;
try{
  // v4 exports a class that needs instantiation: `new YahooFinance()`
  // suppress one-time notices
  yahooFinance = (typeof rawYahooFinance === 'function') ? new rawYahooFinance({ suppressNotices: ['ripHistorical', 'yahooSurvey'] }) : rawYahooFinance;
}catch(e){
  // fallback to raw export
  yahooFinance = rawYahooFinance;
}
import { SMA, RSI, ATR, MACD, ADX } from 'technicalindicators';

const root = process.cwd();

function readConfig(file='config.properties'){
  try{
    const props = PropertiesReader(file);
    return {
      TICKER: props.get('TICKER'),
      TEMPLATE: props.get('TEMPLATE'),
      TICKERS: props.get('TICKERS'),
      NYSE: props.get('NYSE'),
      NASDAQ1B: props.get('NASDAQ1B'),
      TEST: props.get('TEST'),
      RISK_MODE: props.get('RISK_MODE')
    };
  }catch(e){
    console.error('Failed to read config.properties', e); return {};
  }
}

function formatDate(d){ return d.toISOString().slice(0,10); }
function tomorrow(){ const d = new Date(); d.setDate(d.getDate()+1); return formatDate(d); }

function normalizeRiskMode(cfg){
  const raw = process.env.RISK_MODE ?? cfg.RISK_MODE ?? 'normal';
  const mode = String(raw).trim().toLowerCase();
  return (mode === 'risk-off' || mode === 'riskoff' || mode === 'defensive') ? 'risk-off' : 'normal';
}

async function hasLiquidOptions(symbol, min_oi=250, max_spread_pct=0.25, min_volume=100){
  try{
    const opt = await yahooFinance.options(symbol);
    if(!opt || !opt.options || !opt.options.length) return false;
    const chain = opt.options[0];
    const price = opt.quote?.regularMarketPrice || opt.quote?.price || 0;
    const calls = chain.calls || [];
    const puts  = chain.puts  || [];
    const allContracts = [...calls, ...puts];
    if(!allContracts.length) return false;

    // Include any contract with a strike within 10% of current price (either direction)
    const otm_pct = 0.10;
    const lo = price * (1 - otm_pct);
    const hi = price * (1 + otm_pct);

    // Check if any contract within that band qualifies.
    // Primary: OI + bid/ask spread.
    // Fallback: if Yahoo returns zero bid/ask snapshots, allow strong OI+volume.
    return allContracts.some(c => {
      const strike = Number(c.strike);
      if(price > 0 && (strike < lo || strike > hi)) return false;
      const oi = Number(c.openInterest) || 0;
      if(oi < min_oi) return false;
      const bid = Number(c.bid) || 0;
      const ask = Number(c.ask) || 0;
      const vol = Number(c.volume) || 0;
      const mid = (bid + ask) / 2;
      if(mid > 0){
        return (ask - bid) / mid <= max_spread_pct;
      }
      // Data-quality fallback for delayed/zeroed bid-ask snapshots.
      return vol >= min_volume;
    });
  }catch(e){ return false; }
}

async function analyze(symbol, periodStart, riskMode='normal'){
  try{
    // chart() in yahoo-finance2 v4 returns { meta, quotes, events }
    // where quotes is an array of { date, open, high, low, close, volume }
    const sym = symbol.replace('.', '-');
    const chartData = await yahooFinance.chart(sym, { period1: periodStart, period2: tomorrow(), interval: '1d' });
    if(!chartData || !Array.isArray(chartData.quotes) || chartData.quotes.length === 0) return null;
    const hist = chartData.quotes.filter(h => h.close != null);
    if(!Array.isArray(hist) || hist.length < 120) return null;
    const close = hist.map(h=>h.close);
    const high = hist.map(h=>h.high);
    const low = hist.map(h=>h.low);
    const open = hist.map(h=>h.open);
    const volume = hist.map(h=>h.volume);

    // indicators
    const sma20 = SMA.calculate({ period:20, values: close });
    const sma50 = SMA.calculate({ period:50, values: close });
    const sma200 = SMA.calculate({ period:200, values: close });
    const rsi = RSI.calculate({ period:14, values: close });
    const atr = ATR.calculate({ period:14, high, low, close });
    let adx = [];
    try{ adx = ADX.calculate({ period:14, high, low, close }); }catch(e){ /* ignore */ }
    const macd = MACD.calculate({ values: close, fastPeriod:12, slowPeriod:26, signalPeriod:9, SimpleMAOscillator:false, SimpleMASignal:false });

    // align indexes to the latest
    const lastIdx = close.length - 1;
    const latest = {
      Close: close[lastIdx],
      High: high[lastIdx],
      Low: low[lastIdx],
      ATR: atr.length ? atr[atr.length-1] : 0,
      RSI: rsi.length ? rsi[rsi.length-1] : 0,
      ADX: adx.length ? adx[adx.length-1].adx || adx[adx.length-1] : (adx.length?adx[adx.length-1]:0),
      PLUS_DI: adx.length ? adx[adx.length-1].pdi || 0 : 0,
      MINUS_DI: adx.length ? adx[adx.length-1].mdi || 0 : 0,
      MACD_hist: macd.length ? macd[macd.length-1].histogram || (macd[macd.length-1].hist) || 0 : 0
    };

    // risk checks – no upper bound; skip penny stocks only
    if(latest.Close < 3) return null;
    if(latest.Close > 500) return null;
    // liquidity: dollar vol 20d
    const closes = close.slice(-20); const vols = volume.slice(-20);
    const dollarVol = closes.reduce((s,c,idx)=>s + c * vols[idx], 0) / Math.min(20, closes.length);
    if(dollarVol < 15_000_000) return null;

    const options_ok = await hasLiquidOptions(symbol, 250, 0.25, 100);

    // RS vs SPY via chart()
    const spyData = await yahooFinance.chart('SPY', { period1: periodStart, period2: tomorrow(), interval: '1d' });
    const spy_close = (spyData?.quotes || []).filter(q=>q.close!=null).map(q=>q.close);
    const commonLen = Math.min(spy_close.length, close.length);
    const lookback = Math.min(63, commonLen-1);
    const stock_perf = close[close.length-1] / close[close.length-1-lookback] - 1;
    const spy_perf = spy_close.length >= lookback+1 ? spy_close[spy_close.length-1] / spy_close[spy_close.length-1-lookback] - 1 : 0;
    const rs = spy_perf !== -1 ? (1+stock_perf)/(1+spy_perf) : 1;

    // compute pct from high and atr_from_high
    const pct_from_high = (latest.High - latest.Close)/latest.Close * 100;
    const atr_from_high = latest.ATR > 0 ? (latest.High - latest.Close)/latest.ATR : 99;

    // relative vol
    const vol20 = volume.slice(-20).reduce((s,v)=>s+v,0)/20;
    const vol5 = volume.slice(-5).reduce((s,v)=>s+v,0)/Math.min(5, volume.slice(-5).length);
    const rel_vol_today = volume[volume.length-1] / (vol20 || 1);
    const rel_vol_5d = vol5 / (vol20 || 1);

    // recent highs/closes
    const prev = { High: high[high.length-2], Close: close[close.length-2] };
    const prev2 = { High: high[high.length-3], Close: close[close.length-3] };
    const higher_high = latest.High > prev.High && prev.High > prev2.High;
    const higher_close = latest.Close > prev.Close && prev.Close > prev2.Close;
    const consecutive_up = latest.Close > prev.Close && prev.Close > prev2.Close;

    // scoring (mirror python)
    let score = 0.0;

    const riskOff = riskMode === 'risk-off';

    // risk-off guards to reduce late-stage chase names
    if(riskOff){
      if(rel_vol_5d < 1.15) score -= 10;
      if(pct_from_high > 1.4 || atr_from_high > 1.0) score -= 10;
    }

    if(pct_from_high <= 0.3 || atr_from_high <= 0.25) score += 35;
    else if(pct_from_high <= 0.7 || atr_from_high <= 0.5) score += 28;
    else if(pct_from_high <= 1.2 || atr_from_high <= 0.8) score += 18;
    else if(pct_from_high <= 2.0) score += 8;

    if(rel_vol_today >= 2.5 || rel_vol_5d >= 2.0) score += 30;
    else if(rel_vol_today >= 1.8 || rel_vol_5d >= 1.6) score += 24;
    else if(rel_vol_today >= 1.4 || rel_vol_5d >= 1.3) score += 16;
    else if(rel_vol_today >= 1.1) score += 8;

    // trend
    const sma20v = sma20[sma20.length-1];
    const sma50v = sma50[sma50.length-1];
    const sma200v = sma200[sma200.length-1];
    if(latest.Close > sma20v && sma20v > sma50v && sma50v > sma200v) score += 20;
    else if(latest.Close > sma20v && sma20v > sma50v) score += 14;
    else if(latest.Close > sma50v) score += 8;
    else if(sma50v > sma200v) score += 3;

    const plus_di = latest.PLUS_DI; const minus_di = latest.MINUS_DI;
    const di_spread = plus_di - minus_di;
    if(plus_di > minus_di){ if(di_spread >= 12) score += 15; else if(di_spread >= 8) score += 11; else if(di_spread >=4) score +=7; else score +=3 }

    const adxv = latest.ADX; const adx_rising = adxv > (adx.length>1?adx[adx.length-2].adx||adx[adx.length-2]:0);
    if(riskOff){
      if(di_spread < 6 || !adx_rising) score -= 8;
      if(adxv >= 35 && adx_rising) score += 12;
      else if(adxv >= 30 && adx_rising) score += 9;
      else if(adxv >=25 && adx_rising) score += 6;
      else score -= 8;
    }else{
      if(adxv >= 35 && adx_rising) score += 12; else if(adxv >= 30) score += 9; else if(adxv >=25) score += 6; else if(adxv >=20) score += 3;
    }

    if(higher_high && higher_close) score += 10; else if(consecutive_up) score += 6; else if(latest.Close > prev.Close) score +=3;

    if(rs >= 1.20) score += 8; else if(rs >= 1.10) score +=6; else if(rs >=1.03) score +=4; else if(rs >=0.98) score +=1;

    const rsiVal = latest.RSI;
    if(riskOff){
      if(55 <= rsiVal && rsiVal <= 68) score += 10;
      else if(rsiVal > 68 && rsiVal <= 75) score += 2;
      else if(rsiVal > 75) score -= 8;
      else if(rsiVal < 45) score -= 8;
    }else{
      if(55 <= rsiVal && rsiVal <= 70) score += 15; else if(rsiVal > 70 && rsiVal <= 80) score += 5; else if(rsiVal > 80) score -= 2; else if(rsiVal < 40) score -= 6;
    }

    if(riskOff){
      if(latest.MACD_hist > 0) score += 2;
      else score -= 3;
    }else if(latest.MACD_hist > 0) score += 2; // simplified

    if(!options_ok) score -= 4;

    const entry = latest.Close; const stop = entry - 1.2 * latest.ATR; const target = entry + 2.5 * latest.ATR;
    const risk_reward = (target-entry)/(entry-stop > 0 ? (entry-stop) : 1);

    return {
      symbol,
      score: Math.round(score*10)/10,
      close: Math.round(entry*100)/100,
      pct_from_high: Math.round(pct_from_high*100)/100,
      atr_from_high: Math.round(atr_from_high*100)/100,
      rel_vol_today: Math.round(rel_vol_today*100)/100,
      rel_vol_5d: Math.round(rel_vol_5d*100)/100,
      rsi: Math.round(rsiVal*10)/10,
      adx: Math.round(adxv*10)/10,
      plus_di: Math.round(plus_di*10)/10,
      rs_3m: Math.round(rs*100)/100,
      atr: Math.round(latest.ATR*100)/100,
      stop: Math.round(stop*100)/100,
      target: Math.round(target*100)/100,
      risk_reward: Math.round(risk_reward*100)/100,
      dollar_vol_20d: Math.round(dollarVol),
      options_ok: Boolean(options_ok),
      higher_high: Boolean(higher_high),
      consecutive_up: Boolean(consecutive_up)
    };
  }catch(e){ console.error(`  [!] ${symbol}: ${e.message}`); return null; }
}

async function main(){
  const cfg = readConfig();
  const riskMode = normalizeRiskMode(cfg);
  const tickerStr = cfg.TICKERS// || cfg.TICKERS || '';
  const tickers = tickerStr.split(/\s+/).filter(Boolean);
  if(!tickers.length){ console.error('No tickers in config (TEST or TICKERS)'); process.exit(1); }
  const start = new Date(); start.setDate(start.getDate() - 365);
  const startStr = formatDate(start);
  console.log(`Scoring ${tickers.length} tickers (mode=${riskMode})...`);
  const results = [];
  for(let i=0; i<tickers.length; i++){
    const s = tickers[i];
    process.stdout.write(`[${i+1}/${tickers.length}] ${s}...`);
    const r = await analyze(s, startStr, riskMode);
    if(r){ results.push(r); console.log(` score=${r.score}`); }
    else{ console.log(' skipped'); }
  }
  results.sort((a,b)=>b.score - a.score);
  const top40 = results.slice(0,40);
  const honorableMentions = top40.slice(20,40);
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

main().catch(e=>{ console.error(e); process.exit(1); });
