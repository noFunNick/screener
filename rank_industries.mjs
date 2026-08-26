import fs from 'fs/promises';
import path from 'path';
import yahooFinanceModule from 'yahoo-finance2';
import { ADX } from 'technicalindicators';

const rawYahooFinance = yahooFinanceModule.default || yahooFinanceModule;
const yahooFinance = (typeof rawYahooFinance === 'function')
  ? new rawYahooFinance({ suppressNotices: ['ripHistorical', 'yahooSurvey'] })
  : rawYahooFinance;

const root = process.cwd();
const csvPath = path.join(root, 'all_1bn_MarketCap.csv');
const outLatest = path.join(root, 'industry_rankings_latest.json');

function formatDate(d) {
  return d.toISOString().slice(0, 10);
}

function tomorrow() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return formatDate(d);
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

function median(values) {
  if (!values.length) return 0;
  const v = [...values].sort((a, b) => a - b);
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

async function readUniverseFromCsv(filePath) {
  const txt = await fs.readFile(filePath, 'utf8');
  const lines = txt.split(/\r?\n/).filter(Boolean);
  const headers = parseCsvLine(lines[0]);

  const idxSymbol = headers.findIndex(h => /symbol/i.test(h));
  const idxIndustry = headers.findIndex(h => /^industry$/i.test(h.trim()));
  const idxVolume = headers.findIndex(h => /^volume$/i.test(h.trim()));
  if (idxSymbol < 0 || idxIndustry < 0) throw new Error('CSV missing Symbol/Industry columns');

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    const symbolRaw = (cols[idxSymbol] || '').trim();
    const industry = (cols[idxIndustry] || '').trim();
    if (!symbolRaw || !industry) continue;
    const volume = Number((cols[idxVolume] || '0').replace(/,/g, '')) || 0;
    rows.push({
      symbol: normalizeSymbol(symbolRaw),
      symbolRaw,
      industry,
      csvVolume: volume
    });
  }

  const unique = new Map();
  for (const r of rows) {
    if (!unique.has(r.symbol)) unique.set(r.symbol, r);
  }
  return [...unique.values()];
}

async function symbolMetrics(row, period1) {
  try {
    const chartData = await yahooFinance.chart(row.symbol, {
      period1,
      period2: tomorrow(),
      interval: '1d'
    });
    const q = (chartData?.quotes || []).filter(x => x.close != null && x.high != null && x.low != null && x.volume != null);
    if (q.length < 80) return null;

    const high = q.map(x => x.high);
    const low = q.map(x => x.low);
    const close = q.map(x => x.close);
    const volume = q.map(x => x.volume || 0);

    const adxArr = ADX.calculate({ period: 14, high, low, close });
    const adx = adxArr.length ? Number(adxArr[adxArr.length - 1].adx ?? adxArr[adxArr.length - 1]) || 0 : 0;

    const v20 = volume.slice(-20);
    const avg20 = v20.reduce((s, v) => s + v, 0) / Math.max(v20.length, 1);
    const v5 = volume.slice(-5);
    const avg5 = v5.reduce((s, v) => s + v, 0) / Math.max(v5.length, 1);
    const relVolToday = avg20 > 0 ? volume[volume.length - 1] / avg20 : 0;
    const relVol5d = avg20 > 0 ? avg5 / avg20 : 0;

    return {
      symbol: row.symbol,
      industry: row.industry,
      adx,
      rel_vol_today: relVolToday,
      rel_vol_5d: relVol5d,
      trend_ok: adx >= 25 && relVolToday >= 1.2
    };
  } catch {
    return null;
  }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      out[i] = await fn(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return out;
}

async function main() {
  const MAX_SYMBOLS = Number(process.env.MAX_SYMBOLS || 600); // set 0 to scan all
  const CONCURRENCY = Number(process.env.INDUSTRY_CONCURRENCY || 8);
  const MIN_INDUSTRY_COUNT = Number(process.env.MIN_INDUSTRY_COUNT || 4);

  const universe = await readUniverseFromCsv(csvPath);
  const sorted = [...universe].sort((a, b) => b.csvVolume - a.csvVolume);
  const selected = MAX_SYMBOLS > 0 ? sorted.slice(0, MAX_SYMBOLS) : sorted;

  const start = new Date();
  start.setDate(start.getDate() - 220);
  const period1 = formatDate(start);

  console.log(`Ranking industries from ${selected.length} symbols (source rows=${universe.length})...`);
  const metrics = await mapLimit(selected, CONCURRENCY, (row, i) => {
    process.stdout.write(`\r[${i + 1}/${selected.length}] ${row.symbol}   `);
    return symbolMetrics(row, period1);
  });
  process.stdout.write('\n');

  const valid = metrics.filter(Boolean);
  const byIndustry = new Map();
  for (const m of valid) {
    if (!byIndustry.has(m.industry)) byIndustry.set(m.industry, []);
    byIndustry.get(m.industry).push(m);
  }

  const rankings = [];
  for (const [industry, arr] of byIndustry.entries()) {
    if (arr.length < MIN_INDUSTRY_COUNT) continue;
    const adxMed = median(arr.map(x => x.adx));
    const relVolMed = median(arr.map(x => x.rel_vol_today));
    const relVol5Med = median(arr.map(x => x.rel_vol_5d));
    const breadth = arr.filter(x => x.trend_ok).length / arr.length;

    // Composite tuned for momentum continuation leadership.
    const industryScore = (adxMed * 1.2) + (relVolMed * 16) + (relVol5Med * 8) + (breadth * 25);

    rankings.push({
      industry,
      count: arr.length,
      adx_median: Math.round(adxMed * 100) / 100,
      rel_vol_median: Math.round(relVolMed * 100) / 100,
      rel_vol_5d_median: Math.round(relVol5Med * 100) / 100,
      breadth: Math.round(breadth * 1000) / 1000,
      industry_score: Math.round(industryScore * 100) / 100
    });
  }

  rankings.sort((a, b) => b.industry_score - a.industry_score);
  rankings.forEach((r, i) => { r.rank = i + 1; });

  const payload = {
    generated_at: new Date().toISOString(),
    symbols_considered: selected.length,
    symbols_with_metrics: valid.length,
    min_industry_count: MIN_INDUSTRY_COUNT,
    top_industries: rankings.slice(0, 20).map(r => r.industry),
    rankings
  };

  const dated = path.join(root, `industry_rankings_${formatDate(new Date())}.json`);
  await fs.writeFile(dated, JSON.stringify(payload, null, 2), 'utf8');
  await fs.writeFile(outLatest, JSON.stringify(payload, null, 2), 'utf8');

  console.log(`Wrote ${dated}`);
  console.log(`Wrote ${outLatest}`);
  console.log(`Top 10 industries: ${payload.top_industries.slice(0, 10).join(' | ')}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
