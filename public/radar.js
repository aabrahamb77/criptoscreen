/* public/radar.js
 * Módulo del RADAR DE CONFLUENCIA + extras del mapa de momentum.
 * Se carga DESPUÉS de lxr.js y ANTES del script principal de index.html.
 * Comparte el scope global con el script principal (helpers como fmtPct,
 * detectRegime, timeframeAlignment, showToast… se resuelven en runtime).
 *
 * Contiene:
 *  - estado del radar (normalización σ, outliers, estelas, filtro liquidez)
 *  - motor de confluencia (checklist de 7 señales)
 *  - CALIBRACIÓN: registra señales ≥5/7 y mide win-rate real a +30m/+1h,
 *    por nivel (5/6/7) y por check individual (ablación)
 *  - paneles: radar, detalle + bot, WR por cuadrante, cruces, alineación 4TF
 *  - countdown de funding, σ de OI por símbolo, estelas
 */

// ── Estado ──────────────────────────────────────────────────────────────────
let chartNorm     = false;      // ejes normalizados por volatilidad propia (σ/ATR)
let outliersOnly  = false;      // ocultar la nube del centro
let minTurnover   = 0;          // filtro de liquidez (turnover 24h USD)
let bubbleTrails  = new Map();  // symbol → [{ts, oi15m..oi24h, price15mPct..price24hPct}]
let selectedBubble = null;      // símbolo seleccionado para el panel de detalle
let confCache     = new Map();  // symbol → resultado de confluencia del último render
let prevConfCount = new Map();  // symbol → count anterior (para alertar al llegar a ≥6)
let _oiSigCache   = new Map();  // symbol|tf → σ de cambios de OI (se limpia en cada load)
let _botStatsCache = { ts: 0, data: null };
let _qwrCache     = { ts: 0, html: '' };

// ── Calibración del radar: señales registradas y su resultado ──────────────
const CONF_CHECK_NAMES   = ['Outlier', 'Sesgo global', 'Multi-TF', 'CVD+funding', 'Régimen', 'Liquidez', 'Riesgo'];
const CONF_SIG_MIN_COUNT = 5;            // se registra como señal a partir de 5/7
const CONF_SIG_COOLDOWN  = 60 * 60_000;  // máx. 1 señal/h por símbolo+lado
const CONF_SIG_MAX       = 2000;
let confSignals  = JSON.parse(localStorage.getItem('scalp_confsig2') || '[]');
let confCalibOpen = false;

function saveConfSignals() {
  if (confSignals.length > CONF_SIG_MAX) confSignals = confSignals.slice(-CONF_SIG_MAX);
  try { localStorage.setItem('scalp_confsig2', JSON.stringify(confSignals)); } catch (_) {}
  if (typeof syncToServer === 'function') syncToServer();
}

// ── σ de cambios de OI por símbolo (desde oiSnaps, cadencia ~1min) ─────────
function oiSigma(symbolNoUSDT, tfKey) {
  const key = symbolNoUSDT + '|' + tfKey;
  if (_oiSigCache.has(key)) return _oiSigCache.get(key);
  const snaps = oiSnaps.get(symbolNoUSDT + 'USDT') || [];
  const stepN = ({ '15m': 15, '1h': 60, '4h': 240, '1d': 1440 })[tfKey] || 60; // índices ≈ minutos
  const vals = [];
  for (let i = 0; i + stepN < snaps.length && vals.length < 24; i += stepN) {
    const a = snaps[i].oiUSD, b = snaps[i + stepN].oiUSD;
    if (b > 0) vals.push((a - b) / b * 100);
  }
  let sig = null;
  if (vals.length >= 5) {
    const m = vals.reduce((x, y) => x + y, 0) / vals.length;
    sig = Math.sqrt(vals.reduce((x, y) => x + (y - m) ** 2, 0) / vals.length);
  }
  _oiSigCache.set(key, sig);
  return sig;
}

// ── Estelas: registrar posición de cada símbolo en cada ciclo (~1/min) ─────
function recordTrails(rows) {
  const now = Date.now();
  for (const r of rows) {
    if (!bubbleTrails.has(r.symbol)) bubbleTrails.set(r.symbol, []);
    const arr = bubbleTrails.get(r.symbol);
    const last = arr[arr.length - 1];
    if (last && now - last.ts < 50_000) continue;
    arr.push({ ts: now, oi15m: r.oi15m, oi1h: r.oi1h, oi4h: r.oi4h, oi24h: r.oi24h,
      price15mPct: r.price15mPct, price1hPct: r.price1hPct, price4hPct: r.price4hPct, price24hPct: r.price24hPct });
    while (arr.length && now - arr[0].ts > 35 * 60_000) arr.shift();
    if (arr.length > 40) arr.shift();
  }
}

// ── Toggles del mapa ────────────────────────────────────────────────────────
function toggleChartNorm() {
  chartNorm = !chartNorm;
  document.getElementById('norm-btn').classList.toggle('active', chartNorm);
  drawBubbleChart(null);
}
function toggleOutliers() {
  outliersOnly = !outliersOnly;
  document.getElementById('outliers-btn').classList.toggle('active', outliersOnly);
  drawBubbleChart(null);
}
function setMinTurnover(v) { minTurnover = +v || 0; drawBubbleChart(null); }

