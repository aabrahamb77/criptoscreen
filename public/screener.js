/* public/screener.js
 * Tabla del screener: helpers de formato, celdas, filtros, alertas,
 * barra/WS de liquidaciones, LXR, render() y scoreSymbol().
 * Requiere core.js (estado global) cargado antes.
 */

// ── Helpers ────────────────────────────────────────────────────────────────
function pctStyle(v) {
  if (v == null) return null;
  const a = Math.abs(v);
  if (v >= 0) {
    if (a >= 100) return { bg: '#00dd90', text: '#002010', fw: '800' };
    if (a >= 50)  return { bg: '#00bb78', text: '#001810', fw: '700' };
    if (a >= 20)  return { bg: '#009860', text: '#ccffee', fw: '600' };
    if (a >= 10)  return { bg: '#007848', text: '#aaeedd', fw: '600' };
    if (a >= 5)   return { bg: '#005638', text: '#88ddbb', fw: '500' };
    if (a >= 2)   return { bg: '#003a26', text: '#66bb99', fw: '500' };
    if (a >= 0.5) return { bg: '#002518', text: '#4a9e78', fw: '500' };
    return { bg: 'transparent', text: '#2e5040', fw: '400' };
  } else {
    if (a >= 100) return { bg: '#ff2244', text: '#fff', fw: '800' };
    if (a >= 50)  return { bg: '#dd2233', text: '#fff', fw: '700' };
    if (a >= 20)  return { bg: '#b01c1c', text: '#ffcccc', fw: '600' };
    if (a >= 10)  return { bg: '#841212', text: '#ffbbbb', fw: '600' };
    if (a >= 5)   return { bg: '#580a0a', text: '#ee9999', fw: '500' };
    if (a >= 2)   return { bg: '#380606', text: '#cc7070', fw: '500' };
    if (a >= 0.5) return { bg: '#240404', text: '#aa5858', fw: '500' };
    return { bg: 'transparent', text: '#4a2828', fw: '400' };
  }
}

function fmtPct(v) {
  if (v == null) return null;
  const sign = v >= 0 ? '+' : '';
  const digits = Math.abs(v) >= 100 ? 1 : 2;
  return `${sign}${v.toFixed(digits)}%`;
}

function fmtPrice(p) {
  if (p >= 10000) return '$' + p.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (p >= 1000)  return '$' + p.toLocaleString('en-US', { maximumFractionDigits: 1 });
  if (p >= 100)   return '$' + p.toFixed(2);
  if (p >= 1)     return '$' + p.toFixed(4);
  if (p >= 0.01)  return '$' + p.toFixed(5);
  if (p >= 0.001) return '$' + p.toFixed(6);
  return '$' + p.toFixed(8);
}

function symColor(sym) {
  let h = 5381;
  for (let i = 0; i < sym.length; i++) h = ((h << 5) + h) ^ sym.charCodeAt(i);
  return `hsl(${Math.abs(h) % 360},55%,42%)`;
}

// ── OI formatter ──────────────────────────────────────────────────────────
function fmtOI(v) {
  if (!v) return '—';
  if (v >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
  if (v >= 1e6) return '$' + (v / 1e6).toFixed(0) + 'M';
  return '$' + (v / 1e3).toFixed(0) + 'K';
}

// ── Market sentiment ───────────────────────────────────────────────────────
function updateMarketSentiment(rows) {
  const el = document.getElementById('market-bias');
  if (!el) return;
  const valid = rows.filter(r => r.oi1h != null && r.price1hPct != null);
  if (!valid.length) return;

  const longQ   = valid.filter(r => r.oi1h >= 0 && r.price1hPct >= 0).length;
  const shortQ  = valid.filter(r => r.oi1h >= 0 && r.price1hPct <  0).length;
  const squeeze = valid.filter(r => r.oi1h <  0 && r.price1hPct >= 0).length;
  const liq     = valid.filter(r => r.oi1h <  0 && r.price1hPct <  0).length;

  const bull = longQ + squeeze;
  const bear = shortQ + liq;
  const total = bull + bear;
  const bullPct = Math.round((bull / total) * 100);
  const neutral = Math.abs(bull - bear) <= total * 0.06;
  const isBull  = !neutral && bull > bear;
  const isBear  = !neutral && bear > bull;

  const color = neutral ? '#4a5870' : isBull ? '#00a060' : '#cc2828';
  const label = neutral ? '◆ NEUTRAL' : isBull ? '▲ ALCISTA' : '▼ BAJISTA';
  const pct   = isBull ? bullPct : 100 - bullPct;

  el.innerHTML = `
    <span class="bias-tag" style="background:${color}20;color:${color};border:1px solid ${color}50">${label}</span>
    <div class="bias-bar-wrap"><div class="bias-bar-fill" style="width:${isBull||neutral?bullPct:100-bullPct}%;background:${color}"></div></div>
    <span class="bias-counts">
      <span style="color:#55dd99">▲ ${bull}</span>
      <span style="color:rgba(255,255,255,0.35)"> vs </span>
      <span style="color:#ee6666">▼ ${bear}</span>
      <span style="color:rgba(255,255,255,0.45)"> · ${pct}%</span>
    </span>
    <span class="bias-detail">LONG ${longQ} · SQUEEZE ${squeeze} · SHORT ${shortQ} · LIQ ${liq}</span>`;
}

// ── Funding cell ──────────────────────────────────────────────────────────
function fundingCell(v) {
  if (v == null) return `<div class="pct-wrap"><span class="pct-val null-val">—</span></div>`;
  const str = (v >= 0 ? '+' : '') + v.toFixed(4) + '%';
  let bg, text;
  if      (v > 0.05)  { bg = '#3a2000'; text = '#e09030'; }
  else if (v > 0.01)  { bg = '#281800'; text = '#c07820'; }
  else if (v >= 0)    { bg = '#181000'; text = '#705030'; }
  else if (v > -0.01) { bg = '#001020'; text = '#305a70'; }
  else if (v > -0.05) { bg = '#001828'; text = '#3090c0'; }
  else                { bg = '#001e32'; text = '#40a8e0'; }
  return `<div class="pct-wrap"><span class="pct-val" style="background:${bg};color:${text};font-weight:500">${str}</span></div>`;
}

// ── Bubble tooltip ─────────────────────────────────────────────────────────
function buildTooltip(r) {
  const f  = v => v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
  const fc = v => v == null ? '#3a4a60' : v >= 0 ? '#55bb88' : '#ee6666';
  const fr = r.fundingRate;
  const frStr = fr == null ? '—' : (fr >= 0 ? '+' : '') + fr.toFixed(4) + '%';
  const frC = fr == null ? '#3a4a60' : fr > 0.01 ? '#e09030' : fr < -0.01 ? '#3090d0' : '#4a5a70';
  const delta = (r.oi5m != null && r.oi15m != null) ? r.oi5m - r.oi15m / 3 : null;
  const deltaStr = delta == null ? '—' : delta > 0.05 ? '▲ acelerando' : delta < -0.05 ? '▼ desacelerando' : '→ estable';
  const deltaC = delta == null ? '#3a4a60' : delta > 0.05 ? '#55bb88' : delta < -0.05 ? '#ee6666' : '#4a5870';
  const cvdStr = r.cvd5m == null ? '—' : (r.cvd5m >= 0 ? '+' : '−') + fmtUSD(Math.abs(r.cvd5m));
  const cvdC   = r.cvd5m == null ? '#3a4a60' : r.cvd5m >= 0 ? '#55bb88' : '#ee6666';
  const atrStr = r.moveAtr1h == null ? '—' : (r.moveAtr1h >= 0 ? '+' : '') + r.moveAtr1h.toFixed(1) + '×';
  const atrC   = r.moveAtr1h == null ? '#3a4a60' : Math.abs(r.moveAtr1h) >= 1 ? (r.moveAtr1h >= 0 ? '#55bb88' : '#ee6666') : '#4a5870';
  const lq = liqSumCache.get(r.symbol);
  const lqTot = lq ? lq.l + lq.s : 0;
  const lqStr = lqTot > 0 ? `${lq.s >= lq.l ? '↑S' : '↓L'} ${fmtUSD(lqTot)}` : '—';
  const lqC   = lqTot > 0 ? (lq.s >= lq.l ? '#55bb88' : '#ee6666') : '#3a4a60';
  return `<div class="btip-sym">${r.symbol} <span style="color:#3a4a60;font-weight:400;font-size:10px">${fmtPrice(r.price)}</span></div>
    <div class="btip-row"><span class="btip-lbl">OI total</span><span class="btip-val" style="color:#6080a0">${fmtOI(r.oiUSD)}</span></div>
    <div class="btip-row"><span class="btip-lbl">OI  1h</span><span class="btip-val" style="color:${fc(r.oi1h)}">${f(r.oi1h)}</span></div>
    <div class="btip-row"><span class="btip-lbl">OI  4h</span><span class="btip-val" style="color:${fc(r.oi4h)}">${f(r.oi4h)}</span></div>
    <div class="btip-row"><span class="btip-lbl">OI delta</span><span class="btip-val" style="color:${deltaC}">${deltaStr}</span></div>
    <div class="btip-row"><span class="btip-lbl">Vol 1h</span><span class="btip-val" style="color:${fc(r.vol1hPct)}">${f(r.vol1hPct)}</span></div>
    <div class="btip-row"><span class="btip-lbl">P   1h</span><span class="btip-val" style="color:${fc(r.price1hPct)}">${f(r.price1hPct)}</span></div>
    <div class="btip-row"><span class="btip-lbl">P   4h</span><span class="btip-val" style="color:${fc(r.price4hPct)}">${f(r.price4hPct)}</span></div>
    <div class="btip-row"><span class="btip-lbl">×ATR 1h</span><span class="btip-val" style="color:${atrC}">${atrStr}</span></div>
    <div class="btip-row"><span class="btip-lbl">CVD 5m</span><span class="btip-val" style="color:${cvdC}">${cvdStr}</span></div>
    <div class="btip-row"><span class="btip-lbl">⚡ Liq 5m</span><span class="btip-val" style="color:${lqC}">${lqStr}</span></div>
    <div class="btip-row"><span class="btip-lbl">ρ BTC</span><span class="btip-val" style="color:${r.btcCorr == null ? '#3a4a60' : r.btcCorr >= 0.6 ? '#7a9ad0' : r.btcCorr > -0.3 ? '#55bb88' : '#bb96ee'}">${r.btcCorr == null ? '—' : r.btcCorr.toFixed(2)}</span></div>
    <div class="btip-row"><span class="btip-lbl">Liquidez</span><span class="btip-val" style="color:#6080a0">${fmtOI(r.turnover24h)}/24h</span></div>
    <div class="btip-row"><span class="btip-lbl">Funding</span><span class="btip-val" style="color:${frC}">${frStr}</span></div>
    ${getQuadrantHistory(r.symbol) ? `<div style="margin-top:6px;border-top:1px solid #141c28;padding-top:5px"><span style="color:#2a3848;font-size:9px;margin-right:4px">Historial:</span>${getQuadrantHistory(r.symbol)}</div>` : ''}`;
}

// ── Quadrant change detection ──────────────────────────────────────────────
// ── Alertas sonoras ────────────────────────────────────────────────────────
function beep(freq = 880, type = 'sine', dur = 130) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.type = type; osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.10, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur/1000);
    osc.start(); osc.stop(ctx.currentTime + dur/1000);
  } catch(_) {}
}
function toggleSound() {
  soundEnabled = !soundEnabled;
  const btn = document.getElementById('sound-btn');
  btn.textContent = soundEnabled ? '🔔' : '🔕';
  btn.title = soundEnabled ? 'Alertas sonoras ON' : 'Alertas sonoras OFF';
  btn.classList.toggle('snd-on', soundEnabled);
  if (soundEnabled) beep(880, 'sine', 80);
}

