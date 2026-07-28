/* public/detail.js
 * Panel lateral de detalle: clic en una fila del screener (o en un chip de
 * patrón) → gráfico de velas 5m con el patrón W/M y sus niveles dibujados,
 * checklist del radar, métricas clave y niveles ATR. Sin salir de la página.
 */

let detailSym = null;

// ── Historial extendido de velas 15m por símbolo (~3 días) ──────────────────
// row.k15 solo trae ~24h (agregado de 288 velas de 5m). Al abrir el panel se
// pide un tramo más largo directo a Bybit (igual que hace btc.js con k15x)
// para poder mostrar más barras de contexto a la izquierda del patrón.
const DT_HIST_TTL = 5 * 60_000;
let _dtHist = new Map(); // symbol → { ts, k:{t,o,h,l,c,v} }

async function dtFetchHistory(symbol) {
  try {
    const r = await bybitGet(`/v5/market/kline?category=linear&symbol=${symbol}USDT&interval=15&limit=300`);
    const list = r.result?.list || [];
    if (list.length < 20) return;
    _dtHist.set(symbol, {
      ts: Date.now(),
      k: {
        t: list.map(x => +x[0]).reverse(),
        o: list.map(x => parseFloat(x[1])).reverse(),
        h: list.map(x => parseFloat(x[2])).reverse(),
        l: list.map(x => parseFloat(x[3])).reverse(),
        c: list.map(x => parseFloat(x[4])).reverse(),
        v: list.map(x => parseFloat(x[5])).reverse(),
      },
    });
    if (detailSym === symbol) {
      const row = allRows.find(r2 => r2.symbol === symbol);
      if (row) drawDetailChart(row);
    }
  } catch (_) {}
}

// Combina el historial extendido (velas más antiguas que row.k15) con row.k15
// (siempre el tramo más reciente, en vivo). Devuelve también `offset`: cuánto
// hay que sumarle a los índices del patrón (p.p1.i, p.p2.i, breakIdx), que
// fueron calculados contra row.k15 antes de la fusión.
function dtBuildChartData(row) {
  const k15 = row.k15;
  const ext = _dtHist.get(row.symbol);
  if (!ext || (Date.now() - ext.ts) > DT_HIST_TTL * 2 || !ext.k?.c?.length || !k15?.t?.length) {
    return { k: k15, offset: 0 };
  }
  const cutoff = k15.t[0];
  let cut = 0;
  while (cut < ext.k.t.length && ext.k.t[cut] < cutoff) cut++;
  if (cut === 0) return { k: k15, offset: 0 }; // nada más antiguo que aportar
  return {
    offset: cut,
    k: {
      t: ext.k.t.slice(0, cut).concat(k15.t),
      o: ext.k.o.slice(0, cut).concat(k15.o),
      h: ext.k.h.slice(0, cut).concat(k15.h),
      l: ext.k.l.slice(0, cut).concat(k15.l),
      c: ext.k.c.slice(0, cut).concat(k15.c),
      v: ext.k.v.slice(0, cut).concat(k15.v),
    },
  };
}

// ── Panel redimensionable: arrastra el borde izquierdo con el mouse ─────────
let _dtW = Math.max(340, parseInt(localStorage.getItem('scalp_dt_w')) || 400);
let _dtResizerReady = false;

function _dtApplyW() {
  _dtW = Math.max(340, Math.min(_dtW, Math.min(960, window.innerWidth - 60)));
  const panel = document.getElementById('detail-panel');
  const rz = document.getElementById('dt-resizer');
  if (panel) panel.style.width = _dtW + 'px';
  if (rz) rz.style.right = _dtW + 'px'; // el asa vive pegada al borde izquierdo del panel
}