// ── Countdown al settlement de funding (00/08/16 UTC) ──────────────────────
function updateFundingCd() {
  const el = document.getElementById('funding-cd');
  if (!el) return;
  const now = new Date();
  const h = now.getUTCHours();
  const nextH = h < 8 ? 8 : h < 16 ? 16 : 24; // Date.UTC normaliza 24 → 00 del día siguiente
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), nextH);
  let sLeft = Math.max(0, Math.floor((next - now.getTime()) / 1000));
  const hh = String(Math.floor(sLeft / 3600)).padStart(2, '0');
  const mm = String(Math.floor(sLeft % 3600 / 60)).padStart(2, '0');
  const ss = String(sLeft % 60).padStart(2, '0');
  el.textContent = `⏳ funding ${hh}:${mm}:${ss}`;
  el.classList.toggle('soon', sLeft <= 30 * 60);
}
setInterval(updateFundingCd, 1000);
updateFundingCd();

// ── Notificaciones de escritorio (solo con la pestaña en segundo plano) ────
let desktopNotif = localStorage.getItem('scalp_notif') === '1';
function _syncNotifBtn() {
  const b = document.getElementById('notif-btn');
  if (!b) return;
  b.textContent = desktopNotif ? '🔔🖥' : '🖥';
  b.classList.toggle('snd-on', desktopNotif);
  b.title = desktopNotif ? 'Notificaciones de escritorio ON' : 'Notificaciones de escritorio OFF';
}
function toggleDesktopNotif() {
  if (!('Notification' in window)) { showToast('Este navegador no soporta notificaciones'); return; }
  if (!desktopNotif && Notification.permission !== 'granted') {
    Notification.requestPermission().then(p => {
      if (p === 'granted') {
        desktopNotif = true;
        localStorage.setItem('scalp_notif', '1');
        _syncNotifBtn();
        showToast('🖥 Notificaciones de escritorio activadas');
      } else showToast('Permiso de notificaciones denegado');
    });
    return;
  }
  desktopNotif = !desktopNotif;
  localStorage.setItem('scalp_notif', desktopNotif ? '1' : '0');
  _syncNotifBtn();
}
function notifyDesktop(title, body) {
  if (!desktopNotif || !('Notification' in window) || Notification.permission !== 'granted') return;
  if (!document.hidden) return; // con la pestaña visible bastan los toasts
  try { new Notification(title, { body: body || '', tag: 'scalp-' + title }); } catch (_) {}
}
_syncNotifBtn();

// ── Semáforo de riesgo de mercado (0-100) ───────────────────────────────────
// 🟢 <30 opera normal · 🟡 30-59 tamaño reducido, solo setups A+ · 🔴 ≥60 fuera.
// Componentes: volatilidad de BTC (×ATR), cascadas de liquidación, mercado sin
// dirección (chop) y funding estirado en muchos pares a la vez.
function marketRiskLight() {
  const valid = allRows.filter(r => r.oi1h != null && r.price1hPct != null);
  if (valid.length < 10) return null;
  const btc = allRows.find(r => r.symbol === 'BTC');
  let risk = 0;
  const why = [];

  // 1) BTC moviéndose más de lo normal para sí mismo (×ATR 1h) — se calcula
  //    aquí mismo para no depender del orden de render()
  const _btcAtrPct = (btc?.atr1h && btc.price) ? btc.atr1h / btc.price * 100 : null;
  const btcMove = (_btcAtrPct && btc.price1hPct != null) ? btc.price1hPct / _btcAtrPct : null;
  if (btcMove != null) {
    const a = Math.abs(btcMove);
    if      (a >= 2)   { risk += 30; why.push(`BTC ${btcMove.toFixed(1)}×ATR en 1h — movimiento extremo`); }
    else if (a >= 1.2) { risk += 18; why.push(`BTC ${btcMove.toFixed(1)}×ATR en 1h — elevado`); }
    else if (a >= 0.7) { risk += 8; }
  }

  // 2) cascadas de liquidación en el mercado (últimos 5 min)
  const liqTot = (typeof liqLong5m === 'number' ? liqLong5m : 0) + (typeof liqShort5m === 'number' ? liqShort5m : 0);
  if      (liqTot > 20e6) { risk += 30; why.push(`cascada de liquidaciones: ${fmtUSD(liqTot)} en 5m`); }
  else if (liqTot > 5e6)  { risk += 15; why.push(`liquidaciones elevadas: ${fmtUSD(liqTot)} en 5m`); }
  else if (liqTot > 1e6)  { risk += 6; }

  // 3) mercado sin dirección (chop): mitad arriba, mitad abajo
  const up = valid.filter(r => r.price1hPct > 0).length;
  const dirStrength = Math.abs(up / valid.length - 0.5) * 2; // 0 = 50/50 · 1 = unánime
  if      (dirStrength < 0.2) { risk += 20; why.push(`sin dirección: ${up}/${valid.length} pares al alza (chop)`); }
  else if (dirStrength < 0.4) { risk += 10; }

  // 4) apalancamiento estirado: muchos pares con funding extremo
  const stretched = valid.filter(r => Math.abs(r.fundingRate ?? 0) >= 0.05).length;
  if      (stretched >= 15) { risk += 20; why.push(`${stretched} pares con funding extremo — riesgo de squeeze/cascada`); }
  else if (stretched >= 7)  { risk += 10; why.push(`${stretched} pares con funding extremo`); }

  const reg = detectRegime(allRows);
  let dir;
  if (risk >= 60)                      dir = 'FUERA — espera a que pase la tormenta';
  else if (reg.regime === 'ALCISTA')   dir = 'sesgo LONG · continuaciones a favor';
  else if (reg.regime === 'BAJISTA')   dir = 'sesgo SHORT · evita longs en alts';
  else if (reg.regime === 'VOLÁTIL')   dir = 'reversiones (LXR/fades) · tamaño reducido';
  else                                 dir = 'lateral · solo setups A+ (≥6/7) o esperar';
  const level = risk >= 60 ? 'r' : risk >= 30 ? 'a' : 'v';
  return { risk, level, why, dir, regime: reg.regime, up, total: valid.length };
}