// ── Panel de configuración de alertas (botón ⚙️ del header) ─────────────────
function toggleAlertCfg() {
  const panel = document.getElementById('alert-cfg-panel');
  if (!panel) return;
  const open = panel.style.display !== 'none';
  panel.style.display = open ? 'none' : 'block';
  if (!open) renderAlertCfg();
}

function renderAlertCfg() {
  const panel = document.getElementById('alert-cfg-panel');
  if (!panel) return;
  const rows = Object.keys(ALERT_DEFAULTS).map(cat => `
    <label class="acfg-row">
      <input type="checkbox" ${canAlert(cat) ? 'checked' : ''}
        onchange="setAlertCfg('${cat}', this.checked)">
      <span>${ALERT_LABELS[cat] || cat}</span>
    </label>`).join('');
  panel.innerHTML = `
    <div class="acfg-head">⚙️ Alertas — qué puede avisarte
      <button class="dt-close" onclick="toggleAlertCfg()" style="margin-left:auto">✕</button>
    </div>
    ${rows}
    <div class="acfg-note">El toast, el sonido (🔔) y la notificación de escritorio (🖥) de cada categoría se activan o silencian juntos. Los cambios se guardan solos.</div>`;
}

function showToast(msg, type = '') {
  const wrap = document.getElementById('toast-wrap');
  if (!wrap) return;
  const el = document.createElement('div');
  el.className = 'toast' + (type === 'long' ? ' t-long' : type === 'short' ? ' t-short' : '');
  el.textContent = msg;
  wrap.appendChild(el);
  // 10s en pantalla (antes 3.5s: sonaba y desaparecía sin tiempo de leerlo).
  // Clic en el toast lo cierra al instante.
  el.style.cursor = 'pointer';
  el.onclick = () => { el.style.opacity = '0'; setTimeout(() => el.remove(), 320); };
  setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 320); }, 10_000);
}

// ── Filtro cuadrante ───────────────────────────────────────────────────────
function toggleQuadFilter(quad) {
  activeQuadrant = activeQuadrant === quad ? null : quad;
  document.querySelectorAll('.quad-flt-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.quad === activeQuadrant)
  );
  render();
  if (activeTab === 'screener') drawBubbleChart(null);
}

// ── Score cell ─────────────────────────────────────────────────────────────
function scoreCell(row) {
  const sc = scoreSymbol(row);
  const isLong = sc.longScore >= sc.shortScore;
  const score  = Math.max(sc.longScore, sc.shortScore);
  if (score < 2) return `<div style="display:flex;align-items:center;justify-content:center;height:100%"><span style="color:#283040;font-size:10px">—</span></div>`;

  // Momentum arrow — lee del snapshot del ciclo anterior
  const prev = scoreSnap.get(row.symbol);
  let arrow = '';
  if (prev !== undefined) {
    if (score > prev.score)      arrow = `<span style="font-size:8px;opacity:0.85;margin-left:1px">↑</span>`;
    else if (score < prev.score) arrow = `<span style="font-size:8px;opacity:0.5;margin-left:1px">↓</span>`;
  }

  // Score age
  const seen = scoreFirstSeen.get(row.symbol);
  let ageHtml = '';
  if (seen) {
    const ageMin = Math.floor((Date.now() - seen.ts) / 60_000);
    if (ageMin < 120) ageHtml = `<div style="font-size:8px;opacity:0.45;margin-top:1px;line-height:1">${ageMin}m</div>`;
  }

  const t = Math.min(score / 10, 1);
  const bg = isLong
    ? `rgba(0,${Math.round(70+t*130)},${Math.round(40+t*80)},0.85)`
    : `rgba(${Math.round(80+t*140)},${Math.round(t*20)},0,0.85)`;
  const tc = isLong ? '#aaffdd' : '#ffaaaa';
  // Tooltip con el desglose: POR QUÉ puntúa lo que puntúa
  const parts = isLong ? sc.partsL : sc.partsS;
  const tip = parts && parts.length
    ? `${isLong ? 'LONG' : 'SHORT'} ${score}/10&#10;${parts.join('&#10;')}`
    : '';
  return `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:0">
    <span class="score-pill" style="background:${bg};color:${tc}" title="${tip}">${isLong?'L':'S'}${score}${arrow}</span>
    ${ageHtml}
  </div>`;
}

