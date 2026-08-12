/* public/backtest.js
 * ⏪ Replay: backtest sobre los snapshots de precio (5 min) que guarda el
 * servidor. Evalúa retroactivamente:
 *   1. Doble suelo/techo (W/M) con ruptura de cuello — el mismo detector del
 *      screener, adaptado a serie de cierres.
 *   2. Ruptura Donchian 2h (línea base para comparar: ¿el patrón aporta algo
 *      sobre una ruptura simple?).
 * Resultados con n e intervalo de Wilson — mismas reglas de honestidad que el
 * resto de la app. Requiere que el servidor lleve tiempo acumulando snapshots.
 */

// Los snapshots del servidor son cada 5 min; se agregan de 3 en 3 → serie de
// cierres 15m, la misma temporalidad que usa el detector en vivo.
const BT_CFG = {
  pivotWin: 2,        // pivote = extremo de ±2 puntos 15m (±30 min)
  tolExtremes: 0.5,   // tolerancia entre extremos (× ATR proxy)
  minDepth: 1.2,      // profundidad mínima valle→cuello (× ATR proxy)
  minSep: 4, maxSep: 40, // 1h – 10h entre extremos
  horizon: 8,         // evaluación hasta +8 velas 15m (2h)
  cooldown: 4,        // señales del mismo tipo separadas ≥ 1h
};

function _btAtr(c, i) {
  // proxy de ATR con solo cierres: media de |Δc| × 1.5, ventana 40
  let s = 0, n = 0;
  for (let j = Math.max(1, i - 40); j <= i; j++) { s += Math.abs(c[j] - c[j - 1]); n++; }
  return n ? (s / n) * 1.5 : 0;
}

// Todos los eventos de ruptura de cuello W/M en una serie de cierres
function _btDoubleEvents(c) {
  const k = { h: c, l: c, c };
  const piv = _patPivots(k, BT_CFG.pivotWin);
  const lows = piv.filter(p => p.type === 'L');
  const highs = piv.filter(p => p.type === 'H');
  const events = [];

  const scan = (exts, mids, isBottom) => {
    for (let a = 0; a < exts.length - 1; a++) {
      for (let b = a + 1; b < exts.length; b++) {
        const P1 = exts[a], P2 = exts[b];
        const sep = P2.i - P1.i;
        if (sep < BT_CFG.minSep) continue;
        if (sep > BT_CFG.maxSep) break;
        const atr = _btAtr(c, P2.i);
        if (!atr) continue;
        if (Math.abs(P1.price - P2.price) > BT_CFG.tolExtremes * atr) continue;
        const between = mids.filter(m => m.i > P1.i && m.i < P2.i);
        if (!between.length) continue;
        const neck = isBottom
          ? between.reduce((x, y) => (y.price > x.price ? y : x))
          : between.reduce((x, y) => (y.price < x.price ? y : x));
        const extLevel = isBottom ? Math.min(P1.price, P2.price) : Math.max(P1.price, P2.price);
        const depth = Math.abs(neck.price - extLevel);
        if (depth < BT_CFG.minDepth * atr) continue;

        // primera ruptura del cuello tras P2 (sin perforar antes los extremos)
        let breakIdx = null;
        for (let i = P2.i + 1; i < c.length; i++) {
          if (isBottom ? c[i] < extLevel - 0.25 * atr : c[i] > extLevel + 0.25 * atr) break; // invalidado
          if (isBottom ? (c[i] > neck.price && c[i - 1] <= neck.price)
                       : (c[i] < neck.price && c[i - 1] >= neck.price)) { breakIdx = i; break; }
        }
        if (breakIdx == null) continue;
        events.push({
          type: isBottom ? 'W' : 'M', i: breakIdx,
          entry: c[breakIdx],
          target: isBottom ? neck.price + depth : neck.price - depth,
          stop:   isBottom ? extLevel - 0.3 * atr : extLevel + 0.3 * atr,
        });
      }
    }
  };
  scan(lows, highs, true);
  scan(highs, lows, false);

  // dedupe: ordenar por vela de ruptura y aplicar cooldown por dirección
  events.sort((x, y) => x.i - y.i);
  const out = []; const lastByType = { W: -Infinity, M: -Infinity };
  for (const e of events) {
    if (e.i - lastByType[e.type] < BT_CFG.cooldown) continue;
    lastByType[e.type] = e.i;
    out.push(e);
  }
  return out;
}