function renderRiskLight() {
  const el = document.getElementById('risk-light');
  if (!el) return;
  const m = marketRiskLight();
  if (!m) { el.style.display = 'none'; return; }
  el.style.display = '';
  el.className = 'risk-' + m.level;
  const icon = m.level === 'v' ? '🟢' : m.level === 'a' ? '🟡' : '🔴';
  el.textContent = `${icon} ${m.risk} · ${m.dir}`;
  el.title = `Semáforo de riesgo: ${m.risk}/100 (mercado ${m.regime}, ${m.up}/${m.total} pares al alza)\n` +
    (m.why.length ? '— ' + m.why.join('\n— ') : '— sin factores de riesgo destacados') +
    '\n\n🟢 <30: opera con tamaño normal · 🟡 30-59: tamaño reducido, solo setups claros · 🔴 ≥60: mejor fuera';
}

// ── Puente tabla → radar: abre la moneda en el checklist de confluencia ────
function openInRadar(sym) {
  switchTab('strategy');
  // renderStrategy corre al cambiar de pestaña; esperamos al render del radar
  setTimeout(() => selectConfSymbol(sym), 180);
}

// ── Stats del bot (para el panel de detalle) ───────────────────────────────
async function getBotStats() {
  if (Date.now() - _botStatsCache.ts < 10_000) return _botStatsCache.data;
  if (document.hidden) return _botStatsCache.data; // segundo plano: usa lo último, no gasta ancho de banda
  try {
    const r = await fetch('/api/bot/stats');
    _botStatsCache = { ts: Date.now(), data: r.ok ? await r.json() : null };
  } catch (_) { _botStatsCache = { ts: Date.now(), data: null }; }
  return _botStatsCache.data;
}

// ── Régimen propio fallback (sin trackHistory) a partir de ATR ─────────────
function fallbackSymbolRegime(row) {
  const n = v => v ?? 0;
  const atrPct = row.atr1h && row.price ? row.atr1h / row.price * 100 : null;
  if (atrPct == null || atrPct <= 0) return null;
  if (Math.abs(n(row.price4hPct)) >= atrPct * 2.5) return { regime: n(row.price4hPct) > 0 ? 'RUPTURA ↑' : 'RUPTURA ↓' };
  if (n(row.vol1hPct) > 40 || Math.abs(n(row.price1hPct)) > atrPct * 1.2) return { regime: 'VOLÁTIL' };
  return { regime: 'EN RANGO' };
}