// ── Tamaño de burbuja configurable ─────────────────────────────────────────
function setBubbleSizeMetric(m) {
  bubbleSizeMetric = m;
  document.querySelectorAll('.bubble-size-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.metric === m)
  );
  drawBubbleChart(null);
}

function checkQuadrantChanges(rows) {
  const nv = v => v ?? 0;
  for (const r of rows) {
    if (r.oi1h == null || r.price1hPct == null) continue;
    const q = r.oi1h >= 0 && r.price1hPct >= 0 ? 'LONG'
            : r.oi1h >= 0                        ? 'SHORT'
            : r.price1hPct >= 0                  ? 'SQUEEZE' : 'LIQ';
    const prev = prevQuadrants.get(r.symbol);
    if (prev && prev !== q) {
      const hist = quadrantHistory.get(r.symbol) || [];
      hist.unshift({ q, ts: Date.now() });
      if (hist.length > 8) hist.length = 8;
      quadrantHistory.set(r.symbol, hist);

    }
    prevQuadrants.set(r.symbol, q);

    // Detectar alineación total → alerta sonora
    const oiPos = r.oi1h >= 0, pricePos = r.price1hPct >= 0;
    const longAl  = oiPos && pricePos
      && nv(r.oi5m) > 0 && nv(r.oi1h) > 0.2 && nv(r.oi4h) > 0
      && nv(r.price5mPct) > 0 && nv(r.price4hPct) > 0 && nv(r.vol1hPct) > 5;
    const shortAl = oiPos && !pricePos
      && nv(r.oi5m) > 0 && nv(r.oi1h) > 0.2 && nv(r.oi4h) > 0
      && nv(r.price5mPct) < 0 && nv(r.price4hPct) < 0 && nv(r.vol1hPct) > 5;
    const isAl = longAl || shortAl;
    if (canAlert('align') && isAl && !prevAligned.has(r.symbol) && soundEnabled && prev) {
      beep(longAl ? 880 : 440, 'sine', 130);
    }
    if (isAl) prevAligned.add(r.symbol); else prevAligned.delete(r.symbol);
  }
}

// ── Filter helpers ─────────────────────────────────────────────────────────
function toggleFavFilter() {
  filterFavOnly = !filterFavOnly;
  document.getElementById('btn-favs').classList.toggle('active', filterFavOnly);
  render();
}

function setScoreFilter(v) {
  scoreFilter = v;
  document.querySelectorAll('.score-flt-btn').forEach(b => b.classList.remove('active'));
  document.getElementById(`sf-${v}`)?.classList.add('active');
  render();
}

// ── Presets de oportunidad: una hipótesis de trade en un clic ──────────────
let activePreset = null;
const PRESETS = {
  squeeze: r => (r.oi1h ?? 0) < -0.2 && (r.price1hPct ?? 0) > 0.3 && (r.vol1hPct ?? 0) > 10,
  cont:    r => (r.oi5m ?? 0) > 0 && (r.oi1h ?? 0) > 0.3 && (r.oi4h ?? 0) > 0
             && (r.price1hPct ?? 0) > 0 && (r.price4hPct ?? 0) > 0,
  capit:   r => (r.oi1h ?? 0) < -0.5 && (r.price1hPct ?? 0) < -1,
};
function setPreset(p) {
  activePreset = activePreset === p ? null : p;
  document.querySelectorAll('.preset-btn').forEach(b =>
    b.classList.toggle('active', b.id === 'preset-' + activePreset));
  render();
}

function getFilteredRows() {
  const search = (document.getElementById('filter-search')?.value || '').toUpperCase();
  const minOI  = parseFloat(document.getElementById('filter-oi')?.value || 0);
  return allRows.filter(r => {
    if (search && !r.symbol.includes(search)) return false;
    if (filterFavOnly && !favorites.has(r.symbol)) return false;
    if (minOI > 0 && (r.oi5m ?? -Infinity) < minOI) return false;
    if (activePreset && !PRESETS[activePreset](r)) return false;
    if (activeQuadrant) {
      const oiPos = (r.oi1h ?? 0) >= 0, pricePos = (r.price1hPct ?? 0) >= 0;
      const quad = oiPos && pricePos ? 'LONG' : oiPos ? 'SHORT' : pricePos ? 'SQUEEZE' : 'LIQ';
      if (quad !== activeQuadrant) return false;
    }
    if (scoreFilter > 0) {
      const sc = scoreSymbol(r);
      if (Math.max(sc.longScore, sc.shortScore) < scoreFilter) return false;
    }
    return true;
  });
}

// ── Liquidaciones WebSocket ─────────────────────────────────────────────────
function fmtUSD(v) {
  if (v >= 1e6) return '$' + (v/1e6).toFixed(1) + 'M';
  if (v >= 1e3) return '$' + (v/1e3).toFixed(0) + 'K';
  return '$' + v.toFixed(0);
}

function setLiqDot(state) {
  const el = document.getElementById('liq-ws-dot');
  if (!el) return;
  if (state === 'ok')   { el.style.color = '#00c878'; el.title = 'WS conectado'; }
  else if (state === 'err') { el.style.color = '#ff5555'; el.title = 'WS error — reconectando'; }
  else                  { el.style.color = '#555';    el.title = 'WS conectando...'; }
}

