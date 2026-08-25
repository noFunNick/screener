async function sma(values, window) {
  const out = Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= window) sum -= values[i - window];
    if (i >= window - 1) out[i] = sum / window;
  }
  return out;
}

async function loadAndRender(){
  const msg = document.getElementById('message');
  try{
    const res = await fetch('./sample_ohlc.json');
    if(!res.ok) throw new Error('fetch failed');
    const data = await res.json();
    msg.textContent = '';

    const dates = data.map(d=>d.date);
    const open = data.map(d=>d.open);
    const high = data.map(d=>d.high);
    const low = data.map(d=>d.low);
    const close = data.map(d=>d.close);
    const volume = data.map(d=>d.volume);

    const sma20 = await sma(close, 20);

    const candlestick = {
      x: dates, open, high, low, close,
      type: 'candlestick', name: 'Price', xaxis: 'x', yaxis: 'y'
    };

    const smaTrace = { x: dates, y: sma20, type: 'scatter', mode: 'lines', name: 'SMA 20', line:{color:'orange'} };

    const volumeTrace = { x: dates, y: volume, type: 'bar', name: 'Volume', marker:{color:'lightgray'}, yaxis:'y2' };

    const layout = {
      grid: {rows:2, columns:1, subplots:[['xy'], ['xy2']], roworder:'top to bottom', heights:[0.75,0.25]},
      xaxis: {rangeslider:{visible:false}},
      yaxis: {title:'Price'},
      yaxis2: {title:'Volume', anchor:'x', overlaying:false},
      legend: {orientation:'h'}
    };

    await Plotly.newPlot('chart', [candlestick, smaTrace, volumeTrace], layout, {responsive:true});
  }catch(e){
    msg.textContent = 'Error loading sample data: ' + e.message;
  }
}

loadAndRender();