// ── Motor de confluencia: el checklist de 7 señales por símbolo ────────────
function confluenceFor(row, mreg, cross) {
  const n = v => v ?? 0;
  const side = n(row.price1hPct) >= 0 ? 'long' : 'short';
  const quad = n(row.oi1h) >= 0 && n(row.price1hPct) >= 0 ? 'LONG'
             : n(row.oi1h) >= 0 ? 'SHORT' : n(row.price1hPct) >= 0 ? 'SQUEEZE' : 'LIQ';
  const dist = Math.hypot(n(row.oi1h) / cross.stdOi, n(row.price1hPct) / cross.stdPr);
  const al = timeframeAlignment(row);
  const sr = detectSymbolRegime(row.symbol) || fallbackSymbolRegime(row);
  const atrPct = row.atr1h && row.price ? row.atr1h / row.price * 100 : null;
  const cvdOk = side === 'long' ? n(row.cvd5m) > 0 : n(row.cvd5m) < 0;
  const fundAgainst = side === 'long' ? n(row.fundingRate) > 0.05 : n(row.fundingRate) < -0.05;
  let regOk = false;
  if (sr) {
    if (sr.regime === 'RUPTURA ↑') regOk = side === 'long';
    else if (sr.regime === 'RUPTURA ↓') regOk = side === 'short';
    else if (sr.regime === 'VOLÁTIL' || sr.regime === 'EN RANGO') regOk = quad === 'SQUEEZE' || quad === 'LIQ';
    // COMPRIMIDO → esperando ruptura, sin confirmación todavía
  }
  const checks = [
    { k: 'Outlier real',         ok: dist >= 1.5, d: `dist ${dist.toFixed(1)}σ del centro (≥1.5)` },
    { k: 'Sesgo global a favor', ok: (mreg.regime === 'ALCISTA' && side === 'long') || (mreg.regime === 'BAJISTA' && side === 'short'),
      d: `mercado ${mreg.regime} · señal ${side.toUpperCase()}` },
    { k: 'Multi-timeframe',      ok: !!al && al.count >= 3 && ((al.dir === 'up') === (side === 'long')),
      d: al ? `precio ${al.count}/${al.total} ${al.dir === 'up' ? '↑' : '↓'}` : 'sin datos' },
    { k: 'CVD + funding',        ok: cvdOk && !fundAgainst,
      d: `CVD5m ${row.cvd5m == null ? 'sin datos' : (row.cvd5m >= 0 ? '+' : '−') + fmtUSD(Math.abs(row.cvd5m))} · fund ${fmtPct(row.fundingRate) ?? '—'}` },
    { k: 'Régimen apto',         ok: regOk, d: sr ? `${sr.regime} · cuadrante ${quad}` : 'sin historial' },
    { k: 'Liquidez',             ok: n(row.turnover24h) >= 20e6 && n(row.vol1hUSD) >= 500_000,
      d: `24h $${(n(row.turnover24h) / 1e6).toFixed(0)}M · 1h $${(n(row.vol1hUSD) / 1e6).toFixed(1)}M` },
    { k: 'Riesgo definido',      ok: atrPct != null && atrPct > 0,
      d: atrPct ? `stop ~${(atrPct * 1.2).toFixed(2)}% · TP ~${(atrPct * 1.8).toFixed(2)}% (1.5R)` : 'ATR no disponible' },
  ];
  return { symbol: row.symbol, side, quad, dist, checks, count: checks.filter(c => c.ok).length, price: row.price };
}

/** Calcula la confluencia de todas las filas válidas (compartido por el render
 *  y por el registro de señales, para que funcione aunque la pestaña no esté abierta). */
function computeConfluence(rows) {
  const valid = rows.filter(r => r.oi1h != null && r.price1hPct != null);
  if (valid.length < 10) return null;
  const mreg = detectRegime(rows);
  const _sd = arr => { const m = arr.reduce((a, b) => a + b, 0) / arr.length;
    return Math.max(Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length), 0.05); };
  const cross = { stdOi: _sd(valid.map(r => r.oi1h)), stdPr: _sd(valid.map(r => r.price1hPct)) };
  const confs = valid.map(r => confluenceFor(r, mreg, cross));
  return { valid, confs, mreg, cross };
}

// ── CALIBRACIÓN: registrar señales ≥5/7 y resolver resultados ──────────────
// Se llama en CADA ciclo de datos (desde load()), no solo al ver la pestaña.
function updateConfSignals(rows) {
  const res = computeConfluence(rows);
  if (!res) return;
  const now = Date.now();
  let dirty = false;

  // 1) registrar señales nuevas (≥5/7, con cooldown por símbolo+lado)
  for (const c of res.confs) {
    if (c.count < CONF_SIG_MIN_COUNT) continue;
    const recent = confSignals.some(s => s.symbol === c.symbol && s.side === c.side && now - s.ts < CONF_SIG_COOLDOWN);
    if (recent) continue;
    confSignals.push({ ts: now, symbol: c.symbol, side: c.side, count: c.count,
      price: c.price, quad: c.quad, oks: c.checks.map(ch => ch.ok ? 1 : 0) });
    dirty = true;
  }

  // 2) resolver resultados a +30m / +1h con el precio actual
  const priceOf = new Map(rows.map(r => [r.symbol, r.price]));
  for (const s of confSignals) {
    if (s.p30 == null && now - s.ts >= 30 * 60_000 && priceOf.has(s.symbol)) { s.p30 = priceOf.get(s.symbol); dirty = true; }
    if (s.p60 == null && now - s.ts >= 60 * 60_000 && priceOf.has(s.symbol)) { s.p60 = priceOf.get(s.symbol); dirty = true; }
  }
  if (dirty) saveConfSignals();
}

/** Win-rate por nivel (5/6/7) y por check individual (✓ vs ✗) a +30m/+1h. */
function confCalibStats() {
  const mk = () => ({ n: 0, h: 0, sum: 0 });
  const lvl = { 5: { p30: mk(), p60: mk() }, 6: { p30: mk(), p60: mk() }, 7: { p30: mk(), p60: mk() } };
  const checks = CONF_CHECK_NAMES.map(() => ({ ok: mk(), ko: mk() })); // a +1h
  let resolved = 0;
  for (const s of confSignals) {
    for (const hz of ['p30', 'p60']) {
      if (s[hz] == null || !s.price) continue;
      const move = (s[hz] - s.price) / s.price * 100 * (s.side === 'long' ? 1 : -1);
      const L = lvl[Math.min(s.count, 7)]?.[hz];
      if (L) { L.n++; if (move > 0) L.h++; L.sum += move; }
      if (hz === 'p60') {
        resolved++;
        (s.oks || []).forEach((ok, i) => {
          if (!checks[i]) return;
          const c = ok ? checks[i].ok : checks[i].ko;
          c.n++; if (move > 0) c.h++; c.sum += move;
        });
      }
    }
  }
  return { lvl, checks, total: confSignals.length, resolved };
}