function updateLiqBar() {
  const now = Date.now();
  const cut5m  = now - 5*60_000;
  const cut30m = now - 30*60_000;
  const rec = liqEvents.filter(e => e.ts > cut5m);
  liqLong5m  = rec.filter(e =>  e.isLong).reduce((a,b) => a+b.usdVal, 0);
  liqShort5m = rec.filter(e => !e.isLong).reduce((a,b) => a+b.usdVal, 0);
  document.getElementById('liq-long-total').textContent  = 'L ' + fmtUSD(liqLong5m);
  document.getElementById('liq-short-total').textContent = 'S ' + fmtUSD(liqShort5m);

  // Agrupar por símbolo (últimos 30 min) y mostrar top 12
  const symMap = new Map();
  for (const e of liqEvents) {
    if (e.ts < cut30m) continue;
    if (!symMap.has(e.symbol)) symMap.set(e.symbol, { l: 0, s: 0 });
    const t = symMap.get(e.symbol);
    if (e.isLong) t.l += e.usdVal; else t.s += e.usdVal;
  }
  const top = [...symMap.entries()]
    .map(([sym, t]) => ({ sym, total: t.l + t.s, isLong: t.l >= t.s }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 12);

  const feed = top.map(x =>
    `<span class="liq-ev ${x.isLong?'ll':'ls'}">${x.sym} ${x.isLong?'↓L':'↑S'} ${fmtUSD(x.total)}</span>`
  ).join('');
  document.getElementById('liq-feed').innerHTML = feed || '<span style="color:rgba(255,255,255,0.3)">Sin liquidaciones recientes</span>';
}

// ── Tickers en tiempo real (WS) ─────────────────────────────────────────────
// Cache símbolo → { price, fundingRate, oiUSD, ts, prevPrice }. Se alimenta del
// mismo WebSocket de liquidaciones/trades (topics tickers.*) y elimina la espera
// de hasta 10s del ciclo REST para precio, funding y OI total.
const wsTickers = new Map();

function handleTickerMsg(msg) {
  const d = Array.isArray(msg.data) ? msg.data[0] : msg.data;
  if (!d) return;
  const sym = msg.topic.slice('tickers.'.length).replace('USDT', '');
  let t = wsTickers.get(sym);
  if (!t) { t = {}; wsTickers.set(sym, t); }
  // Los mensajes delta solo traen los campos que cambiaron — merge, no replace
  if (d.lastPrice !== undefined && d.lastPrice !== '')          { t.prevPrice = t.price; t.price = +d.lastPrice; }
  if (d.fundingRate !== undefined && d.fundingRate !== '')      t.fundingRate = +d.fundingRate * 100;
  if (d.openInterestValue !== undefined && d.openInterestValue !== '') t.oiUSD = +d.openInterestValue;
  t.ts = Date.now();
}

// Vuelca el cache WS sobre allRows y parchea las celdas de precio visibles.
// Se llama 1×/segundo desde tick() — mucho más ligero que re-render completo.
function applyLiveTickers() {
  if (!allRows.length || !wsTickers.size) return;
  const stale = Date.now() - 15_000; // ignora datos WS viejos (desconexión)
  for (const r of allRows) {
    const t = wsTickers.get(r.symbol);
    if (!t || !t.ts || t.ts < stale) continue;
    if (t.fundingRate != null) r.fundingRate = t.fundingRate;
    if (t.oiUSD != null)       r.oiUSD = t.oiUSD;
    if (t.price == null || t.price === r.price) continue;
    const up = t.price > r.price;
    r.price = t.price;
    const cell = document.querySelector(`#tbody tr[data-sym="${r.symbol}"] .price-cell span:last-child`);
    if (cell) {
      cell.textContent = fmtPrice(t.price);
      cell.classList.remove('tick-up', 'tick-dn');
      void cell.offsetWidth; // reinicia la animación CSS
      cell.classList.add(up ? 'tick-up' : 'tick-dn');
    }
  }
}

function connectLiqWS(symbols) {
  // Suscribirse a TODOS los pares del screener (antes solo top-50 por turnover:
  // la tabla ordenada por OI mostraba pares sin suscripción → CVD siempre $0).
  // tickers.* añade precio/funding/OI en tiempo real sobre la misma conexión.
  const allTopics = symbols.flatMap(s => [`allLiquidation.${s}USDT`, `publicTrade.${s}USDT`, `tickers.${s}USDT`]);
  const chunks = [];
  for (let i = 0; i < allTopics.length; i += 10) chunks.push(allTopics.slice(i, i + 10));

  let ws, pingTimer;
  let wsMsgCount = 0;

  function connect() {
    wsMsgCount = 0;
    setLiqDot('connecting');
    clearInterval(pingTimer);
    try { ws && ws.close(); } catch(_) {}

    ws = new WebSocket('wss://stream.bybit.com/v5/public/linear');

    ws.onopen = () => {
      setLiqDot('ok');
      for (const chunk of chunks) {
        ws.send(JSON.stringify({ op: 'subscribe', args: chunk }));
      }
      pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op: 'ping' }));
      }, 20_000);
      updateLiqBar();
    };

    ws.onmessage = e => {
      try {
        wsMsgCount++;
        const dot = document.getElementById('liq-ws-dot');
        if (dot) dot.title = `WS activo · ${wsMsgCount} msgs recibidos`;

        const msg = JSON.parse(e.data);
        if (!msg.topic || !msg.data) return;

        // --- tickers en tiempo real (precio/funding/OI) ---
        if (msg.topic.startsWith('tickers.')) {
          handleTickerMsg(msg);
          return;
        }

        // --- order flow para CVD ---
        if (msg.topic.startsWith('publicTrade.')) {
          const sym = msg.topic.split('.')[1].replace('USDT','');
          for (const t of msg.data) LXR.CVD.push(sym, +t.T, t.S, +t.v, +t.p);
          return;
        }

        // --- liquidaciones reales ---
        if (msg.topic.startsWith('allLiquidation.')) {
          const list = Array.isArray(msg.data) ? msg.data : [msg.data];
          for (const d of list) {
            const usdVal = (+d.v) * (+d.p);
            if (!usdVal || isNaN(usdVal)) continue;
            const sym = (d.s || '').replace('USDT','');
            liqEvents.unshift({
              symbol: sym,
              // Bybit: S='Sell' => largo liquidado; S='Buy' => corto liquidado
              isLong: d.S === 'Sell',
              usdVal, ts: +d.T,
            });
            // Cascada grande: dispara evaluación LXR (reversión) para ese símbolo
            if (usdVal > 50_000) evalLXR(sym);
          }
          if (liqEvents.length > 300) liqEvents.length = 300;
          updateLiqBar();
          return;
        }
      } catch(_) {}
    };

    ws.onclose = () => {
      setLiqDot('err');
      clearInterval(pingTimer);
      setTimeout(connect, 5000);
    };
    ws.onerror = () => { setLiqDot('err'); };
  }

  connect();
}

// ── LXR (Liquidation Exhaustion Reversal) ──────────────────────────────────
// Estrategia de reversión: solo tiene sentido evaluarla justo tras una cascada
// de liquidaciones grande (ver disparador en ws.onmessage → allLiquidation).
// Necesita velas de 1 minuto, que el screener normal no pide.
let lxrSignals = []; // { ...sig, ts } más reciente primero
const LXR_SIG_MAX = 20;

async function evalLXR(symbolNoUSDT) {
  const symbol = symbolNoUSDT + 'USDT';
  const now = Date.now();
  const [kRes, oiRes, fundRes] = await Promise.all([
    bybitGet(`/v5/market/kline?category=linear&symbol=${symbol}&interval=1&limit=60`),
    bybitGet(`/v5/market/open-interest?category=linear&symbol=${symbol}&intervalTime=5min&limit=10`),
    bybitGet(`/v5/market/funding/history?category=linear&symbol=${symbol}&limit=60`),
  ]);
  const klines = (kRes.result?.list||[]).slice().reverse()
    .map(k => ({ high:+k[2], low:+k[3], close:+k[4], volume:+k[5] }));
  const oiSeries = (oiRes.result?.list||[]).map(x => ({ oi:+x.openInterest })).reverse();
  const fundingHist = (fundRes.result?.list||[]).slice().reverse().map(x => +x.fundingRate);
  const currentFunding = fundingHist.length ? fundingHist[fundingHist.length - 1] : 0;

  const sig = LXR.evaluate({
    symbol: symbolNoUSDT, klines, oiSeries,
    fundingHist, currentFunding,
    trades: LXR.CVD.get(symbolNoUSDT),
    liqs: LXR.liqEventsToInput(liqEvents, symbolNoUSDT),
    nowMs: now,
  });
  if (sig) renderLXRCard(sig);
  return sig;
}

function renderLXRCard(sig) {
  lxrSignals.unshift({ ...sig, ts: Date.now() });
  if (lxrSignals.length > LXR_SIG_MAX) lxrSignals.length = LXR_SIG_MAX;
  const list = document.getElementById('lxr-list');
  if (!list) return;
  list.innerHTML = lxrSignals.map(s => {
    const isLong = s.side === 'long';
    const time = new Date(s.ts).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
    return `<div class="lxr-card ${isLong ? 'lxr-long' : 'lxr-short'}">
      <div class="lxr-head">
        <span class="lxr-sym">${s.symbol}</span>
        <span class="lxr-side">${isLong ? '▲ LONG' : '▼ SHORT'}</span>
        <span class="lxr-score">⚡${s.score}</span>
        <span class="lxr-ts">${time}</span>
      </div>
      <div class="lxr-levels">
        <span>Entrada <b>${fmtPrice(s.price)}</b></span>
        <span>Stop <b>${fmtPrice(s.stop)}</b></span>
        <span>TP <b>${fmtPrice(s.takeProfit)}</b></span>
      </div>
      <div class="lxr-reason">${s.reason}</div>
    </div>`;
  }).join('');
}