function _btEvalEvent(c, e) {
  const dir = e.type === 'W' ? 1 : -1;
  let outcome = null; // 'target' | 'stop' | null
  for (let i = e.i + 1; i < Math.min(c.length, e.i + 1 + BT_CFG.horizon); i++) {
    if (dir > 0 ? c[i] >= e.target : c[i] <= e.target) { outcome = 'target'; break; }
    if (dir > 0 ? c[i] <= e.stop   : c[i] >= e.stop)   { outcome = 'stop'; break; }
  }
  const at = n => (e.i + n < c.length) ? (c[e.i + n] - e.entry) / e.entry * 100 * dir : null;
  return { ...e, outcome, m1h: at(4), m2h: at(8) };
}

function _btDonchianEvents(c) {
  const events = []; let last = -Infinity;
  for (let i = 8; i < c.length; i++) {
    if (i - last < BT_CFG.cooldown) continue;
    const win = c.slice(i - 8, i); // ruptura del rango de 2h (8 velas 15m)
    if (c[i] > Math.max(...win))      { events.push({ type: 'W', i, entry: c[i] }); last = i; }
    else if (c[i] < Math.min(...win)) { events.push({ type: 'M', i, entry: c[i] }); last = i; }
  }
  return events.map(e => {
    const dir = e.type === 'W' ? 1 : -1;
    const at = n => (e.i + n < c.length) ? (c[e.i + n] - e.entry) / e.entry * 100 * dir : null;
    return { ...e, m1h: at(4), m2h: at(8) };
  });
}

function _btAgg(evs, key) {
  const v = evs.map(e => e[key]).filter(x => x != null);
  if (!v.length) return null;
  const hits = v.filter(x => x > 0).length;
  return { n: v.length, hits, winRate: Math.round(hits / v.length * 100), avg: v.reduce((a, b) => a + b, 0) / v.length };
}