function toggleConfCalib() {
  confCalibOpen = !confCalibOpen;
  renderConfCalib();
}

function renderConfCalib() {
  const btn = document.getElementById('calib-btn');
  const el = document.getElementById('conf-calib');
  if (!el) return;
  const st = confCalibStats();
  if (btn) btn.textContent = `📐 Calibración (${st.resolved})`;
  if (!confCalibOpen) { el.style.display = 'none'; return; }
  el.style.display = '';

  const wr  = a => a.n ? (a.h / a.n * 100).toFixed(0) + '%' : '—';
  const avg = a => a.n ? ((a.sum / a.n >= 0 ? '+' : '') + (a.sum / a.n).toFixed(2) + '%') : '—';
  const col = a => { if (!a.n) return '#5a6a85'; const w = a.h / a.n * 100; return w >= 55 ? '#2fe08a' : w <= 45 ? '#ee6666' : '#5a6a85'; };

  const lvlRows = [5, 6, 7].map(k => {
    const L = st.lvl[k];
    return `<div class="calib-row"><span class="calib-name">${k}/7</span>
      <span>+30m <b style="color:${col(L.p30)}">${wr(L.p30)}</b> <i>(n=${L.p30.n}, ${avg(L.p30)})</i></span>
      <span>+1h <b style="color:${col(L.p60)}">${wr(L.p60)}</b> <i>(n=${L.p60.n}, ${avg(L.p60)})</i></span></div>`;
  }).join('');

  const chkRows = CONF_CHECK_NAMES.map((name, i) => {
    const c = st.checks[i];
    const edge = (c.ok.n && c.ko.n) ? ((c.ok.h / c.ok.n - c.ko.h / c.ko.n) * 100) : null;
    const eTxt = edge == null ? '—' : (edge >= 0 ? '+' : '') + edge.toFixed(0) + 'pt';
    const eCol = edge == null ? '#5a6a85' : edge > 3 ? '#2fe08a' : edge < -3 ? '#ee6666' : '#5a6a85';
    return `<div class="calib-row"><span class="calib-name">${name}</span>
      <span>con ✓ <b style="color:${col(c.ok)}">${wr(c.ok)}</b> <i>(n=${c.ok.n})</i></span>
      <span>con ✗ <b style="color:${col(c.ko)}">${wr(c.ko)}</b> <i>(n=${c.ko.n})</i></span>
      <span>edge <b style="color:${eCol}">${eTxt}</b></span></div>`;
  }).join('');

  el.innerHTML = `
    <div class="calib-sec">Win-rate por nivel de confluencia</div>${lvlRows}
    <div class="calib-sec" style="margin-top:8px">Aporte de cada check (a +1h): ¿mejora el WR cuando está en ✓?</div>${chkRows}
    <div class="cc-note" style="margin-top:6px">${st.resolved < 20
      ? `⚠️ Solo ${st.resolved} señales resueltas — se necesitan ≥20 para leer esto en serio. Deja la app abierta acumulando.`
      : `${st.total} señales registradas · ${st.resolved} resueltas. Un check con edge negativo sostenido es candidato a eliminarse del checklist.`}</div>`;
}

// ── Render del radar ────────────────────────────────────────────────────────
function renderConfluence(scored) {
  const grid = document.getElementById('conf-grid');
  if (!grid) return;
  const res = computeConfluence(scored);
  if (!res) { grid.innerHTML = '<div class="cc-note">Esperando datos…</div>'; return; }

  confCache = new Map();
  for (const c of res.confs) confCache.set(c.symbol, c);
  const confs = res.confs.slice().sort((a, b) => b.count - a.count || b.dist - a.dist);
  const top = confs.slice(0, 8);

  // Alerta cuando un símbolo alcanza ≥6/7
  for (const c of top) {
    const prev = prevConfCount.get(c.symbol) ?? 0;
    if (c.count >= 6 && prev < 6) {
      showToast(`🎯 ${c.symbol} ${c.count}/7 confluencia ${c.side.toUpperCase()}`, c.side);
      if (soundEnabled) beep(c.side === 'long' ? 1040 : 460, 'triangle', 180);
      notifyDesktop(`🎯 ${c.symbol} ${c.count}/7 ${c.side.toUpperCase()}`, c.checks.filter(ch => !ch.ok).map(ch => `✗ ${ch.k}`).join(' · ') || 'Todas las señales en verde');
    }
    prevConfCount.set(c.symbol, c.count);
  }

  grid.innerHTML = top.map(c => {
    const color = c.count >= 6 ? '#ffaa28' : c.count >= 5 ? '#2fe08a' : '#5a6a85';
    const fails = c.checks.filter(ch => !ch.ok).slice(0, 2).map(ch => `✗ ${ch.k}`).join(' · ');
    return `<div class="conf-card${c.count === 7 ? ' conf-full' : ''}${selectedBubble === c.symbol ? ' selected' : ''}" onclick="selectConfSymbol('${c.symbol}')">
      <div class="cc-top">
        <span class="cc-sym">${c.symbol}</span>
        <span class="cc-side ${c.side}">${c.side.toUpperCase()}</span>
        <span style="font-size:9px;color:#3a4558">${c.quad}</span>
        <span class="cc-count" style="color:${color}">${c.count}/7${c.count === 7 ? ' 🔥' : ''}</span>
      </div>
      <div class="cc-dots">${c.checks.map(ch => `<div class="cc-dot${ch.ok ? ' ok' : ''}" title="${ch.k}: ${ch.d}">${ch.ok ? '✓' : '·'}</div>`).join('')}</div>
      <div class="cc-note">${fails || 'Todas las señales en verde'}</div>
    </div>`;
  }).join('');

  renderQuadWinrates();
  renderQuadAligned(res.valid);
  renderPotentialPanel(res.valid);
  renderConfCalib();
  if (selectedBubble && confCache.has(selectedBubble)) renderConfDetail(selectedBubble);
}