// ── Quadrant history ────────────────────────────────────────────────────────
function getQuadrantHistory(symbol) {
  const h = quadrantHistory.get(symbol) || [];
  const colors = { LONG:'#00c878', SHORT:'#ee4444', SQUEEZE:'#2090c0', LIQ:'#882020' };
  return h.slice(0,8).map(e => `<span style="color:${colors[e.q]};font-size:9px" title="${e.q}">■</span>`).join(' ');
}

// ── Screener render ────────────────────────────────────────────────────────
function pctCell(v) {
  if (v == null) return `<div class="pct-wrap"><span class="pct-val null-val">—</span></div>`;
  const s = pctStyle(v);
  return `<div class="pct-wrap"><span class="pct-val" style="background:${s.bg};color:${s.text};font-weight:${s.fw}">${fmtPct(v)}</span></div>`;
}

// ── Celdas nuevas: ×ATR, liquidaciones 5m, sparkline, badge de cuadrante ────
function atrCell(row) {
  const v = row.moveAtr1h;
  if (v == null) return `<div class="pct-wrap"><span class="pct-val null-val">—</span></div>`;
  const a = Math.abs(v);
  const bg = v >= 0
    ? (a >= 2 ? '#00684a' : a >= 1 ? '#004a30' : '#002a1c')
    : (a >= 2 ? '#7a1414' : a >= 1 ? '#581010' : '#330a0a');
  const tc = v >= 0 ? '#7ae0b8' : '#ff9a9a';
  const fw = a >= 2 ? 800 : a >= 1 ? 700 : 500;
  return `<div class="pct-wrap"><span class="pct-val" style="background:${bg};color:${tc};font-weight:${fw}" title="Precio 1h dividido por el ATR(1h) propio: ≥1× = movimiento real para ESTA moneda, ≥2× = excepcional">${v > 0 ? '+' : ''}${v.toFixed(1)}×</span></div>`;
}

function liqCell(row) {
  const lq = liqSumCache.get(row.symbol);
  const tot = lq ? lq.l + lq.s : 0;
  if (tot <= 0) return `<div class="pct-wrap"><span class="pct-val null-val">—</span></div>`;
  const bull = lq.s >= lq.l; // cortos liquidados → compra forzada → presión alcista
  const bg = bull ? 'rgba(0,150,70,0.16)' : 'rgba(200,40,40,0.16)';
  const tc = bull ? '#7af0c0' : '#ff9a9a';
  return `<div class="pct-wrap"><span class="pct-val" style="background:${bg};color:${tc};font-weight:700" title="Últimos 5 min — largos liquidados: ${fmtUSD(lq.l)} · cortos liquidados: ${fmtUSD(lq.s)}">${bull ? '↑S' : '↓L'} ${fmtUSD(tot)}</span></div>`;
}

// ── Serie del mini-gráfico según la temporalidad seleccionada en el mapa ────
// 15m → velas 15m (~6h) · 1h → velas 1h (~25h) · 4h → 1 punto por 4h (~2d) ·
// 1d → todo el rango disponible (~2d). Sin llamadas extra: reutiliza k15/k60.
function sparkSeries(row) {
  const tf = typeof chartTf !== 'undefined' ? chartTf : '1h';
  if (tf === '15m' && row.k15?.c?.length) return row.k15.c.slice(-25);
  if (tf === '1h'  && row.k60?.c?.length) return row.k60.c.slice(-25);
  if (tf === '4h'  && row.k60?.c?.length) {
    const c = row.k60.c, out = [];
    for (let i = c.length - 1; i >= 0; i -= 4) out.unshift(c[i]); // cierre de cada bloque de 4h
    return out;
  }
  if (tf === '1d' && row.k60?.c?.length) return row.k60.c; // máx. disponible (~2 días)
  return row.spark; // fallback: velas 5m · ~2h
}

function sparkTitle() {
  const tf = typeof chartTf !== 'undefined' ? chartTf : '1h';
  return {
    '15m': 'velas 15m · ~6h',
    '1h':  'velas 1h · ~25h',
    '4h':  'velas 4h · ~2 días',
    '1d':  'rango completo (~2 días, máx. disponible)',
  }[tf] || 'velas 5m · ~2h';
}

function sparkSVG(vals, w = 54, h = 14) {
  if (!vals || vals.length < 3) return '';
  const min = Math.min(...vals), max = Math.max(...vals);
  const rng = max - min || 1;
  const pts = vals.map((v, i) =>
    `${(i / (vals.length - 1) * w).toFixed(1)},${(h - 1 - (v - min) / rng * (h - 2)).toFixed(1)}`).join(' ');
  const up = vals[vals.length - 1] >= vals[0];
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" style="flex-shrink:0;opacity:.8"><polyline points="${pts}" fill="none" stroke="${up ? '#2fb380' : '#d05555'}" stroke-width="1.2"/></svg>`;
}

const QUAD_STYLE = {
  LONG:    { bg: '#06291a', fg: '#2fe08a', short: 'L'  },
  SHORT:   { bg: '#2e0a0a', fg: '#ff5555', short: 'S'  },
  SQUEEZE: { bg: '#0a1f2e', fg: '#4aa8d8', short: 'Sq' },
  LIQ:     { bg: '#240808', fg: '#aa6060', short: 'Lq' },
};
function quadBadge(row) {
  if (row.oi1h == null || row.price1hPct == null) return '';
  const q = row.oi1h >= 0 && row.price1hPct >= 0 ? 'LONG'
          : row.oi1h >= 0 ? 'SHORT' : row.price1hPct >= 0 ? 'SQUEEZE' : 'LIQ';
  const s = QUAD_STYLE[q];
  return `<span class="row-quad" style="background:${s.bg};color:${s.fg}" title="Cuadrante 1h: ${q} (OI ${fmtPct(row.oi1h)} · P ${fmtPct(row.price1hPct)})">${s.short}</span>`;
}

// Persistencia: cuánto tiempo lleva el OI 5m con el mismo signo (acumulación
// sostenida vale más que un blip de un ciclo).
const oiStreaks = new Map(); // symbol → { dir, since }
function updateOiStreaks(rows) {
  const now = Date.now();
  for (const r of rows) {
    const dir = (r.oi5m ?? 0) > 0 ? 1 : (r.oi5m ?? 0) < 0 ? -1 : 0;
    const st = oiStreaks.get(r.symbol);
    if (!st || st.dir !== dir) oiStreaks.set(r.symbol, { dir, since: now });
  }
}
function streakBadge(row) {
  const st = oiStreaks.get(row.symbol);
  if (!st || st.dir === 0) return '';
  const mins = Math.floor((Date.now() - st.since) / 60_000);
  if (mins < 3) return '';
  const up = st.dir > 0;
  return `<span class="oi-streak" style="color:${up ? '#2fb380' : '#d05555'}" title="OI ${up ? 'subiendo' : 'bajando'} de forma sostenida desde hace ${mins} min — ${up ? 'acumulación' : 'desapalancamiento'} persistente, no un blip">OI${up ? '↑' : '↓'}${mins}m</span>`;
}

// ── Correlación con BTC (Pearson sobre retornos 5m, ~2h) ───────────────────
function _returnsOf(spark) {
  const out = [];
  if (!spark) return out;
  for (let i = 1; i < spark.length; i++) {
    if (spark[i - 1] > 0) out.push((spark[i] - spark[i - 1]) / spark[i - 1]);
  }
  return out;
}
function pearson(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 8) return null;
  let sa = 0, sb = 0;
  for (let i = 0; i < n; i++) { sa += a[i]; sb += b[i]; }
  const ma = sa / n, mb = sb / n;
  let cov = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma, db = b[i] - mb;
    cov += da * db; va += da * da; vb += db * db;
  }
  const den = Math.sqrt(va * vb);
  return den ? cov / den : null;
}