function _dtInitResizer() {
  if (_dtResizerReady) return;
  const rz = document.getElementById('dt-resizer');
  if (!rz) return;
  _dtResizerReady = true;
  let startX = 0, startW = 0, raf = null;
  rz.addEventListener('mousedown', ev => {
    ev.preventDefault();
    startX = ev.clientX; startW = _dtW;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'ew-resize';
    const move = e => {
      _dtW = startW + (startX - e.clientX); // arrastrar a la izquierda = más ancho
      _dtApplyW();
      if (!raf) raf = requestAnimationFrame(() => { // redibuja el gráfico mientras arrastras
        raf = null;
        const row = detailSym && allRows.find(r => r.symbol === detailSym);
        if (row) drawDetailChart(row);
      });
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      safeSetItem('scalp_dt_w', String(_dtW));
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
  rz.addEventListener('dblclick', () => { // doble clic: volver al tamaño original
    _dtW = 400; _dtApplyW();
    safeSetItem('scalp_dt_w', '400');
    const row = detailSym && allRows.find(r => r.symbol === detailSym);
    if (row) drawDetailChart(row);
  });
}

function openDetail(sym) {
  detailSym = sym;
  const panel = document.getElementById('detail-panel');
  if (!panel) return;
  panel.style.display = 'flex';
  const rz = document.getElementById('dt-resizer');
  if (rz) rz.style.display = 'block';
  _dtApplyW();
  _dtInitResizer();
  renderDetail();
  const cached = _dtHist.get(sym);
  if (!cached || (Date.now() - cached.ts) > DT_HIST_TTL) dtFetchHistory(sym);
}

function closeDetail() {
  detailSym = null;
  const panel = document.getElementById('detail-panel');
  if (panel) panel.style.display = 'none';
  const rz = document.getElementById('dt-resizer');
  if (rz) rz.style.display = 'none';
}

// Refresca el contenido (se llama al abrir y en cada ciclo de datos)
function renderDetail() {
  if (!detailSym) return;
  const panel = document.getElementById('detail-panel');
  const row = allRows.find(r => r.symbol === detailSym);
  if (!panel || !row) return;

  const sc = scoreSymbol(row);
  const isLong = sc.longScore >= sc.shortScore;
  const score = Math.max(sc.longScore, sc.shortScore);
  const atrPct = row.atr1h && row.price ? row.atr1h / row.price * 100 : null;
  const p = row.pattern;
  const tvUrl = `https://www.tradingview.com/chart/?symbol=BYBIT:${row.symbol}USDT.P`;

  const f = v => v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
  const fc = v => v == null ? '#3a4a60' : v >= 0 ? '#55bb88' : '#ee6666';

  // ── Patrón W/M (15m y 1h, cada uno con su sección) ──
  const patternSection = (pp, tfLabel) => {
    if (!pp) return '';
    const isW = pp.type === 'W';
    const stTxt = pp.state === 'breaking'   ? '⚡ RUPTURA CONFIRMADA — la vela cerró más allá del cuello'
                : pp.state === 'confirming' ? '⏳ Cruzando el cuello — esperando el CIERRE de vela que confirme'
                : pp.state === 'forming'    ? 'Formándose — aún sin romper el cuello'
                : '✓ Cuello roto — patrón confirmado';
    const stCol = pp.state === 'breaking' ? '#ffbe3c' : pp.state === 'confirming' ? '#e0a830' : isW ? '#2fe08a' : '#ff6666';
    return `<div class="dt-section" style="border-color:${stCol}40">
      <div class="dt-sec-title" style="color:${stCol}">${isW ? '🟢 DOBLE SUELO (W)' : '🔴 DOBLE TECHO (M)'} · ${tfLabel} · calidad ${pp.quality}/10</div>
      <div class="dt-row"><span>Estado</span><b style="color:${stCol}">${stTxt}</b></div>
      <div class="dt-row"><span>Línea de cuello</span><b style="color:${tfLabel === '1h' ? '#c9a2ff' : '#ffd76a'}">${fmtPrice(pp.neckline)}</b></div>
      <div class="dt-row"><span>Objetivo (mov. medido)</span><b class="pos">${fmtPrice(pp.target)} (${f((pp.target - row.price) / row.price * 100)})</b></div>
      <div class="dt-row"><span>Stop sugerido</span><b class="neg">${fmtPrice(pp.stop)} (${f((pp.stop - row.price) / row.price * 100)})</b></div>
    </div>`;
  };
  const patternHtml = patternSection(p, '15m') + patternSection(row.pattern1h, '1h');

  // ── Checklist del radar de confluencia ──
  let checksHtml = '';
  try {
    if (typeof computeConfluence === 'function') {
      if (!confCache.has(detailSym)) {
        const res = computeConfluence(allRows);
        if (res) for (const c of res.confs) confCache.set(c.symbol, c);
      }
      const c = confCache.get(detailSym);
      if (c) {
        checksHtml = `<div class="dt-section">
          <div class="dt-sec-title">🎯 Radar de confluencia — ${c.count}/7 (${c.side.toUpperCase()})</div>
          ${c.checks.map(ch => `<div class="dt-row"><span style="color:${ch.ok ? '#2fe08a' : '#a05555'}">${ch.ok ? '✓' : '✗'} ${ch.k}</span><span style="color:#4a5870;text-align:right">${ch.d}</span></div>`).join('')}
        </div>`;
      }
    }
  } catch (_) { /* radar sin datos aún */ }

  // ── Niveles ATR genéricos (si no hay patrón, guía de stop/TP) ──
  const lvlHtml = atrPct ? `<div class="dt-section">
    <div class="dt-sec-title">Niveles por ATR(1h) — ${atrPct.toFixed(2)}%</div>
    <div class="dt-row"><span>Stop (1.2×ATR)</span><b class="neg">${fmtPrice(row.price * (1 - (isLong ? 1 : -1) * atrPct * 1.2 / 100))}</b></div>
    <div class="dt-row"><span>TP (1.8×ATR)</span><b class="pos">${fmtPrice(row.price * (1 + (isLong ? 1 : -1) * atrPct * 1.8 / 100))}</b></div>
  </div>` : '';

  const lq = liqSumCache.get(row.symbol);
  panel.innerHTML = `
    <div class="dt-head">
      <div class="sym-icon" style="background:${symColor(row.symbol)}">${row.symbol.slice(0, 3)}</div>
      <b class="dt-sym">${row.symbol}</b>
      <span class="dt-price">${fmtPrice(row.price)}</span>
      ${quadBadge(row)}
      <span class="score-pill" style="background:${isLong ? 'rgba(0,140,80,.85)' : 'rgba(160,20,0,.85)'};color:${isLong ? '#aaffdd' : '#ffaaaa'}">${isLong ? 'L' : 'S'}${score}</span>
      <span class="star${favorites.has(row.symbol) ? ' on' : ''}" onclick="toggleFav('${row.symbol}')" style="cursor:pointer">★</span>
      <button class="dt-close" onclick="closeDetail()" title="Cerrar (Esc)">✕</button>
    </div>
    <canvas id="dt-chart"></canvas>
    <div class="dt-chart-hint">velas 15m · ~24h ${p ? '· <span style="color:#ffd76a">— cuello</span> · <span style="color:#2fe08a">···objetivo</span> · <span style="color:#ff6666">···stop</span>' : ''}</div>
    ${patternHtml}
    <div class="dt-section">
      <div class="dt-sec-title">Métricas</div>
      <div class="dt-grid">
        <div class="dt-row"><span>OI 5m / 1h</span><span><b style="color:${fc(row.oi5m)}">${f(row.oi5m)}</b> / <b style="color:${fc(row.oi1h)}">${f(row.oi1h)}</b></span></div>
        <div class="dt-row"><span>Precio 1h / 4h</span><span><b style="color:${fc(row.price1hPct)}">${f(row.price1hPct)}</b> / <b style="color:${fc(row.price4hPct)}">${f(row.price4hPct)}</b></span></div>
        <div class="dt-row"><span>Vol 1h</span><b style="color:${fc(row.vol1hPct)}">${f(row.vol1hPct)}</b></div>
        <div class="dt-row"><span>CVD 5m</span><b style="color:${row.cvd5m == null ? '#3a4a60' : row.cvd5m >= 0 ? '#55bb88' : '#ee6666'}">${row.cvd5m == null ? '—' : (row.cvd5m >= 0 ? '+' : '−') + fmtUSD(Math.abs(row.cvd5m))}</b></div>
        <div class="dt-row"><span>Funding</span><b style="color:${row.fundingRate > 0.01 ? '#e09030' : row.fundingRate < -0.01 ? '#40a8e0' : '#5a6a85'}">${row.fundingRate == null ? '—' : (row.fundingRate >= 0 ? '+' : '') + row.fundingRate.toFixed(4) + '%'}</b></div>
        <div class="dt-row"><span>P1h ×ATR</span><b style="color:${fc(row.moveAtr1h)}">${row.moveAtr1h == null ? '—' : (row.moveAtr1h >= 0 ? '+' : '') + row.moveAtr1h.toFixed(1) + '×'}</b></div>
        <div class="dt-row"><span>ρ BTC / RS 1h</span><span><b>${row.btcCorr == null ? '—' : row.btcCorr.toFixed(2)}</b> / <b style="color:${fc(row.rsBtc1h)}">${f(row.rsBtc1h)}</b></span></div>
        <div class="dt-row"><span>⚡ Liq 5m</span><b>${lq && (lq.l + lq.s) > 0 ? `${lq.s >= lq.l ? '↑S' : '↓L'} ${fmtUSD(lq.l + lq.s)}` : '—'}</b></div>
        <div class="dt-row"><span>Liquidez 24h</span><b>${fmtOI(row.turnover24h)}</b></div>
      </div>
    </div>
    ${lvlHtml}
    ${checksHtml}
    <div class="dt-actions">
      <a class="pt-btn" href="${tvUrl}" target="_blank" style="text-decoration:none">📈 TradingView</a>
      <button class="pt-btn" onclick="openInRadar('${row.symbol}')">🎯 Radar</button>
      <button class="pt-btn" onclick="highlightScreenerRow('${row.symbol}')">📌 Ver en tabla</button>
    </div>`;

  requestAnimationFrame(() => drawDetailChart(row));
}

// ── Gráfico de velas 5m con el patrón dibujado ──────────────────────────────
function drawDetailChart(row) {
  const canvas = document.getElementById('dt-chart');
  if (!canvas || !row.k15 || row.k15.c.length < 10) return;

  const { k, offset } = dtBuildChartData(row);

  const W = canvas.width = canvas.clientWidth || 380;
  // La altura escala con el ancho del panel (redimensionable): más panel = más gráfico
  const H = canvas.height = Math.round(Math.min(460, Math.max(235, W * 0.55)));
  canvas.style.height = H + 'px';
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);

  // Con historial extendido cargado se muestran más barras de contexto
  // (hasta ~200, ~50h); si aún no llegó el fetch, se ve el tramo de siempre (24h).
  const N = Math.min(k.c.length, offset > 0 ? 200 : 110);
  const start = k.c.length - N;
  const PADL = 4, PADR = 50, PADT = 10, PADB = 6;
  const p = row.pattern;
  const p1h = row.pattern1h;

  let min = Infinity, max = -Infinity;
  for (let i = start; i < k.c.length; i++) { min = Math.min(min, k.l[i]); max = Math.max(max, k.h[i]); }
  if (p) { min = Math.min(min, p.stop, p.target); max = Math.max(max, p.stop, p.target); }
  // niveles del patrón 1h: solo si caen a ±6% del precio (no aplastar velas)
  if (p1h) for (const v of [p1h.neckline, p1h.target, p1h.stop]) {
    if (v > row.price * 0.94 && v < row.price * 1.06) { min = Math.min(min, v); max = Math.max(max, v); }
  }
  const pad = (max - min) * 0.05 || max * 0.001;
  min -= pad; max += pad;

  // ~15% de espacio libre a la derecha de la última vela: la ruptura no queda
  // pegada al eje de precios y se distingue bien contra el cuello
  const RGAP = Math.max(6, Math.round(N * 0.15));
  const x = i => PADL + (i - start) / Math.max(1, N - 1 + RGAP) * (W - PADL - PADR);
  const y = v => PADT + (max - v) / (max - min) * (H - PADT - PADB);

  // Grid + eje derecho (tenue, pegado al borde)
  ctx.font = '9px Inter,system-ui';
  for (let g = 0; g <= 4; g++) {
    const v = min + (max - min) * g / 4;
    const gy = y(v);
    ctx.strokeStyle = 'rgba(255,255,255,0.04)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(PADL, gy); ctx.lineTo(W - PADR, gy); ctx.stroke();
    ctx.fillStyle = '#26334a'; ctx.textAlign = 'right';
    ctx.fillText(fmtPrice(v).replace('$', ''), W - 3, gy + 3);
  }

  // Velas
  const bw = Math.max(1.4, (W - PADL - PADR) / N * 0.68);
  for (let i = start; i < k.c.length; i++) {
    const up = k.c[i] >= k.o[i];
    const col = up ? '#1fae74' : '#d24a4a';
    ctx.strokeStyle = col; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x(i), y(k.h[i])); ctx.lineTo(x(i), y(k.l[i])); ctx.stroke();
    ctx.fillStyle = col;
    const yo = y(k.o[i]), yc = y(k.c[i]);
    ctx.fillRect(x(i) - bw / 2, Math.min(yo, yc), bw, Math.max(1, Math.abs(yc - yo)));
  }

  // Las etiquetas se acumulan y se pintan al final: chips con fondo, apiladas
  // por altura para que nunca se tapen entre sí ni con el eje
  const _labels = [];
  const hline = (v, color, dash, label) => {
    ctx.save();
    ctx.strokeStyle = color; ctx.lineWidth = 1.2;
    if (dash) ctx.setLineDash(dash);
    ctx.beginPath(); ctx.moveTo(PADL, y(v)); ctx.lineTo(W - PADR, y(v)); ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
    _labels.push({ v, color, label });
  };

  if (p) {
    const isW = p.type === 'W';
    // Línea de cuello (desde el 1er extremo hasta el borde)
    ctx.save();
    ctx.strokeStyle = '#ffd76a'; ctx.lineWidth = 1.6; ctx.setLineDash([6, 3]);
    ctx.shadowColor = 'rgba(255,215,106,.5)'; ctx.shadowBlur = 5;
    ctx.beginPath(); ctx.moveTo(x(Math.max(start, p.p1.i + offset)), y(p.neckline)); ctx.lineTo(W - PADR, y(p.neckline)); ctx.stroke();
    ctx.restore();
    _labels.push({ v: p.neckline, color: '#ffd76a', label: 'cuello ' + fmtPrice(p.neckline).replace('$', '') });

    // Marcar los dos extremos (suelos o techos)
    for (const pt of [p.p1, p.p2]) {
      const pi = pt.i + offset;
      if (pi < start) continue;
      ctx.save();
      ctx.strokeStyle = isW ? '#2fe08a' : '#ff6666'; ctx.lineWidth = 1.8;
      ctx.shadowColor = isW ? 'rgba(47,224,138,.6)' : 'rgba(255,102,102,.6)'; ctx.shadowBlur = 6;
      ctx.beginPath(); ctx.arc(x(pi), y(pt.price), 7, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    }
    // Flecha en la vela de ruptura
    if (p.breakIdx != null && p.breakIdx + offset >= start) {
      const bi = p.breakIdx + offset;
      ctx.fillStyle = '#ffbe3c'; ctx.font = '900 13px Inter,system-ui'; ctx.textAlign = 'center';
      ctx.fillText(isW ? '▲' : '▼', x(bi), y(k.c[bi]) + (isW ? 18 : -12));
      ctx.textAlign = 'left';
    }
    hline(p.target, '#2fe08a', [2, 3], 'objetivo ' + fmtPrice(p.target).replace('$', ''));
    hline(p.stop, '#ff6666', [2, 3], 'stop ' + fmtPrice(p.stop).replace('$', ''));
  } else {
    // Sin patrón: niveles ATR de referencia
    const atrPct = row.atr1h && row.price ? row.atr1h / row.price : null;
    if (atrPct) {
      const sc = scoreSymbol(row);
      const dir = sc.longScore >= sc.shortScore ? 1 : -1;
      const stopAtr = row.price * (1 - dir * atrPct * 1.2), tpAtr = row.price * (1 + dir * atrPct * 1.8);
      hline(stopAtr, '#ff6666', [2, 3], 'stop ATR ' + fmtPrice(stopAtr).replace('$', ''));
      hline(tpAtr, '#2fe08a', [2, 3], 'TP ATR ' + fmtPrice(tpAtr).replace('$', ''));
    }
  }

  // Niveles del patrón 1h: la estructura vive en velas de 1h, así que aquí solo
  // se proyectan sus PRECIOS (cuello violeta, objetivo/stop punteados) sobre el 15m
  if (p1h) {
    const inR = v => v >= min && v <= max;
    if (inR(p1h.neckline)) hline(p1h.neckline, '#c9a2ff', [6, 3], 'cuello 1h ' + fmtPrice(p1h.neckline).replace('$', ''));
    if (inR(p1h.target))   hline(p1h.target,   '#7fe0b0', [2, 4], 'obj 1h ' + fmtPrice(p1h.target).replace('$', ''));
    if (inR(p1h.stop))     hline(p1h.stop,     '#ff9a9a', [2, 4], 'stop 1h ' + fmtPrice(p1h.stop).replace('$', ''));
  }

  // Último precio
  hline(k.c[k.c.length - 1], '#c8d8ff', [1, 2], fmtPrice(k.c[k.c.length - 1]).replace('$', ''));

  // ── Pintar todas las etiquetas: chips apilados a la derecha, sin taparse ──
  _labels.sort((a, b) => y(a.v) - y(b.v));
  ctx.font = '700 9px Inter,system-ui';
  let sy = PADT - 15;
  for (const L2 of _labels) {
    const ly0 = y(L2.v);
    let ly = Math.max(ly0, sy + 14);
    ly = Math.min(ly, H - PADB - 3);
    sy = ly;
    const tw = ctx.measureText(L2.label).width;
    const x0 = W - tw - 10; // chip alineado al borde derecho
    // conector desde la línea hasta el chip
    ctx.strokeStyle = L2.color; ctx.globalAlpha = 0.5; ctx.lineWidth = 0.8;
    ctx.beginPath(); ctx.moveTo(W - PADR, ly0); ctx.lineTo(x0 - 2, ly); ctx.stroke();
    ctx.globalAlpha = 1;
    // chip con fondo
    ctx.fillStyle = 'rgba(4,6,10,0.95)';
    ctx.fillRect(x0 - 2, ly - 7, tw + 9, 14);
    ctx.strokeStyle = L2.color; ctx.globalAlpha = 0.4; ctx.lineWidth = 1;
    ctx.strokeRect(x0 - 2, ly - 7, tw + 9, 14);
    ctx.globalAlpha = 1;
    ctx.fillStyle = L2.color; ctx.textAlign = 'left';
    ctx.fillText(L2.label, x0 + 2, ly + 3);
  }
}

// ── Interacción: clic en cualquier fila abre el panel ───────────────────────
(function initDetail() {
  const tbody = document.getElementById('tbody');
  if (tbody) {
    tbody.addEventListener('click', e => {
      if (e.target.closest('.star') || e.target.closest('.row-radar') || e.target.closest('.pat-badge')) return;
      const tr = e.target.closest('tr[data-sym]');
      if (tr) openDetail(tr.dataset.sym);
    });
  }
  window.addEventListener('keydown', e => { if (e.key === 'Escape') closeDetail(); });
})();