function selectConfSymbol(sym) {
  selectedBubble = sym;
  document.querySelectorAll('.conf-card').forEach(c => c.classList.remove('selected'));
  renderConfDetail(sym);
  const el = document.getElementById('conf-detail');
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function renderConfDetail(sym) {
  const el = document.getElementById('conf-detail');
  if (!el) return;
  const c = confCache.get(sym);
  if (!c) { el.style.display = 'none'; return; }
  el.style.display = '';
  const rowsHtml = c.checks.map(ch => `<div style="display:flex;gap:8px;padding:2px 0">
      <span style="color:${ch.ok ? '#2fe08a' : '#aa4444'};width:14px;flex-shrink:0">${ch.ok ? '✓' : '✗'}</span>
      <span style="color:#7888aa;min-width:150px;flex-shrink:0">${ch.k}</span>
      <span style="color:#4a5870">${ch.d}</span></div>`).join('');
  el.innerHTML = `<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap">
      <b style="color:#e8edf8">${sym}</b>
      <span class="cc-side ${c.side}">${c.side.toUpperCase()}</span>
      <span style="color:#3a4558;font-size:10px">cuadrante ${c.quad} · ${c.count}/7</span>
      <a href="https://www.tradingview.com/chart/?symbol=BYBIT:${sym}USDT.P" target="_blank" style="margin-left:auto;font-size:10px;color:#4a90d0;text-decoration:none">TradingView ↗</a>
    </div>${rowsHtml}
    <div id="conf-bot" style="margin-top:7px;border-top:1px solid #141c28;padding-top:6px;color:#3a4558;font-size:10px">Consultando bot…</div>`;
  const bot = await getBotStats();
  const botEl = document.getElementById('conf-bot');
  if (!botEl) return;
  if (!bot || !bot.started) {
    botEl.textContent = '🤖 Bot apagado (LXR_BOT=1 para arrancarlo) — sin régimen/heatmap del bot.';
    return;
  }
  const full = sym + 'USDT';
  const reg = bot.regimes?.[full];
  const hm  = (bot.heatmaps?.[full] || []).slice(0, 3);
  const sig = (bot.lastSignals || []).filter(s => s.symbol === full).slice(-2);
  const pos = (bot.openPositions || []).find(p => p.symbol === full);
  botEl.innerHTML = `🤖 <b style="color:#7888aa">Bot:</b> ` +
    (reg ? `régimen <b style="color:#c8d8ff">${reg.regime} ${reg.dir === 'up' ? '↑' : reg.dir === 'down' ? '↓' : '·'}</b> (ADX ${reg.adx} · ER ${reg.er}) · ` : 'sin régimen · ') +
    (hm.length ? `imanes de liq: ${hm.map(h => fmtPrice(h.price)).join(', ')} · ` : '') +
    (pos ? `<b style="color:#ffaa28">posición abierta ${pos.side}</b> @ ${fmtPrice(pos.entry)} · ` : '') +
    (sig.length ? `señales: ${sig.map(s => `${s.strategy} ${s.side} (score ${s.score})`).join(' · ')}` : 'sin señales recientes');
}

// ── Win-rate histórico por cuadrante (de trackHistory, mirando +1h) ────────
function renderQuadWinrates() {
  const el = document.getElementById('quad-wr');
  if (!el) return;
  if (Date.now() - _qwrCache.ts < 120_000) { el.innerHTML = _qwrCache.html; return; }
  const agg = { LONG: { n: 0, h: 0 }, SHORT: { n: 0, h: 0 }, SQUEEZE: { n: 0, h: 0 }, LIQ: { n: 0, h: 0 } };
  const HOUR = 3600_000;
  for (const sym of Object.keys(trackHistory)) {
    const hist = trackHistory[sym];
    for (let i = 0; i < hist.length; i += 5) {
      const s0 = hist[i];
      if (s0.oi1h == null || s0.price1hPct == null) continue;
      const q = s0.oi1h >= 0 && s0.price1hPct >= 0 ? 'LONG' : s0.oi1h >= 0 ? 'SHORT' : s0.price1hPct >= 0 ? 'SQUEEZE' : 'LIQ';
      let fut = null;
      for (let j = i + 1; j < Math.min(i + 90, hist.length); j++) {
        if (hist[j].ts >= s0.ts + HOUR) { fut = hist[j]; break; }
      }
      if (!fut) continue;
      const up = fut.price > s0.price;
      agg[q].n++;
      if ((q === 'LONG' || q === 'SQUEEZE') ? up : !up) agg[q].h++;
    }
  }
  const anyData = Object.values(agg).some(a => a.n > 0);
  const chips = !anyData
    ? '<span class="qwr-chip">acumulando datos…</span>'
    : Object.entries(agg).map(([q, a]) => {
        if (!a.n) return `<span class="qwr-chip">${q} —</span>`;
        const wr = a.h / a.n * 100;
        const col = wr >= 55 ? '#2fe08a' : wr <= 45 ? '#ee6666' : '#5a6a85';
        return `<span class="qwr-chip" title="aciertos a +1h estando en ${q} (n=${a.n})">${q} <b style="color:${col}">${wr.toFixed(0)}%</b></span>`;
      }).join('');
  _qwrCache = { ts: Date.now(), html: `<span style="font-size:9px;color:#283040">WR +1h por cuadrante:</span>` + chips };
  el.innerHTML = _qwrCache.html;
}

// ── Alineación total de cuadrante: mismo cuadrante en 15m·1h·4h·1d ─────────
// Si una moneda está en el MISMO cuadrante en las 4 temporalidades, la
// tendencia es consistente de punta a punta — ayuda visual para continuación.
function renderQuadAligned(rows) {
  const el = document.getElementById('conf-aligned');
  if (!el) return;
  const quadOf = (oi, p) => oi >= 0 && p >= 0 ? 'LONG' : oi >= 0 ? 'SHORT' : p >= 0 ? 'SQUEEZE' : 'LIQ';
  const TFS = [['oi15m', 'price15mPct'], ['oi1h', 'price1hPct'], ['oi4h', 'price4hPct'], ['oi24h', 'price24hPct']];
  const items = [];
  for (const r of rows) {
    // tolerante a huecos: usa las temporalidades con datos (mínimo 3 de 4)
    const avail = TFS.filter(([o, p]) => r[o] != null && r[p] != null);
    if (avail.length < 3) continue;
    const qs = avail.map(([o, p]) => quadOf(r[o], r[p]));
    if (qs.every(q => q === qs[0])) {
      items.push({ symbol: r.symbol, quad: qs[0], p1h: r.price1hPct ?? 0, tfs: avail.length });
    }
  }
  const order  = { LONG: 0, SHORT: 1, SQUEEZE: 2, LIQ: 3 };
  const colors = {
    LONG:    ['#06291a', '#2fe08a'], SHORT: ['#2e0a0a', '#ff5555'],
    SQUEEZE: ['#0a1f2e', '#4aa8d8'], LIQ:   ['#240808', '#aa6060'],
  };
  // las 4/4 primero, luego por cuadrante y magnitud del movimiento 1h
  items.sort((a, b) => b.tfs - a.tfs || order[a.quad] - order[b.quad] || Math.abs(b.p1h) - Math.abs(a.p1h));
  const chips = items.slice(0, 18).map(it => {
    const [bg, fg] = colors[it.quad];
    const pc = it.p1h >= 0 ? '#55bb88' : '#ee6666';
    const full = it.tfs === 4;
    const title = full
      ? `${it.symbol}: cuadrante ${it.quad} en 15m, 1h, 4h y 1d — tendencia consistente en todas las temporalidades`
      : `${it.symbol}: cuadrante ${it.quad} en ${it.tfs} de 4 temporalidades (falta el dato de 1d, suele completarse en el siguiente ciclo)`;
    return `<span class="qal-chip" onclick="selectConfSymbol('${it.symbol}')" title="${title}"${full ? '' : ' style="opacity:.55"'}>
      ${it.symbol}
      <span class="qal-q" style="background:${bg};color:${fg}">${it.quad}</span>
      <span class="qal-pct" style="color:${pc}">${fmtPct(it.p1h) ?? '—'}</span>
      ${full ? '' : '<span class="qal-pct" style="color:#5a6a85">3/4</span>'}
    </span>`;
  }).join('');
  el.innerHTML = `<div class="qal-head">🧭 Cuadrante alineado en 15m · 1h · 4h · 1d (${items.filter(i => i.tfs === 4).length} completas)</div>
    <div class="qal-grid">${chips || '<span class="cc-note">Ninguna moneda con las temporalidades en el mismo cuadrante ahora mismo.</span>'}</div>`;
}

// ── 🚀 Monedas con potencial ────────────────────────────────────────────────
// Replica el método que usé para detectar STG en el análisis manual. Busca el
// setup de SQUEEZE/ACUMULACIÓN: cortos pagando funding extremo + dinero nuevo
// entrando (OI multi-ventana) + giro de precio incipiente + independiente de
// BTC. El CVD es el GATILLO: con flujo a favor sube el score; en contra avisa
// "esperar confirmación" (igual que dije de STG: tesis intacta, falta el CVD).
function potentialScore(row) {
  const n = v => v ?? 0;
  const reasons = [];
  let score = 0;

  // Dirección de la tesis por el funding (quién paga = a quién exprimir)
  const fr = n(row.fundingRate);
  // LONG si cortos pagan (funding negativo) · SHORT si longs pagan (positivo)
  const dirUp = fr < 0 ? true : fr > 0 ? false : (n(row.oi1h) > 0 && n(row.price1hPct) >= 0);
  const sgn = dirUp ? 1 : -1;

  // 1) Funding extremo (núcleo, hasta 35): cuanto más estirado, más combustible
  const af = Math.abs(fr);
  if      (af >= 0.5)  { score += 35; reasons.push(`funding ${fr.toFixed(2)}% extremo`); }
  else if (af >= 0.2)  { score += 25; reasons.push(`funding ${fr.toFixed(2)}% alto`); }
  else if (af >= 0.05) { score += 15; reasons.push(`funding ${fr.toFixed(3)}% estirado`); }
  else return null; // sin funding estirado no es este setup

  // 2) OI acumulando en varias ventanas (hasta 30): dinero NUEVO, no cortos viejos
  const oiWins = [n(row.oi5m), n(row.oi1h), n(row.oi4h), n(row.oi24h)];
  const oiUp = oiWins.filter(v => v > 0.2).length;
  if      (oiUp >= 3) { score += 30; reasons.push(`OI subiendo en ${oiUp}/4 ventanas (acumulación)`); }
  else if (oiUp >= 2) { score += 18; reasons.push(`OI subiendo en ${oiUp}/4 ventanas`); }
  else if (oiUp >= 1) { score += 8; }
  else reasons.push('⚠ OI no acumula (posible fade débil)');

  // 3) Giro de precio incipiente a favor (hasta 15): recuperando, no en caída libre
  if (sgn * n(row.price5mPct) > 0 || sgn * n(row.price1hPct) > 0) { score += 15; reasons.push('precio girando a favor'); }
  else reasons.push('⚠ precio aún no gira');

  // 4) Independiente de BTC (hasta 10): tesis propia, no arrastrada
  if (row.btcCorr != null && Math.abs(row.btcCorr) <= 0.4) { score += 10; reasons.push(`independiente de BTC (ρ ${row.btcCorr.toFixed(2)})`); }

  // 5) Liquidaciones a favor recientes (hasta 10): el squeeze ya empezó
  const lq = liqSumCache.get(row.symbol);
  if (lq) {
    const favLiq = dirUp ? lq.s : lq.l; // long: cortos liquidados · short: largos liquidados
    if (favLiq > 100_000) { score += 10; reasons.push('cascada a favor en curso'); }
    else if (favLiq > 20_000) score += 4;
  }

  // GATILLO: CVD 5m. A favor confirma (+10); en contra no resta pero AVISA.
  const cvd = row.cvd5m;
  let trigger;
  if (cvd == null) trigger = { state: 'wait', txt: 'sin datos de flujo' };
  else if (sgn * cvd > 0) { score += 10; trigger = { state: 'go', txt: 'CVD a favor — gatillo activo' }; }
  else trigger = { state: 'wait', txt: 'esperar CVD a favor (gatillo)' };

  // exige el núcleo del setup: funding estirado + algo de acumulación de OI
  if (score < 40 || oiUp < 1) return null;

  return {
    symbol: row.symbol, side: dirUp ? 'long' : 'short',
    score: Math.min(100, Math.round(score)),
    reasons, trigger, price: row.price,
    funding: fr, corr: row.btcCorr,
  };
}

function renderPotentialPanel(scored) {
  const grid = document.getElementById('potential-grid');
  const cnt = document.getElementById('potential-count');
  if (!grid) return;
  const list = scored.map(potentialScore).filter(Boolean)
    .sort((a, b) => b.score - a.score);
  // ready = gatillo activo y score alto; watch = tesis viva, falta confirmación
  if (cnt) cnt.textContent = list.length
    ? `${list.filter(p => p.trigger.state === 'go').length} con gatillo activo · ${list.length} en total`
    : '';
  if (!list.length) {
    grid.innerHTML = '<div class="cc-note">Ninguna moneda con el setup de squeeze/acumulación ahora mismo (sin funding estirado + OI acumulando). En mercado lateral es lo normal — esperar.</div>';
    return;
  }
  grid.innerHTML = list.slice(0, 8).map(p => {
    const go = p.trigger.state === 'go';
    const col = go ? '#2fe08a' : '#e0a830';
    return `<div class="pot-card${go ? ' pot-go' : ''}" onclick="selectConfSymbol('${p.symbol}')">
      <div class="cc-top">
        <span class="cc-sym">${p.symbol}</span>
        <span class="cc-side ${p.side}">${p.side.toUpperCase()}</span>
        <span class="pot-trigger" style="color:${col}">${go ? '✓ LISTA' : '⏳ VIGILAR'}</span>
        <span class="cc-count" style="color:${col}">${p.score}</span>
      </div>
      <div class="pot-reasons">${p.reasons.slice(0, 3).map(r => `<div class="pot-r">${r.startsWith('⚠') ? r : '· ' + r}</div>`).join('')}</div>
      <div class="pot-foot" style="color:${col}">🔑 ${p.trigger.txt}</div>
    </div>`;
  }).join('');
}

