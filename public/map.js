/* public/map.js
 * Mapa de momentum (bubble chart): dibujo en canvas, zoom/pan/hover/click,
 * colapsar/redimensionar, y render de la pestaña Estrategia (cards top-5).
 * Requiere core.js y screener.js cargados antes.
 */

// ── Bubble chart ───────────────────────────────────────────────────────────
function pillRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

function drawBubbleChart(scored) {
  if (scored) chartScoredCache = scored;
  if (!chartScoredCache) return;

  const canvas = document.getElementById('bubble-chart');
  const section = document.getElementById('chart-section');
  if (!canvas || !section) return;

  const W = section.clientWidth - 32;
  const H = section.clientHeight - 42;
  if (W < 50 || H < 30) return; // mapa oculto o colapsado
  if (canvas.width !== W) canvas.width = W;
  if (canvas.height !== H) canvas.height = H;

  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);

  const TF_FIELDS = {
    '15m': { oiKey: 'oi15m',  priceKey: 'price15mPct', label: '15m' },
    '1h':  { oiKey: 'oi1h',   priceKey: 'price1hPct',  label: '1h'  },
    '4h':  { oiKey: 'oi4h',   priceKey: 'price4hPct',  label: '4h'  },
    '1d':  { oiKey: 'oi24h',  priceKey: 'price24hPct', label: '24h' },
  };
  const tf = TF_FIELDS[chartTf] || TF_FIELDS['1h'];

  let valid = chartScoredCache.filter(d => d[tf.oiKey] != null && d[tf.priceKey] != null);
  if (minTurnover > 0) valid = valid.filter(d => (d.turnover24h ?? Infinity) >= minTurnover);
  if (!valid.length) return;

  // ── Normalización σ: cada eje dividido por la volatilidad PROPIA del símbolo
  //    (precio / su ATR%; OI / σ de sus propios cambios de OI) para que un +5%
  //    en un meme no pese lo mismo que un +5% en BTC. Fallback: σ transversal.
  const _std = arr => { if (!arr.length) return 0; const m = arr.reduce((a,b)=>a+b,0)/arr.length; return Math.sqrt(arr.reduce((a,b)=>a+(b-m)**2,0)/arr.length); };
  const crossStdX = Math.max(_std(valid.map(d => d[tf.oiKey])), 0.05);
  const crossStdY = Math.max(_std(valid.map(d => d[tf.priceKey])), 0.05);
  const _tfHours  = ({ '15m': 0.25, '1h': 1, '4h': 4, '1d': 24 })[chartTf] || 1;
  const atrPctTf  = d => (d.atr1h && d.price) ? (d.atr1h / d.price * 100) * Math.sqrt(_tfHours) : null;
  const xVal = d => chartNorm ? d[tf.oiKey]    / Math.max(oiSigma(d.symbol, chartTf) ?? crossStdX, 0.01) : d[tf.oiKey];
  const yVal = d => chartNorm ? d[tf.priceKey] / Math.max(atrPctTf(d) ?? crossStdY, 0.05)               : d[tf.priceKey];

  // ── Modo "solo outliers": oculta la nube del centro ──────────────────────
  if (outliersOnly) {
    const dOf = d => Math.hypot(d[tf.oiKey] / crossStdX, d[tf.priceKey] / crossStdY);
    const filtered = valid.filter(d => dOf(d) >= 1.2);
    if (filtered.length) valid = filtered;
  }

  const PAD = { top: 18, right: 22, bottom: 34, left: 52 };
  const pW = W - PAD.left - PAD.right;
  const pH = H - PAD.top - PAD.bottom;

  const xs = valid.map(xVal);
  const ys = valid.map(yVal);
  const xMax = Math.max(Math.abs(Math.min(...xs)), Math.abs(Math.max(...xs)), chartNorm ? 0.5 : 1) * 1.12;
  const yMax = Math.max(Math.abs(Math.min(...ys)), Math.abs(Math.max(...ys)), 0.5) * 1.12;

  const toX = v => PAD.left + (v + xMax) / (2 * xMax) * pW;
  const toY = v => PAD.top + pH - (v + yMax) / (2 * yMax) * pH;
  const ox = toX(0), oy = toY(0);

  const z = chartZoom;
  const s = z.scale;

  ctx.save();
  ctx.setTransform(s, 0, 0, s, z.offsetX, z.offsetY);

  // ── Background fill ──────────────────────────────────────────────────────
  ctx.fillStyle = '#06080b';
  ctx.fillRect(PAD.left, PAD.top, pW, pH);

  // Grid alineado con ticks
  const nX = 4, nY = 4;
  ctx.strokeStyle = 'rgba(255,255,255,0.025)';
  ctx.lineWidth = 1 / s;
  for (let i = -nX; i <= nX; i++) {
    if (i === 0) continue;
    const x = toX((i / nX) * xMax);
    ctx.beginPath(); ctx.moveTo(x, PAD.top); ctx.lineTo(x, PAD.top + pH); ctx.stroke();
  }
  for (let i = -nY; i <= nY; i++) {
    if (i === 0) continue;
    const y = toY((i / nY) * yMax);
    ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(PAD.left + pW, y); ctx.stroke();
  }

  // ── Quadrant shading with radial gradients ───────────────────────────────
  // Q1: top-right — green glow
  const gQ1 = ctx.createRadialGradient(PAD.left + pW, PAD.top, 0, PAD.left + pW, PAD.top, Math.max(pW, pH) * 0.7);
  gQ1.addColorStop(0, 'rgba(0,180,100,0.10)');
  gQ1.addColorStop(1, 'rgba(0,180,100,0)');
  ctx.fillStyle = gQ1;
  ctx.fillRect(ox, PAD.top, pW - (ox - PAD.left), oy - PAD.top);

  // Q4: bottom-right — red glow
  const gQ4 = ctx.createRadialGradient(PAD.left + pW, PAD.top + pH, 0, PAD.left + pW, PAD.top + pH, Math.max(pW, pH) * 0.7);
  gQ4.addColorStop(0, 'rgba(200,40,40,0.09)');
  gQ4.addColorStop(1, 'rgba(200,40,40,0)');
  ctx.fillStyle = gQ4;
  ctx.fillRect(ox, oy, pW - (ox - PAD.left), pH - (oy - PAD.top));

  // Q2: top-left — blue glow
  const gQ2 = ctx.createRadialGradient(PAD.left, PAD.top, 0, PAD.left, PAD.top, Math.max(pW, pH) * 0.5);
  gQ2.addColorStop(0, 'rgba(30,140,200,0.07)');
  gQ2.addColorStop(1, 'rgba(30,140,200,0)');
  ctx.fillStyle = gQ2;
  ctx.fillRect(PAD.left, PAD.top, ox - PAD.left, oy - PAD.top);

  // Q3: bottom-left — dark red glow
  const gQ3 = ctx.createRadialGradient(PAD.left, PAD.top + pH, 0, PAD.left, PAD.top + pH, Math.max(pW, pH) * 0.5);
  gQ3.addColorStop(0, 'rgba(150,30,30,0.08)');
  gQ3.addColorStop(1, 'rgba(150,30,30,0)');
  ctx.fillStyle = gQ3;
  ctx.fillRect(PAD.left, oy, ox - PAD.left, pH - (oy - PAD.top));

  // ── Center lines with glow ───────────────────────────────────────────────
  ctx.save();
  ctx.shadowColor = 'rgba(80,140,220,0.2)';
  ctx.shadowBlur = 6 / s;
  ctx.strokeStyle = 'rgba(50,90,150,0.45)';
  ctx.lineWidth = 1 / s;
  ctx.beginPath(); ctx.moveTo(ox, PAD.top); ctx.lineTo(ox, PAD.top + pH); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(PAD.left, oy); ctx.lineTo(PAD.left + pW, oy); ctx.stroke();
  ctx.restore();

  // ── Axis labels ──────────────────────────────────────────────────────────
  ctx.fillStyle = '#304050';
  ctx.font = `500 ${10 / s}px Inter,system-ui`;
  ctx.textAlign = 'center';
  ctx.fillText(chartNorm ? `OI (${tf.label} · σ propia)` : `OI (${tf.label}%)`, W / 2, H - 4 / s);
  ctx.save();
  ctx.translate(13 / s, H / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText(chartNorm ? `Precio (${tf.label} · ×ATR)` : `Precio (${tf.label}%)`, 0, 0);
  ctx.restore();

  // ── Tick marks + escala ───────────────────────────────────────────────────
  ctx.font = `${9 / s}px Inter,system-ui`;
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  const tk = v => v === 0 ? '0' : (v > 0 ? '+' : '') + v.toFixed(1) + (chartNorm ? 'σ' : '%');

  ctx.textAlign = 'center';
  for (let i = -nX; i <= nX; i++) {
    const v = (i / nX) * xMax;
    const x = toX(v);
    ctx.fillText(tk(v), x, PAD.top + pH + 13 / s);
    ctx.strokeStyle = 'rgba(255,255,255,0.07)'; ctx.lineWidth = 0.7 / s;
    ctx.beginPath(); ctx.moveTo(x, PAD.top + pH); ctx.lineTo(x, PAD.top + pH + 4 / s); ctx.stroke();
  }

  ctx.textAlign = 'right';
  for (let i = -nY; i <= nY; i++) {
    const v = (i / nY) * yMax;
    const y = toY(v);
    ctx.fillText(tk(v), PAD.left - 5 / s, y + 3 / s);
    ctx.strokeStyle = 'rgba(255,255,255,0.07)'; ctx.lineWidth = 0.7 / s;
    ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(PAD.left - 4 / s, y); ctx.stroke();
  }

  // ── Estelas de trayectoria (últimos ~30 min) ─────────────────────────────
  for (const d of valid) {
    const trail = bubbleTrails.get(d.symbol);
    if (!trail || trail.length < 2) continue;
    const ptsT = trail.filter(t => t[tf.oiKey] != null && t[tf.priceKey] != null);
    if (ptsT.length < 2) continue;
    const tOiPos = d[tf.oiKey] >= 0, tPrPos = d[tf.priceKey] >= 0;
    const tq = tOiPos && tPrPos ? 'LONG' : tOiPos ? 'SHORT' : tPrPos ? 'SQUEEZE' : 'LIQ';
    if (activeQuadrant && tq !== activeQuadrant) continue;
    const oiDen = chartNorm ? Math.max(oiSigma(d.symbol, chartTf) ?? crossStdX, 0.01) : 1;
    const prDen = chartNorm ? Math.max(atrPctTf(d) ?? crossStdY, 0.05) : 1;
    ctx.save();
    ctx.lineWidth = 1 / s;
    for (let i = 1; i < ptsT.length; i++) {
      const a = ptsT[i - 1], b = ptsT[i];
      const recency = i / ptsT.length; // 0 viejo → 1 reciente
      ctx.globalAlpha = 0.04 + recency * 0.24;
      ctx.strokeStyle = tPrPos ? 'rgba(80,220,160,1)' : 'rgba(255,110,100,1)';
      ctx.beginPath();
      ctx.moveTo(toX(a[tf.oiKey] / oiDen), toY(a[tf.priceKey] / prDen));
      ctx.lineTo(toX(b[tf.oiKey] / oiDen), toY(b[tf.priceKey] / prDen));
      ctx.stroke();
    }
    ctx.restore();
  }
  ctx.globalAlpha = 1;

  // ── Bubbles ──────────────────────────────────────────────────────────────
  bubbleHitTargets = [];
  const labelFs = 9.5 / s;
  ctx.font = `700 ${labelFs}px Inter,system-ui`;

  for (const d of valid) {
    const bx = toX(xVal(d));
    const by = toY(yVal(d));
    let r;
    if      (bubbleSizeMetric === 'oi')      r = Math.min(28, Math.max(5, Math.sqrt((d.oiUSD ?? 0) / 1.5e7) * 4));
    else if (bubbleSizeMetric === 'funding') r = Math.min(26, Math.max(5, Math.abs(d.fundingRate ?? 0) * 2800 + 6));
    else                                     r = Math.min(24, Math.max(5, Math.sqrt(Math.abs(d.vol1hPct ?? 1)) * 1.9));

    const oiPos = d[tf.oiKey] >= 0, pricePos = d[tf.priceKey] >= 0;
    const bQuad = oiPos && pricePos ? 'LONG' : oiPos ? 'SHORT' : pricePos ? 'SQUEEZE' : 'LIQ';
    ctx.globalAlpha = (activeQuadrant && bQuad !== activeQuadrant) ? 0.12 : 1.0;

    // Alineación total: OI 5m+1h+4h positivos + precio 5m+1h+4h en misma dirección + volumen
    const nv = v => v ?? 0;
    const longAligned  = oiPos && pricePos
      && nv(d.oi5m) > 0 && nv(d.oi1h) > 0.2 && nv(d.oi4h) > 0
      && nv(d.price5mPct) > 0 && nv(d.price4hPct) > 0 && nv(d.vol1hPct) > 5;
    const shortAligned = oiPos && !pricePos
      && nv(d.oi5m) > 0 && nv(d.oi1h) > 0.2 && nv(d.oi4h) > 0
      && nv(d.price5mPct) < 0 && nv(d.price4hPct) < 0 && nv(d.vol1hPct) > 5;
    const aligned = longAligned || shortAligned;

    let fillC, strokeC, glowC, labelC;
    if (oiPos && pricePos) {
      if (longAligned) { fillC='rgba(0,230,145,0.85)'; strokeC='rgba(80,255,190,1)';   glowC='rgba(0,255,170,0.80)'; labelC='#ccffee'; }
      else             { fillC='rgba(0,120,75,0.28)';  strokeC='rgba(0,180,110,0.40)'; glowC='rgba(0,180,110,0.12)'; labelC='#4a9970'; }
    } else if (oiPos) {
      if (shortAligned){ fillC='rgba(255,45,45,0.85)'; strokeC='rgba(255,110,110,1)';  glowC='rgba(255,60,60,0.80)'; labelC='#ffdddd'; }
      else             { fillC='rgba(160,35,35,0.28)'; strokeC='rgba(220,70,70,0.40)'; glowC='rgba(200,50,50,0.12)'; labelC='#aa6060'; }
    } else if (pricePos){ fillC='rgba(20,100,140,0.28)'; strokeC='rgba(40,160,200,0.40)'; glowC='rgba(30,150,200,0.12)'; labelC='#5090aa'; }
    else               { fillC='rgba(100,20,20,0.28)';  strokeC='rgba(170,45,45,0.40)'; glowC='rgba(160,40,40,0.10)'; labelC='#886060'; }

    // Outer glow
    ctx.save();
    ctx.shadowColor = glowC;
    ctx.shadowBlur = (aligned ? r * 2.8 : r * 0.8) / s;
    ctx.beginPath(); ctx.arc(bx, by, r, 0, Math.PI * 2);
    ctx.fillStyle = fillC; ctx.fill();
    ctx.restore();

    // Stroke
    ctx.beginPath(); ctx.arc(bx, by, r, 0, Math.PI * 2);
    ctx.strokeStyle = strokeC; ctx.lineWidth = 1 / s; ctx.stroke();

    // Anillo de funding extremo: naranja = longs pagando, violeta = shorts pagando
    const _fr = d.fundingRate ?? 0;
    if (Math.abs(_fr) >= 0.03) {
      ctx.save();
      ctx.setLineDash([3 / s, 3 / s]);
      ctx.strokeStyle = _fr > 0 ? 'rgba(255,170,40,0.85)' : 'rgba(170,110,255,0.85)';
      ctx.lineWidth = 1.2 / s;
      ctx.beginPath(); ctx.arc(bx, by, r + 3.5 / s, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    }

    // Inner highlight
    const hl = ctx.createRadialGradient(bx - r * 0.35, by - r * 0.35, 0, bx, by, r);
    hl.addColorStop(0, 'rgba(255,255,255,0.18)');
    hl.addColorStop(0.5, 'rgba(255,255,255,0.04)');
    hl.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.beginPath(); ctx.arc(bx, by, r, 0, Math.PI * 2);
    ctx.fillStyle = hl; ctx.fill();

    // Label pill
    const label = d.symbol;
    const tw = ctx.measureText(label).width;
    const lx = bx;
    const ly = by - r - 4 / s;
    const pH2 = labelFs + 5 / s;
    const pW2 = tw + 10 / s;
    const pr  = 3 / s;

    ctx.save();
    ctx.shadowColor = glowC;
    ctx.shadowBlur = 4 / s;
    pillRect(ctx, lx - pW2 / 2, ly - pH2 + 1/s, pW2, pH2, pr);
    ctx.fillStyle = 'rgba(5,7,11,0.90)'; ctx.fill();
    ctx.strokeStyle = strokeC.replace('0.80', '0.35'); ctx.lineWidth = 0.6 / s; ctx.stroke();
    ctx.restore();

    ctx.fillStyle = labelC;
    ctx.textAlign = 'center';
    ctx.fillText(label, lx, ly);

    // Flecha de aceleración OI (oi5m acelerando vs oi15m normalizado)
    const accel = (d.oi5m != null && d.oi15m != null) ? d.oi5m - d.oi15m / 3 : 0;
    if (Math.abs(accel) > 0.08) {
      ctx.save();
      ctx.globalAlpha = Math.min(0.95, Math.abs(accel) * 4);
      ctx.fillStyle = accel > 0 ? '#55ee99' : '#ff6655';
      ctx.font = `900 ${9/s}px Inter,system-ui`;
      ctx.textAlign = 'center';
      ctx.shadowColor = accel > 0 ? 'rgba(80,255,150,0.6)' : 'rgba(255,80,60,0.6)';
      ctx.shadowBlur = 6/s;
      ctx.fillText(accel > 0 ? '▲' : '▼', bx + r * 0.62, by - r * 0.62);
      ctx.restore();
    }

    // Anillo exterior para burbujas totalmente alineadas
    if (aligned) {
      ctx.save();
      ctx.shadowColor = glowC;
      ctx.shadowBlur = 14 / s;
      ctx.strokeStyle = strokeC;
      ctx.lineWidth = 1.4 / s;
      ctx.globalAlpha = 0.55;
      ctx.beginPath(); ctx.arc(bx, by, r + 6 / s, 0, Math.PI * 2); ctx.stroke();
      ctx.globalAlpha = 0.25;
      ctx.beginPath(); ctx.arc(bx, by, r + 11 / s, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    }

    bubbleHitTargets.push({ symbol: d.symbol, bx, by, r });
  }

  ctx.globalAlpha = 1.0;

  // ── Hover ring (dibujado encima de todas las burbujas) ────────────────────
  if (hoveredSymbol) {
    const hb = bubbleHitTargets.find(b => b.symbol === hoveredSymbol);
    if (hb) {
      const pulse = (Math.sin(Date.now() * 0.005) + 1) / 2; // 0..1 ~1.25Hz
      ctx.save();
      // Anillo interior fijo — blanco brillante
      ctx.shadowColor = 'rgba(255,255,255,0.75)';
      ctx.shadowBlur  = 18 / s;
      ctx.strokeStyle = 'rgba(255,255,255,0.95)';
      ctx.lineWidth   = 2 / s;
      ctx.beginPath(); ctx.arc(hb.bx, hb.by, hb.r + 5 / s, 0, Math.PI * 2); ctx.stroke();
      // Anillo exterior pulsante
      ctx.globalAlpha = 0.2 + pulse * 0.4;
      ctx.shadowBlur  = 0;
      ctx.strokeStyle = 'rgba(255,255,255,0.7)';
      ctx.lineWidth   = 1.5 / s;
      ctx.beginPath(); ctx.arc(hb.bx, hb.by, hb.r + 10 / s + pulse * 7 / s, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    }
  }

  // ── Quadrant badges with stats (drawn on top of bubbles) ─────────────────
  badgeHitTargets = [];
  const _q1 = valid.filter(d => d[tf.oiKey] >= 0 && d[tf.priceKey] >= 0);
  const _q2 = valid.filter(d => d[tf.oiKey] <  0 && d[tf.priceKey] >= 0);
  const _q3 = valid.filter(d => d[tf.oiKey] <  0 && d[tf.priceKey] <  0);
  const _q4 = valid.filter(d => d[tf.oiKey] >= 0 && d[tf.priceKey] <  0);
  const _qavg = (arr, k) => arr.length ? arr.reduce((a, b) => a + (b[k] || 0), 0) / arr.length : 0;
  const _fmtA = v => (v >= 0 ? '+' : '') + v.toFixed(2) + '%';

  const _qDefs = [
    { data: _q1, label: 'LONG',    dir: 'OI↑  P↑', rgb: '0,210,130',  px: PAD.left+pW-6/s, py: PAD.top+8/s,    ax:'right', ay:'top'    },
    { data: _q2, label: 'SQUEEZE', dir: 'OI↓  P↑', rgb: '50,185,235', px: PAD.left+6/s,    py: PAD.top+8/s,    ax:'left',  ay:'top'    },
    { data: _q3, label: 'LIQ',     dir: 'OI↓  P↓', rgb: '210,70,70',  px: PAD.left+6/s,    py: PAD.top+pH-8/s, ax:'left',  ay:'bottom' },
    { data: _q4, label: 'SHORT',   dir: 'OI↑  P↓', rgb: '255,90,90',  px: PAD.left+pW-6/s, py: PAD.top+pH-8/s, ax:'right', ay:'bottom' },
  ];

  const _lfs = 10/s, _sfs = 8.5/s, _lp = 6/s;

  for (const q of _qDefs) {
    const oiA = _qavg(q.data, 'oi1h');
    const prA = _qavg(q.data, 'price1hPct');
    const cnt = q.data.length;
    const ln1 = `${q.dir}  ${q.label}`;
    const ln2 = `OI ${_fmtA(oiA)}   P ${_fmtA(prA)}`;
    const ln3 = `${cnt} símbolos`;

    ctx.font = `700 ${_lfs}px Inter,system-ui`;
    const w1 = ctx.measureText(ln1).width;
    ctx.font = `500 ${_sfs}px Inter,system-ui`;
    const w2 = Math.max(ctx.measureText(ln2).width, ctx.measureText(ln3).width);

    const boxW = Math.max(w1, w2) + _lp * 2.4;
    const boxH = _lfs + _sfs * 2 + _lp * 2.2;
    const bx = q.ax === 'right' ? q.px - boxW : q.px;
    const by = q.ay === 'bottom' ? q.py - boxH : q.py;

    badgeHitTargets.push({ quad: q.label, bx, by, boxW, boxH });
    const isActiveQ = activeQuadrant === q.label;

    ctx.save();
    pillRect(ctx, bx, by, boxW, boxH, 4/s);
    ctx.fillStyle   = `rgba(${q.rgb},${isActiveQ ? 0.30 : 0.18})`;
    ctx.fill();
    ctx.strokeStyle = `rgba(${q.rgb},${isActiveQ ? 0.85 : 0.45})`;
    ctx.lineWidth   = (isActiveQ ? 1.5 : 0.8) / s;
    ctx.stroke();
    ctx.restore();

    const tx = q.ax === 'right' ? q.px - _lp : q.px + _lp;
    ctx.textAlign = q.ax === 'right' ? 'right' : 'left';

    ctx.font      = `700 ${_lfs}px Inter,system-ui`;
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.fillText(ln1, tx, by + _lfs + _lp * 0.5);

    ctx.font      = `500 ${_sfs}px Inter,system-ui`;
    ctx.fillStyle = 'rgba(255,255,255,0.70)';
    ctx.fillText(ln2, tx, by + _lfs + _sfs + _lp * 1.1);

    ctx.fillStyle = 'rgba(255,255,255,0.38)';
    ctx.fillText(ln3, tx, by + _lfs + _sfs * 2 + _lp * 1.65);
  }

  ctx.restore();
}

// ── Radar de confluencia: todo el módulo vive en /radar.js ─────────────────



// ── Strategy render ────────────────────────────────────────────────────────
function setChartTf(tf) {
  chartTf = tf;
  document.querySelectorAll('.chart-tf-btn[data-tf]').forEach(b =>
    b.classList.toggle('active', b.dataset.tf === tf)
  );
  chartZoom = { scale: 1, offsetX: 0, offsetY: 0 };
  drawBubbleChart(null);
  render(); // los mini-gráficos de la tabla siguen la misma temporalidad
}

function renderStrategy() {
  if (!allRows.length) return;
  const scored = allRows.map(r => ({ ...r, ...scoreSymbol(r) }));
  // Los Top-5 de momentum se retiraron: duplicaban la tabla del screener
  // ordenada por score y las "Señales accionables" del Lab (que además llevan
  // evidencia histórica y niveles). Estrategia queda enfocada: radar + potencial.
  renderConfluence(scored);
  renderIndConf(); // 🧭 confluencia de indicadores (RSI/MACD/ADX/TSI/Andean, 15m)
}

// El mapa vive ahora en la página del screener — se dibuja con cada refresh
function renderMap() {
  if (!allRows.length) return;
  const scored = allRows.map(r => ({ ...r, ...scoreSymbol(r) }));
  drawBubbleChart(scored);
}

// ── Bubble chart interactions (zoom, pan, click) ───────────────────────────
(function () {
  const canvas = document.getElementById('bubble-chart');
  let dragging = false, dragDist = 0, lastX = 0, lastY = 0;

  canvas.addEventListener('wheel', function (e) {
    e.preventDefault();
    const rect = this.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.22 : 0.82;
    const ns = Math.max(0.35, Math.min(20, chartZoom.scale * factor));
    // Zoom centered on mouse: keep the point under cursor fixed
    chartZoom.offsetX = mx * (1 - ns / chartZoom.scale) + chartZoom.offsetX * (ns / chartZoom.scale);
    chartZoom.offsetY = my * (1 - ns / chartZoom.scale) + chartZoom.offsetY * (ns / chartZoom.scale);
    chartZoom.scale = ns;
    drawBubbleChart(null);
  }, { passive: false });

  canvas.addEventListener('mousedown', function (e) {
    dragging = true; dragDist = 0;
    lastX = e.clientX; lastY = e.clientY;
    this.style.cursor = 'grabbing';
  });

  canvas.addEventListener('mousemove', function (e) {
    const rect = this.getBoundingClientRect();
    if (dragging) {
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      dragDist += Math.abs(dx) + Math.abs(dy);
      chartZoom.offsetX += dx; chartZoom.offsetY += dy;
      lastX = e.clientX; lastY = e.clientY;
      drawBubbleChart(null);
      return;
    }
    const mx = (e.clientX - rect.left - chartZoom.offsetX) / chartZoom.scale;
    const my = (e.clientY - rect.top  - chartZoom.offsetY) / chartZoom.scale;
    let closest = null, minDist = Infinity;
    for (const b of bubbleHitTargets) {
      const ddx = mx - b.bx, ddy = my - b.by;
      const d = Math.sqrt(ddx*ddx + ddy*ddy);
      if (d <= b.r + 10/chartZoom.scale && d < minDist) { minDist = d; closest = b; }
    }
    // Hover animation
    const newSym = closest ? closest.symbol : null;
    if (newSym !== hoveredSymbol) {
      hoveredSymbol = newSym;
      if (hoveredSymbol && !hoverAnimFrame) {
        const animLoop = () => {
          drawBubbleChart(null);
          hoverAnimFrame = hoveredSymbol ? requestAnimationFrame(animLoop) : null;
        };
        hoverAnimFrame = requestAnimationFrame(animLoop);
      }
    }

    const tip = document.getElementById('btip');
    if (closest) {
      const row = allRows.find(r => r.symbol === closest.symbol);
      if (row) {
        tip.innerHTML = buildTooltip(row);
        tip.style.display = 'block';
        const tipW = 186;
        tip.style.left = (e.clientX + tipW + 14 > window.innerWidth ? e.clientX - tipW - 6 : e.clientX + 14) + 'px';
        tip.style.top  = Math.min(e.clientY - 10, window.innerHeight - 290) + 'px';
      }
    } else {
      tip.style.display = 'none';
    }
  });

  canvas.addEventListener('mouseup', function (e) {
    const wasDrag = dragDist > 5;
    dragging = false;
    this.style.cursor = 'crosshair';
    if (wasDrag) return;
    const rect = this.getBoundingClientRect();
    const mx = (e.clientX - rect.left  - chartZoom.offsetX) / chartZoom.scale;
    const my = (e.clientY - rect.top   - chartZoom.offsetY) / chartZoom.scale;
    // Badge click → toggle quadrant filter (sincroniza mapa + tabla)
    for (const b of badgeHitTargets) {
      if (mx >= b.bx && mx <= b.bx + b.boxW && my >= b.by && my <= b.by + b.boxH) {
        toggleQuadFilter(b.quad);
        return;
      }
    }
    // Bubble click → resalta la fila en la tabla + prepara radar de confluencia
    for (const b of bubbleHitTargets) {
      const dx = mx - b.bx, dy = my - b.by;
      if (Math.sqrt(dx * dx + dy * dy) <= b.r + 6 / chartZoom.scale) {
        selectConfSymbol(b.symbol);
        document.querySelectorAll('.sc-card').forEach(c => c.classList.remove('highlighted'));
        const card = document.querySelector(`.sc-card[data-sym="${b.symbol}"]`);
        if (card) card.classList.add('highlighted');
        highlightScreenerRow(b.symbol);
        return;
      }
    }
  });

  canvas.addEventListener('mouseleave', function () {
    dragging = false; this.style.cursor = 'crosshair';
    document.getElementById('btip').style.display = 'none';
    hoveredSymbol = null;
    drawBubbleChart(null);
  });

  canvas.addEventListener('dblclick', function () {
    chartZoom = { scale: 1, offsetX: 0, offsetY: 0 };
    drawBubbleChart(null);
  });
})();

window.addEventListener('resize', () => {
  if (activeTab === 'screener') drawBubbleChart(null);
});

// ── Mapa en el screener: colapsar, redimensionar y localizar filas ─────────
function toggleMap() {
  const tab = document.getElementById('screener-tab');
  const collapsed = tab.classList.toggle('map-collapsed');
  safeSetItem('scalp_map_collapsed', collapsed ? '1' : '0');
  document.getElementById('map-toggle-btn').textContent = collapsed ? '▸ Mapa' : '▾ Mapa';
  if (!collapsed) requestAnimationFrame(() => drawBubbleChart(null));
}

function highlightScreenerRow(sym) {
  const tr = document.querySelector(`#tbody tr[data-sym="${sym}"]`);
  if (!tr) return;
  tr.scrollIntoView({ behavior: 'smooth', block: 'center' });
  tr.classList.add('row-flash');
  setTimeout(() => tr.classList.remove('row-flash'), 2500);
}

(function initMapUI() {
  const tab = document.getElementById('screener-tab');
  const cs  = document.getElementById('chart-section');
  const rz  = document.getElementById('map-resizer');
  if (localStorage.getItem('scalp_map_collapsed') === '1') {
    tab.classList.add('map-collapsed');
    document.getElementById('map-toggle-btn').textContent = '▸ Mapa';
  }
  const savedH = parseInt(localStorage.getItem('scalp_map_h') || '0', 10);
  if (savedH >= 160) cs.style.height = savedH + 'px';

  let resizing = false, startY = 0, startH = 0;
  rz.addEventListener('mousedown', e => {
    resizing = true; startY = e.clientY; startH = cs.clientHeight;
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });
  window.addEventListener('mousemove', e => {
    if (!resizing) return;
    const h = Math.max(160, Math.min(window.innerHeight * 0.75, startH + e.clientY - startY));
    cs.style.height = h + 'px';
    drawBubbleChart(null);
  });
  window.addEventListener('mouseup', () => {
    if (!resizing) return;
    resizing = false;
    document.body.style.userSelect = '';
    safeSetItem('scalp_map_h', String(cs.clientHeight));
  });
})();