function corrCell(row) {
  const v = row.btcCorr;
  if (v == null) return `<div class="pct-wrap"><span class="pct-val null-val">—</span></div>`;
  let bg, tc, tag;
  if      (v >= 0.6)  { bg = 'rgba(60,100,180,0.18)';  tc = '#7a9ad0'; tag = 'sigue a BTC'; }
  else if (v >= 0.3)  { bg = 'rgba(60,100,180,0.10)';  tc = '#5a7090'; tag = 'correlación moderada'; }
  else if (v > -0.3)  { bg = 'rgba(0,150,70,0.16)';    tc = '#7af0c0'; tag = 'INDEPENDIENTE — movimiento propio'; }
  else                { bg = 'rgba(150,80,220,0.18)';  tc = '#bb96ee'; tag = 'INVERSA a BTC'; }
  return `<div class="pct-wrap"><span class="pct-val" style="background:${bg};color:${tc};font-weight:600" title="ρ vs BTC (retornos 5m, ~2h): ${tag}">${v.toFixed(2)}</span></div>`;
}

// Fuerza relativa vs BTC (1h) = precio moneda 1h% − precio BTC 1h%. Verde = le
// gana a BTC. El badge N/4 (consistencia multi-TF) y el ⚠ (liquidez baja) le dan
// fiabilidad: un +RS con 4/4 y sin ⚠ es fuerza real; con 1/4 o ⚠ es ruido.
function rsCell(row) {
  const v = row.rsBtc1h;
  if (v == null) return `<div class="pct-wrap"><span class="pct-val null-val">—</span></div>`;
  const a = Math.abs(v);
  const bg = v >= 0
    ? (a >= 1.5 ? '#00684a' : a >= 0.5 ? '#004a30' : '#002a1c')
    : (a >= 1.5 ? '#7a1414' : a >= 0.5 ? '#581010' : '#330a0a');
  const tc = v >= 0 ? '#7ae0b8' : '#ff9a9a';
  const fw = a >= 1.5 ? 800 : a >= 0.5 ? 700 : 500;
  const w = row.rsWins, tot = row.rsValidTf || 4;
  const bc = w == null ? '#5a6072' : w >= 4 ? '#37d99a' : w >= 3 ? '#2ba573' : w >= 2 ? '#9a9a5a' : '#8a6a6a';
  const badge = w == null ? '' :
    ` <span title="Le gana a BTC en ${w} de ${tot} ventanas (5m·1h·4h·24h)" style="font-size:9px;font-weight:700;color:${bc}">${w}/${tot}</span>`;
  const warn = row.rsLowLiq
    ? ` <span title="Liquidez baja (turnover 24h < $10M): la RS de esta moneda es poco fiable" style="opacity:0.85">⚠</span>` : '';
  return `<div class="pct-wrap"><span class="pct-val" style="background:${bg};color:${tc};font-weight:${fw}" title="RS vs BTC (1h): ${v > 0 ? '+' : ''}${v.toFixed(2)} puntos porcentuales por ${v >= 0 ? 'encima' : 'debajo'} de BTC">${v > 0 ? '+' : ''}${v.toFixed(2)}</span>${badge}${warn}</div>`;
}

// CVD reciente (delta de volumen comprador-vendedor en USD): verde = presión
// compradora neta, rojo = presión vendedora neta — mismo formato que fmtUSD.
function cvdCell(v) {
  if (v == null) return `<div class="pct-wrap"><span class="pct-val null-val">—</span></div>`;
  const pos = v > 0;
  const bg   = pos ? 'rgba(0,150,70,0.16)'  : v < 0 ? 'rgba(200,40,40,0.16)'  : 'rgba(120,130,150,0.10)';
  const text = pos ? '#7af0c0' : v < 0 ? '#ff9a9a' : '#7a8aa8';
  const sign = v > 0 ? '+' : v < 0 ? '-' : '';
  return `<div class="pct-wrap"><span class="pct-val" style="background:${bg};color:${text};font-weight:700">${sign}${fmtUSD(Math.abs(v))}</span></div>`;
}

// Umbral de liquidez para la fuerza relativa (RS) vs BTC: por debajo de este
// turnover de 24h (USD), la RS de la moneda se marca ⚠ como poco fiable
// (una orden chica infla el precio y da falsa fuerza). Ajustable.
const RS_MIN_TURNOVER = 10_000_000;

