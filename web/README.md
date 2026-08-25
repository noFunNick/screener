# Momentum Top-20 Web Viewer

Steps to use:

1. Run your Python script that produces the JSON (example):

```bash
python momentum_setups.py
```

Ensure it writes `swing_scan_results.json` (or update `web/script.js` to point to your filename).

2. Serve the project root so the web UI can fetch the JSON. From the project folder run:

```bash
python -m http.server 8000
```

3. Open the viewer in your browser:

http://localhost:8000/web/index.html

Notes:
- The viewer will attempt to load `swing_scan_results.json` (tries a few relative locations). If your JSON has different structure, edit `web/script.js` to pick the appropriate value field.
- This is a static scaffold using Chart.js for simple exploration.

To fetch per-symbol OHLC files (used by the mini charts) using Node and Yahoo Finance:

1. Install Node dependencies from the project root:

```bash
npm install
```

2. Run the fetcher (reads `swing_scan_results.json` or the latest `momentum_results_YYYY-MM-DD.json` and writes `web/data/<SYMBOL>.json`):

```bash
npm run fetch-data
```

The script uses the `yahoo-finance2` package to download recent daily OHLC for each symbol so the mini candlesticks on `index.html` can render yesterday and today.