async function runBacktest() {
  const status = document.getElementById('bt-status');
  const out = document.getElementById('bt-results');
  if (!out) return;
  const days = +document.getElementById('bt-window').value || 7;
  const scope = document.getElementById('bt-scope').value;
  const syms = scope === 'favs'
    ? [...new Set([...favorites, ...autoTracked.keys()])].slice(0, 40)
    : [...allRows].sort((a, b) => (b.turnover24h ?? 0) - (a.turnover24h ?? 0)).slice(0, 30).map(r => r.symbol);
  if (!syms.length) { out.innerHTML = '<span class="lr-empty">Marca favoritos (★) o espera a que cargue el screener para elegir el top por liquidez.</span>'; return; }

  if (status) status.textContent = `descargando series de ${syms.length} símbolos…`;
  let rows = [];
  try {
    const res = await fetch(`/api/prices/series?symbols=${encodeURIComponent(syms.join(','))}&from=${Date.now() - days * 24 * 3600_000}`);
    if (res.ok) rows = (await res.json()).rows || [];
  } catch (_) {}
  if (!rows.length) {
    if (status) status.textContent = '';
    out.innerHTML = '<span class="lr-empty">El servidor aún no tiene snapshots para esa ventana — el job guarda un punto cada 5 min desde que arrancó server.js. Déjalo correr y reintenta.</span>';
    return;
  }

  if (status) status.textContent = `analizando ${rows.length.toLocaleString()} puntos…`;
  const bySym = new Map();
  for (const r of rows) {
    if (!bySym.has(r.symbol)) bySym.set(r.symbol, []);
    bySym.get(r.symbol).push(r.price);
  }
  // agregar 5 min → cierres de 15m (cada 3er punto), misma escala que el detector
  for (const [sym, c5] of bySym) {
    const c15 = [];
    for (let i = 2; i < c5.length; i += 3) c15.push(c5[i]);
    if (c5.length && (c5.length - 1) % 3 !== 2) c15.push(c5[c5.length - 1]);
    bySym.set(sym, c15);
  }

  const wmEvents = [], dcEvents = [], perSym = [];
  for (const [sym, c] of bySym) {
    if (c.length < 30) continue;
    const wm = _btDoubleEvents(c).map(e => ({ ..._btEvalEvent(c, e), sym }));
    const dc = _btDonchianEvents(c).map(e => ({ ...e, sym }));
    wmEvents.push(...wm);
    dcEvents.push(...dc);
    if (wm.length) {
      const a = _btAgg(wm, 'm1h');
      if (a) perSym.push({ sym, n: wm.length, wr: a.winRate, avg: a.avg });
    }
  }

  const resolved = wmEvents.filter(e => e.outcome);
  const tHits = resolved.filter(e => e.outcome === 'target').length;
  const wm1h = _btAgg(wmEvents, 'm1h'), wm2h = _btAgg(wmEvents, 'm2h');
  const dc1h = _btAgg(dcEvents, 'm1h'), dc2h = _btAgg(dcEvents, 'm2h');

  const card = (title, n, a1, a2, extra = '') => `<div class="sc-card">
    <div class="sc-name">${title}<span style="margin-left:auto;font-size:9px;color:#9da6b5;font-weight:400">${n} señales</span></div>
    <div class="sc-row"><span>+1h (n=${a1?.n ?? 0})</span><span>${a1 ? `<b>${wrChip(a1.winRate, a1.n)}</b> · <span class="${a1.avg >= 0 ? 'pos' : 'neg'}">${a1.avg >= 0 ? '+' : ''}${a1.avg.toFixed(2)}%</span>` : '<b>—</b>'}</span></div>
    <div class="sc-row"><span>+2h (n=${a2?.n ?? 0})</span><span>${a2 ? `<b>${wrChip(a2.winRate, a2.n)}</b> · <span class="${a2.avg >= 0 ? 'pos' : 'neg'}">${a2.avg >= 0 ? '+' : ''}${a2.avg.toFixed(2)}%</span>` : '<b>—</b>'}</span></div>
    ${extra}
  </div>`;

  const tpRow = resolved.length
    ? `<div class="sc-row"><span>Objetivo vs stop (n=${resolved.length})</span><span><b>${wrChip(Math.round(tHits / resolved.length * 100), resolved.length)}</b> tocó objetivo primero</span></div>`
    : '';

  const top = perSym.filter(s => s.n >= 3).sort((a, b) => b.wr - a.wr).slice(0, 6);
  const topHtml = top.length
    ? `<div style="margin-top:8px"><div class="qal-head">Mejores símbolos para W/M en esta ventana (n≥3)</div>
       <div class="qal-grid">${top.map(s => `<span class="qal-chip" onclick="openDetail('${s.sym}')">${s.sym} <b style="color:${s.wr >= 50 ? '#2fe08a' : '#ee6666'}">${s.wr}%</b> <span class="qal-pct" style="color:#bbc2cd">n=${s.n}</span></span>`).join('')}</div></div>`
    : '';

  if (status) status.textContent = `ventana: ${days}d · ${bySym.size} símbolos con datos`;
  out.innerHTML = `<div class="sc-grid">
      ${card('◭ W/M — ruptura de cuello', wmEvents.length, wm1h, wm2h, tpRow)}
      ${card('📏 Ruptura Donchian 2h (línea base)', dcEvents.length, dc1h, dc2h)}
    </div>
    ${topHtml}
    <div class="cc-note" style="margin-top:6px">⚠️ Resolución de 5 min y solo cierres: los toques de objetivo/stop intra-vela no se ven — tómalo como orientación de si el patrón tiene edge, no como PnL exacto. Si W/M no supera a la línea base Donchian, el patrón no está aportando en esta ventana.</div>`;
}