function render() {
  // Refrescar cache de liquidaciones para scoreSymbol
  const _cut5m = Date.now() - 5*60_000;
  liqSumCache.clear();
  for (const e of liqEvents) {
    if (e.ts < _cut5m) continue;
    if (!liqSumCache.has(e.symbol)) liqSumCache.set(e.symbol, { l: 0, s: 0 });
    const _t = liqSumCache.get(e.symbol);
    if (e.isLong) _t.l += e.usdVal; else _t.s += e.usdVal;
  }

  logTrackSnapshots(allRows);
  updateOiStreaks(allRows);

  // Datos derivados para columnas ordenables (×ATR, liquidaciones 5m, ρ BTC)
  const _btcRow = allRows.find(r => r.symbol === 'BTC');
  const _btcRets = _btcRow ? _returnsOf(_btcRow.spark) : [];
  for (const r of allRows) {
    const atrPct = r.atr1h && r.price ? r.atr1h / r.price * 100 : null;
    r.moveAtr1h = atrPct && r.price1hPct != null ? +(r.price1hPct / atrPct).toFixed(2) : null;
    const lq = liqSumCache.get(r.symbol);
    r.liq5m = lq ? Math.round(lq.l + lq.s) : 0;
    if (r.symbol === 'BTC') r.btcCorr = null; // consigo mismo no aplica
    else {
      const c = _btcRets.length ? pearson(_returnsOf(r.spark), _btcRets) : null;
      r.btcCorr = c == null ? null : +c.toFixed(2);
    }

    // ── Fuerza relativa vs BTC (RS): % de la moneda − % de BTC, misma ventana ─
    // Fiabilidad: (1) misma ventana y misma fuente que BTC; (2) rsWins = en
    // cuántas de las 4 ventanas (5m·1h·4h·24h) supera a BTC (consistencia real,
    // no una sola vela); (3) rsLowLiq = liquidez baja → RS poco fiable, se marca ⚠.
    if (r.symbol === 'BTC' || !_btcRow) { r.rsBtc1h = null; r.rsWins = null; r.rsValidTf = 0; r.rsLowLiq = false; }
    else {
      r.rsBtc1h = (r.price1hPct != null && _btcRow.price1hPct != null)
        ? +(r.price1hPct - _btcRow.price1hPct).toFixed(2) : null;
      let wins = 0, valid = 0;
      const _tf = [
        [r.price5mPct,  _btcRow.price5mPct],
        [r.price1hPct,  _btcRow.price1hPct],
        [r.price4hPct,  _btcRow.price4hPct],
        [r.price24hPct, _btcRow.price24hPct],
      ];
      for (const [cv, bv] of _tf) { if (cv != null && bv != null) { valid++; if (cv > bv) wins++; } }
      r.rsWins = valid ? wins : null;
      r.rsValidTf = valid;
      r.rsLowLiq = (r.turnover24h ?? 0) < RS_MIN_TURNOVER;
    }
  }

  const rows = getFilteredRows();
  const fc = document.getElementById('filter-count');
  if (fc) fc.textContent = rows.length + ' / ' + allRows.length + ' pares';
  const sorted = [...rows].sort((a, b) => {
    const av = a[sortCol] ?? (sortDir < 0 ? -Infinity : Infinity);
    const bv = b[sortCol] ?? (sortDir < 0 ? -Infinity : Infinity);
    if (typeof av === 'string') return sortDir * av.localeCompare(bv);
    return sortDir * (bv - av);
  });

  document.querySelectorAll('#thead th').forEach(th => {
    th.classList.toggle('active', th.dataset.col === sortCol);
    const ex = th.querySelector('.sort-arrow');
    if (ex) ex.remove();
    if (th.dataset.col === sortCol) {
      const sp = document.createElement('span');
      sp.className = 'sort-arrow';
      sp.textContent = sortDir < 0 ? '▼' : '▲';
      th.appendChild(sp);
    }
  });

  // Snapshot del ciclo anterior (para flechas en scoreCell)
  scoreSnap = new Map(prevScores);

  // Detectar saltos de score y actualizar tracking
  const _now = Date.now();
  sorted.forEach(row => {
    const sc = scoreSymbol(row);
    const score = Math.max(sc.longScore, sc.shortScore);
    const isLong = sc.longScore >= sc.shortScore;
    const prev = scoreSnap.get(row.symbol);
    // Alerta cuando el score salta de < 8 a ≥ 8 (categoría 'score' — OFF por defecto)
    if (canAlert('score') && prev !== undefined && prev.score < 8 && score >= 8) {
      if (soundEnabled) {
        beep(660, 'square', 110);
        showToast(`${row.symbol} ${isLong ? 'L' : 'S'}${score} — score subió`, isLong ? 'long' : 'short');
      }
      notifyDesktop(`${row.symbol} ${isLong ? 'LONG' : 'SHORT'} ${score}/10`, 'El score saltó a ≥8');
    }
    // Edad del score (nivel en buckets de 2)
    const level = score >= 8 ? 8 : score >= 6 ? 6 : score >= 4 ? 4 : score >= 2 ? 2 : 0;
    const seen = scoreFirstSeen.get(row.symbol);
    if (!seen || seen.level !== level) scoreFirstSeen.set(row.symbol, { level, ts: _now });
    prevScores.set(row.symbol, { score, isLong });
  });

  const tbody = document.getElementById('tbody');
  if (!sorted.length) {
    tbody.innerHTML = `<tr class="state-row"><td colspan="24">Sin datos</td></tr>`;
    return;
  }

  tbody.innerHTML = sorted.map((row, i) => {
    const isFav = favorites.has(row.symbol);
    const icon = `<div class="sym-icon" style="background:${symColor(row.symbol)}">${row.symbol.slice(0,3)}</div>`;
    const h = healthScore(row);
    const gem = h.grade === 'A'
      ? `<span class="health-gem" title="💎 Salud ${h.score}/100 (nota A, ${h.side.toUpperCase()}) — ${h.ok.slice(0, 3).join(' · ')}">💎</span>`
      : h.grade === 'B'
        ? `<span class="health-gem health-gem-b" title="Salud ${h.score}/100 (nota B, ${h.side.toUpperCase()}) — ${h.ok.slice(0, 2).join(' · ')}${h.bad.length ? ' · ✗ ' + h.bad[0] : ''}">💎</span>`
        : '';
    return `<tr data-sym="${row.symbol}">
      <td class="left-align"><div class="rank-cell">
        <span class="rank-num">${i+1}</span>
        <span class="star${isFav?' on':''}" onclick="toggleFav('${row.symbol}')">★</span>
      </div></td>
      <td class="left-align"><div class="sym-cell">${icon}<span class="sym-name">${row.symbol}</span>${gem}${quadBadge(row)}${patternBadge(row)}${streakBadge(row)}<span class="row-radar" title="Abrir en el radar de confluencia (checklist de 7 señales)" onclick="event.stopPropagation();openInRadar('${row.symbol}')">🎯</span></div></td>
      <td><div class="price-cell"><span title="Mini-gráfico: ${sparkTitle()} — cambia con la temporalidad seleccionada en el mapa">${sparkSVG(sparkSeries(row))}</span><span style="margin-left:6px">${fmtPrice(row.price)}</span></div></td>
      <td>${fundingCell(row.fundingRate)}</td>
      <td>${cvdCell(row.cvd1m)}</td>
      <td>${pctCell(row.oi5m)}</td>
      <td>${pctCell(row.oi15m)}</td>
      <td>${pctCell(row.oi1h)}</td>
      <td>${pctCell(row.oi4h)}</td>
      <td>${pctCell(row.oi24h)}</td>
      <td>${pctCell(row.vol15mPct)}</td>
      <td>${pctCell(row.vol1hPct)}</td>
      <td>${pctCell(row.vol12hPct)}</td>
      <td>${pctCell(row.vol24hPct)}</td>
      <td>${pctCell(row.price5mPct)}</td>
      <td>${pctCell(row.price15mPct)}</td>
      <td>${pctCell(row.price1hPct)}</td>
      <td>${pctCell(row.price4hPct)}</td>
      <td>${pctCell(row.price24hPct)}</td>
      <td>${atrCell(row)}</td>
      <td>${liqCell(row)}</td>
      <td>${corrCell(row)}</td>
      <td>${rsCell(row)}</td>
      <td>${scoreCell(row)}</td>
    </tr>`;
  }).join('');
}

