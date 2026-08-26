import fs from 'fs/promises';
import path from 'path';
import * as yfModule from 'yahoo-finance2';
const yahooFinance = yfModule.default || yfModule;
const YahooFinance = yfModule.YahooFinance || (yfModule.default && yfModule.default.YahooFinance) || null;

const root = process.cwd();
const dataDir = path.join(root, 'web', 'data');
await fs.mkdir(dataDir, { recursive: true });
async function deleteExistingJSONFiles(){
  const files = await fs.readdir(dataDir);
    for(const f of files){
        if(f.endsWith('.json')){
            await fs.unlink(path.join(dataDir, f));
        }
    }
}
// Delete existing JSON files in the data directory before fetching new data
await deleteExistingJSONFiles();
async function findResultsFile(){
  const candidates = [path.join(root, 'swing_scan_results.json')];
  for(const c of candidates){
    try{ await fs.access(c); return c; }catch(e){}
  }
  // fallback: pick latest momentum_results_*.json
  const files = await fs.readdir(root);
  const matches = files.filter(f=>/^momentum_results_\d{4}-\d{2}-\d{2}\.json$/.test(f));
  if(matches.length===0) return null;
  matches.sort();
  return path.join(root, matches[matches.length-1]);
}

function formatDate(d){ return d.toISOString().slice(0,10); }

function filenameForSymbol(sym){ return encodeURIComponent(sym) + '.json'; }

const resultsFile = await findResultsFile();
if(!resultsFile){
  console.error('No results JSON found. Create swing_scan_results.json or momentum_results_YYYY-MM-DD.json in project root.');
  process.exit(1);
}

const raw = await fs.readFile(resultsFile, 'utf8');
const arr = JSON.parse(raw);
const symbols = Array.from(new Set((arr||[]).map(r=> (r.symbol||r.ticker||r.label||'').toString()).filter(Boolean)));
if(symbols.length===0){ console.error('No symbols found in results file.'); process.exit(1); }

console.log(`Found ${symbols.length} symbols — fetching 3 days of daily OHLC for each`);

const today = new Date();
const from = new Date(today);
// fetch ~90 days of daily history so main stock charts have context
from.setDate(from.getDate() - 90);
const period1 = formatDate(from);
// Yahoo chart endpoints treat period2 as exclusive, so use tomorrow to include today's bar.
const period2 = formatDate(new Date(today.getTime() + 24 * 60 * 60 * 1000));

// Support v2 (functional API) and v3 (class-based) shapes of yahoo-finance2
let yfClient = null;
let useFunctional = false;
try{
  if (typeof YahooFinance === 'function') {
    // named class export
    yfClient = new YahooFinance();
  } else if (typeof yahooFinance === 'function') {
    // default export may be a class or a function
    if (yahooFinance.prototype && typeof yahooFinance.prototype.historical === 'function') {
      // default is a class
      yfClient = new yahooFinance();
    } else {
      // functional API (v2) — use the function directly
      useFunctional = true;
    }
  }
}catch(e){
  useFunctional = true;
}

for(const sym of symbols){
  try{
    console.log('Fetching', sym);
    const opts = { period1, period2, interval: '1d' };
    // call historical via whichever API shape we detected
    let hist;
    if (yfClient && typeof yfClient.historical === 'function') {
      hist = await yfClient.historical(sym, opts);
    } else if (useFunctional && typeof yahooFinance === 'function') {
      // v2 style: functional API exposes historical as method or callable
      if (typeof yahooFinance.historical === 'function') {
        hist = await yahooFinance.historical(sym, opts);
      } else {
        // some builds accept (symbol, opts) directly
        hist = await yahooFinance(sym, opts);
      }
    } else if (typeof yahooFinance === 'function') {
      // fallback: try both patterns
      try {
        hist = await yahooFinance.historical(sym, opts);
      } catch (e) {
        hist = await yahooFinance(sym, opts);
      }
    } else {
      throw new Error('yahoo-finance2 API not available');
    }
    if(!Array.isArray(hist) || hist.length===0){
      console.warn('No history for', sym);
      continue;
    }
    const out = hist.map(h=>({ date: formatDate(new Date(h.date)), open: h.open, high: h.high, low: h.low, close: h.close, volume: h.volume }));
    const fname = path.join(dataDir, filenameForSymbol(sym));
    await fs.writeFile(fname, JSON.stringify(out, null, 2), 'utf8');
    console.log('Wrote', fname);
    // small pause to avoid hammering the API
    await new Promise(r => setTimeout(r, 200));
  }catch(err){
    console.error('Error for', sym, err && err.message ? err.message : err);
  }
}

console.log('Done. Serve the site and open web/index.html to view mini charts.');
