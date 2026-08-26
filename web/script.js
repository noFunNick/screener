(async function(){
  // Build candidate URLs: today + last 5 calendar days + latest.json fallback
  function dateStr(offset){
    const d = new Date(); d.setDate(d.getDate() - offset);
    return d.toISOString().slice(0,10);
  }
  document.getElementById('title').textContent = `Top 20 Momentum Results (${dateStr(0)})`;
  const tryUrls = [];
  for(let i = 0; i <= 5; i++){
    const ds = dateStr(i);
    tryUrls.push(`./momentum_results_${ds}.json`);
    tryUrls.push(`../momentum_results_${ds}.json`);
  }
  tryUrls.push('./latest.json', '../latest.json', './swing_scan_results.json', '../swing_scan_results.json');
  let data = null;
  for(const u of tryUrls){
    try{
      console.log('Attempting to load JSON from', u);
      const res = await fetch(u);
      if(!res.ok) { console.log('Not found:', u, res.status); continue; }
      data = await res.json();
      console.log('Loaded JSON from', u);
      break;
    }catch(e){ console.log('Fetch error for', u, e); }
  }
  const msg = document.getElementById('message');
  if(!data){ msg.textContent = 'Could not load results JSON. Serve the project root (so ../momentum_results_YYYY-MM-DD.json is reachable) and refresh. Check browser console for attempted URLs.'; return; }

  let entries = [];
  if(Array.isArray(data)){
    if(data.length>0 && typeof data[0] === 'object'){
      const sample = data[0];
      const numericKeys = Object.keys(sample).filter(k=> typeof sample[k] === 'number');
      let valueKey = numericKeys.length ? numericKeys[0] : Object.keys(sample).find(k=> /score|momentum|value|rank|signal/i.test(k));
      if(!valueKey){
        for(const k of Object.keys(sample)){
          if(!isNaN(parseFloat(sample[k]))){ valueKey = k; break; }
        }
      }
      const labelKey = Object.keys(sample).find(k=> /symbol|ticker|name/i.test(k)) || Object.keys(sample)[0];
      if(valueKey){
        entries = data.map(item=>({label: item[labelKey] ?? item.symbol ?? '', value: Number(item[valueKey]) || 0, raw: item}));
      }else{
        msg.textContent = 'JSON array found but no numeric value field detected; showing first 20 entries.';
        entries = data.map((item,i)=>({label: item[labelKey] ?? JSON.stringify(item), value:0, raw:item}));
      }
    }else{
      entries = data.map((v,i)=>({label:String(v), value:0}));
    }
  }else if(typeof data === 'object'){
    entries = Object.entries(data).map(([k,v])=>({label:k, value: typeof v === 'number' ? v : (isNaN(parseFloat(v))?0:parseFloat(v)), raw:v}));
  }else{
    msg.textContent = 'Unsupported JSON format.'; return;
  }

  entries.sort((a,b)=>b.value - a.value);
  const top = entries.slice(0,20);
  const mentions = entries.slice(20,40);

  function num(v, digits=2){
    const n = Number(v);
    return Number.isFinite(n) ? n.toFixed(digits) : 'n/a';
  }

  function indicatorChips(raw){
    return `
      <span class="metric-chip">Close: ${num(raw?.close, 2)}</span>
      <span class="metric-chip">RSI: ${num(raw?.rsi, 1)}</span>
      <span class="metric-chip">ADX: ${num(raw?.adx, 1)}</span>
      <span class="metric-chip">RelVol: ${num(raw?.rel_vol_today, 2)}x</span>
      <span class="metric-chip">RelVol5d: ${num(raw?.rel_vol_5d, 2)}x</span>
      <span class="metric-chip">RS(3m): ${num(raw?.rs_3m, 2)}</span>
      <span class="metric-chip">ATR: ${num(raw?.atr, 2)}</span>
      <span class="metric-chip">FromHigh: ${num(raw?.pct_from_high, 2)}%</span>
    `;
  }

  // Fill table (top 20)
//   const tbody = document.getElementById('results-body');
//   top.forEach((e,i)=>{
//     const tr = document.createElement('tr');
//     tr.innerHTML = `<td>${i+1}</td><td>${e.label}</td><td>${e.value}</td>`;
//     tbody.appendChild(tr);
//   });

  // Render main stock chart for the top symbol (or selected)
  const mainChartDiv = document.getElementById('main-chart');
  async function renderMainChart(sym){
    if(!sym){ mainChartDiv.innerHTML = '<p>No symbol selected</p>'; return; }
    msg.textContent = `Loading OHLC for ${sym}...`;
    try{
      const res = await fetch(`./data/${encodeURIComponent(sym)}.json`);
      if(!res.ok){ mainChartDiv.innerHTML = `<p>No OHLC data for ${sym}</p>`; msg.textContent=''; return; }
      const ohlc = await res.json();
      if(!Array.isArray(ohlc) || ohlc.length < 1){ mainChartDiv.innerHTML = `<p>No OHLC data for ${sym}</p>`; msg.textContent=''; return; }
      const dates = ohlc.map(d=>d.date);
      const open = ohlc.map(d=>d.open);
      const high = ohlc.map(d=>d.high);
      const low = ohlc.map(d=>d.low);
      const close = ohlc.map(d=>d.close);
      const volume = ohlc.map(d=>d.volume || 0);

      const candle = { x: dates, open, high, low, close, type: 'candlestick', name: sym };
      const vol = { x: dates, y: volume, type: 'bar', name: 'Volume', marker:{color:'lightgray'}, yaxis:'y2' };
      const layout = { grid:{rows:2, columns:1, roworder:'top to bottom', subplots:[['xy'],['xy2']]}, xaxis:{rangeslider:{visible:false}}, yaxis:{title:'Price'}, yaxis2:{title:'Volume', domain:[0,0.2], anchor:'x', showgrid:false}, height:420, margin:{t:30} };
      await Plotly.react(mainChartDiv, [candle, vol], layout, {displayModeBar:true});
      msg.textContent = '';
    }catch(err){ mainChartDiv.innerHTML = `<p>Error loading ${sym}</p>`; msg.textContent=''; }
  }

  // draw compact candlestick chart using canvas to avoid Plotly overhead/errors
  function drawMiniCandles(container, dataWindow){
    container.innerHTML = '';
    const cvs = document.createElement('canvas');
    const W = 280, H = 120;
    cvs.width = W; cvs.height = H;
    container.appendChild(cvs);
    const ctx = cvs.getContext('2d');
    ctx.clearRect(0,0,W,H);
    ctx.fillStyle = '#fff'; ctx.fillRect(0,0,W,H);
    if(!dataWindow || dataWindow.length===0) return;
    const highs = dataWindow.map(d=>d.high); const lows = dataWindow.map(d=>d.low);
    const max = Math.max(...highs); const min = Math.min(...lows);
    const pad = (max-min)*0.05 || 1;
    const top = max + pad; const bottom = min - pad;
    const plotH = H - 10; const plotW = W - 10; const left = 5; const topPad = 5;
    const n = dataWindow.length;
    const step = plotW / Math.max(n-1,1);
    for(let i=0;i<n;i++){
      const d = dataWindow[i];
      const x = left + i*step;
      const yHigh = topPad + (top - d.high) / (top - bottom) * plotH;
      const yLow  = topPad + (top - d.low)  / (top - bottom) * plotH;
      const yOpen = topPad + (top - d.open) / (top - bottom) * plotH;
      const yClose= topPad + (top - d.close)/ (top - bottom) * plotH;
      // wick
      ctx.strokeStyle = '#999'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x, yHigh); ctx.lineTo(x, yLow); ctx.stroke();
      // body
      const bodyWidth = Math.max(2, step*0.6);
      const bodyX = x - bodyWidth/2;
      const isUp = d.close >= d.open;
      ctx.fillStyle = isUp ? '#0b84ff' : '#ff6b6b';
      const bodyY = Math.min(yOpen, yClose);
      const bodyH = Math.max(1, Math.abs(yClose - yOpen));
      ctx.fillRect(bodyX, bodyY, bodyWidth, bodyH);
      ctx.strokeStyle = '#333'; ctx.strokeRect(bodyX, bodyY, bodyWidth, bodyH);
    }
  }

  // initial main chart uses top result if available
  if(top.length>0) renderMainChart(top[0].label);

  // Cards list (scrollable) showing top details (top 20 or available)
  const cards = document.getElementById('cards');
  const maxScore = entries.length ? entries[0].value : 1;
  // Render cards and mini charts sequentially to avoid overwhelming Plotly
  for (let i = 0; i < top.length; i++) {
    const e = top[i];
    const card = document.createElement('div');
    card.className = 'card';
    const scorePct = maxScore > 0 ? Math.round((e.value / maxScore) * 100) : 0;
    card.innerHTML = `
      <div class="card-header"><div class="rank">#${i+1}</div><div class="symbol"><a href="https://finance.yahoo.com/chart/${encodeURIComponent(e.label)}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">${e.label}</a></div><div class="score">${e.value}</div></div>
      <div class="card-body">
        <div style="display:flex;gap:12px;align-items:center">
          <div class="mini-chart" id="mini-${i}" aria-hidden="true"></div>
          <div style="flex:1">
            <div class="bar-wrap"><div class="bar-fill" style="width:${scorePct}%"></div></div>
            <div class="metrics">${indicatorChips(e.raw || e)}</div>
          </div>
        </div>
      </div>`;
    cards.appendChild(card);
    // click selects symbol and renders main chart
    card.addEventListener('click', ()=>{
      // clear previous selection
      document.querySelectorAll('.card.selected').forEach(c=>c.classList.remove('selected'));
      card.classList.add('selected');
      renderMainChart(e.label);
    });

    // Now fetch and render the mini chart for this card (sequential)
    const miniId = `mini-${i}`;
    const el = document.getElementById(miniId);
    if (!el) continue;
    try {
      const path = `./data/${encodeURIComponent(e.label)}.json`;
      console.log('mini: fetching', path);
      const res = await fetch(path);
      console.log('mini: response', path, res && res.status);
      if(!res.ok) { el.textContent = 'No data'; continue; }
      const ohlc = await res.json();
      if(!Array.isArray(ohlc) || ohlc.length < 1){ el.textContent = 'No data'; continue; }
      const window = ohlc.slice(-90);
      const dates = window.map(d=>d.date);
      const open = window.map(d=>d.open);
      const high = window.map(d=>d.high);
      const low = window.map(d=>d.low);
      const close = window.map(d=>d.close);
      const trace = {
        x: dates,
        open, high, low, close,
        type: 'candlestick',
        increasing: {line:{color:'#0b84ff'}},
        decreasing: {line:{color:'#ff6b6b'}},
        showlegend:false
      };
        // use canvas renderer to avoid Plotly issues for many small charts
        drawMiniCandles(el, window);
        console.log('mini: drawn (canvas)', e.label, miniId);
    } catch(err) {
      console.log('mini: error', e.label, err);
      if(el) el.textContent = 'Err';
    }
    // small delay to keep UI responsive and avoid overloading Plotly
    await new Promise(r => setTimeout(r, 80));
  }

  // Honorable mentions list (next 20 scores) without mini charts
  const mentionsEl = document.getElementById('mentions');
  if(mentionsEl){
    mentionsEl.innerHTML = '';
    for(let i = 0; i < mentions.length; i++){
      const e = mentions[i];
      const rank = i + 21;
      const row = document.createElement('div');
      row.className = 'mention-row';
      row.innerHTML = `
        <div class="mention-head">
          <div class="rank">#${rank}</div>
          <div class="symbol"><a href="https://finance.yahoo.com/chart/${encodeURIComponent(e.label)}" target="_blank" rel="noopener noreferrer">${e.label}</a></div>
          <div class="score">${num(e.value, 1)}</div>
        </div>
        <div class="metrics">${indicatorChips(e.raw || e)}</div>
      `;
      mentionsEl.appendChild(row);
    }
  }

  msg.textContent = '';
})();