// ── Scoring algorithm ──────────────────────────────────────────────────────
// Devuelve también partsL/partsS: el desglose de cada punto, para que el
// tooltip del score explique POR QUÉ una moneda puntúa lo que puntúa.
function scoreSymbol(row) {
  const n = v => v ?? 0;
  let L = 0, S = 0;
  const partsL = [], partsS = [];

  // ── LONG ──────────────────────────────────────────────────────────────────
  // OI + precio ambos positivos en 5m (mínimos reales, no cualquier +0.001%)
  if      (n(row.oi5m) > 0.3  && n(row.price5mPct) > 0.15) { L += 3; partsL.push('+3 OI 5m + P 5m fuertes'); }
  else if (n(row.oi5m) > 0.1  && n(row.price5mPct) > 0.05) { L += 2; partsL.push('+2 OI 5m + P 5m positivos'); }
  else if (n(row.oi5m) > 0    && n(row.price5mPct) > 0)    { L += 1; partsL.push('+1 OI 5m + P 5m leves'); }

  // OI acumulando en 1h — la magnitud importa
  if      (n(row.oi1h) > 1.5) { L += 3; partsL.push('+3 OI 1h > 1.5%'); }
  else if (n(row.oi1h) > 0.5) { L += 2; partsL.push('+2 OI 1h > 0.5%'); }
  else if (n(row.oi1h) > 0.2) { L += 1; partsL.push('+1 OI 1h > 0.2%'); }

  // OI 4h alineado (tendencia de fondo confirma)
  if (n(row.oi4h) > 0.5) { L += 1; partsL.push('+1 OI 4h alineado'); }

  // Volumen elevado sobre la media
  if      (n(row.vol1hPct) > 50) { L += 2; partsL.push('+2 vol 1h > 50%'); }
  else if (n(row.vol1hPct) > 15) { L += 1; partsL.push('+1 vol 1h > 15%'); }

  // Precio confirmando en 1h y 4h
  if (n(row.price1hPct) > 0.3) { L += 1; partsL.push('+1 precio 1h confirma'); }
  if (n(row.price4hPct) > 0)   { L += 1; partsL.push('+1 precio 4h confirma'); }

  // Funding negativo = shorts pagando = sesgo alcista
  if (n(row.fundingRate) < -0.01) { L += 1; partsL.push('+1 funding negativo (shorts pagan)'); }
  if (n(row.fundingRate) >  0.05) { L -= 1; partsL.push('−1 funding alto (longs sobreextendidos)'); }

  // CVD 5m (USD) comprador: flujo agresor confirmando — umbral relativo al
  // volumen propio (≥10% del volumen típico de 5m) para ser comparable
  const _vol5mUSD = (row.vol1hUSD ?? 0) / 12;
  if (row.cvd5m != null && _vol5mUSD > 0 && row.cvd5m > _vol5mUSD * 0.10) { L += 1; partsL.push('+1 CVD comprador (5m)'); }

  // Penalización dura si precio 1h va en contra (OI sube pero precio baja)
  if (n(row.price1hPct) < 0) { L = Math.floor(L * 0.35); if (L || partsL.length) partsL.push('×0.35 precio 1h en contra'); }

  // ── SHORT ─────────────────────────────────────────────────────────────────
  // OI subiendo + precio bajando en 5m (shorts entrando ahora)
  if      (n(row.oi5m) > 0.3  && n(row.price5mPct) < -0.15) { S += 3; partsS.push('+3 OI 5m ↑ + P 5m ↓ fuertes'); }
  else if (n(row.oi5m) > 0.1  && n(row.price5mPct) < -0.05) { S += 2; partsS.push('+2 OI 5m ↑ + P 5m ↓'); }
  else if (n(row.oi5m) > 0    && n(row.price5mPct) < 0)     { S += 1; partsS.push('+1 OI 5m ↑ + P 5m ↓ leves'); }

  // OI acumulando en 1h (nuevos shorts entrando)
  if      (n(row.oi1h) > 1.5) { S += 3; partsS.push('+3 OI 1h > 1.5%'); }
  else if (n(row.oi1h) > 0.5) { S += 2; partsS.push('+2 OI 1h > 0.5%'); }
  else if (n(row.oi1h) > 0.2) { S += 1; partsS.push('+1 OI 1h > 0.2%'); }

  // OI 4h sosteniendo presión bajista
  if (n(row.oi4h) > 0.5) { S += 1; partsS.push('+1 OI 4h sostiene presión'); }

  // Volumen elevado acompañando la caída
  if      (n(row.vol1hPct) > 50) { S += 2; partsS.push('+2 vol 1h > 50%'); }
  else if (n(row.vol1hPct) > 15) { S += 1; partsS.push('+1 vol 1h > 15%'); }

  // Precio bajando confirmado en 1h y 4h
  if (n(row.price1hPct) < -0.3) { S += 1; partsS.push('+1 precio 1h confirma'); }
  if (n(row.price4hPct) < 0)    { S += 1; partsS.push('+1 precio 4h confirma'); }

  // Funding positivo = longs pagando = sesgo bajista
  if (n(row.fundingRate) >  0.01) { S += 1; partsS.push('+1 funding positivo (longs pagan)'); }
  if (n(row.fundingRate) < -0.05) { S -= 1; partsS.push('−1 funding muy negativo (shorts sobreextendidos)'); }

  // CVD 5m (USD) vendedor: flujo agresor confirmando la caída
  if (row.cvd5m != null && _vol5mUSD > 0 && row.cvd5m < -_vol5mUSD * 0.10) { S += 1; partsS.push('+1 CVD vendedor (5m)'); }

  // Penalización dura si precio 1h sube (OI sube + precio sube = LONG, no SHORT)
  if (n(row.price1hPct) > 0) { S = Math.floor(S * 0.35); if (S || partsS.length) partsS.push('×0.35 precio 1h en contra'); }

  // Volumen mínimo: si < $300k en 1h, cap en 4 (señal no confiable)
  if ((row.vol1hUSD ?? 0) < 300_000) {
    if (L > 4) partsL.push('cap 4: volumen 1h < $300k');
    if (S > 4) partsS.push('cap 4: volumen 1h < $300k');
    L = Math.min(L, 4); S = Math.min(S, 4);
  }

  // Liquidación reciente confirma dirección (+1 bonus)
  const liqSym = liqSumCache.get(row.symbol);
  if (liqSym) {
    if (liqSym.s > 50_000) { L += 1; partsL.push('+1 cortos liquidados (5m)'); }
    if (liqSym.l > 50_000) { S += 1; partsS.push('+1 largos liquidados (5m)'); }
  }

  const tipo = L >= S ? 'LONG' : 'SHORT';
  return { tipo, score: Math.min(10, Math.max(L, S)), longScore: Math.min(10, Math.max(0, L)), shortScore: Math.min(10, Math.max(0, S)), partsL, partsS };
}

// ── Momentum card ──────────────────────────────────────────────────────────
function makeCard(row, isLong) {
  const sc = isLong ? row.longScore : row.shortScore;
  const score = Math.min(sc, 10);
  const fillPct    = score * 10;
  const badgeColor = isLong ? '#00cc88' : '#ff5555';
  const badgeBg    = isLong ? '#002e1a' : '#2e0a0a';
  const barFill    = isLong ? '#00804a' : '#992020';

  const metrics = [
    { label: 'OI  1h', val: row.oi1h,       max: 2   },
    { label: 'Vol 1h', val: row.vol1hPct,    max: 60  },
    { label: 'P   1h', val: row.price1hPct,  max: 2   },
    { label: '×ATR',   val: row.moveAtr1h,   max: 3,
      fmt: v => (v >= 0 ? '+' : '') + v.toFixed(1) + '×' },
    { label: 'CVD 5m', val: row.cvd5m,       max: Math.max((row.vol1hUSD ?? 0) / 12, 1),
      fmt: v => (v >= 0 ? '+' : '−') + fmtUSD(Math.abs(v)) },
  ];

  const bars = metrics.map(({ label, val, max, fmt }) => {
    const v = val ?? 0;
    const pct = Math.min(100, (Math.abs(v) / max) * 100);
    const barC = v >= 0 ? '#005e38' : '#7a1818';
    const txtC = val == null ? '#3a4a60' : v >= 0 ? '#55bb88' : '#ee6666';
    const txt = val == null ? '—' : (fmt ? fmt(val) : fmtPct(val));
    return `<div class="sc-metric">
      <span class="sc-metric-label">${label}</span>
      <div class="sc-bar-wrap"><div class="sc-bar" style="width:${pct}%;background:${barC}"></div></div>
      <span class="sc-metric-val" style="color:${txtC}">${txt}</span>
    </div>`;
  }).join('');

  const tvUrl = `https://www.tradingview.com/chart/?symbol=BYBIT:${row.symbol}USDT.P`;
  const p1h = row.price1hPct ?? 0;
  const p1hColor = p1h >= 0 ? '#55bb88' : '#ee6666';
  const lq = liqSumCache.get(row.symbol);
  const lqTot = lq ? lq.l + lq.s : 0;
  const lqChip = lqTot > 0
    ? `<span style="font-size:9px;font-weight:700;color:${lq.s >= lq.l ? '#55bb88' : '#ee6666'}" title="Liquidaciones 5m — largos: ${fmtUSD(lq.l)} · cortos: ${fmtUSD(lq.s)}">⚡${fmtUSD(lqTot)}</span>`
    : '';

  return `<div class="sc-card ${isLong ? 'sc-long' : 'sc-short'}"
    onclick="window.open('${tvUrl}','_blank')"
    data-sym="${row.symbol}">
    <div class="sc-header">
      <div class="sc-icon" style="background:${symColor(row.symbol)}">${row.symbol.slice(0,3)}</div>
      <div class="sc-name">${row.symbol}</div>
      <div class="sc-badge" style="background:${badgeBg};color:${badgeColor}">${isLong?'LONG':'SHORT'}</div>
      <div class="sc-score-num">${score}/10</div>
    </div>
    <div class="sc-score-bar"><div class="sc-score-fill" style="width:${fillPct}%;background:${barFill}"></div></div>
    <div class="sc-metrics">${bars}</div>
    <div class="sc-footer">
      <span class="sc-price">${fmtPrice(row.price)}</span>
      ${lqChip}
      <span style="color:${p1hColor};font-size:11px;font-weight:600">${fmtPct(p1h) ?? '—'} (1h)</span>
    </div>
  </div>`;
}
