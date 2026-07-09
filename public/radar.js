/* public/radar.js
 * Módulo del RADAR DE CONFLUENCIA + extras del mapa de momentum.
 * Se carga DESPUÉS de lxr.js y ANTES del script principal de index.html.
 * Comparte el scope global con el script principal (helpers como fmtPct,
 * detectRegime, timeframeAlignment, showToast… se resuelven en runtime).
 *
 * Contiene:
 *  - estado del radar (normalización σ, outliers, estelas, filtro liquidez)
 *  - motor de confluencia (checklist de 5 señales — se quitaron 'Outlier real'
 *    y 'Sesgo global a favor' tras medir su edge real: +0pt y -33pt)
 *  - CALIBRACIÓN: registra señales ≥4/5 y mide win-rate real a +30m/+1h,
 *    por nivel (4/5) y por check individual (ablación)
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
let _qwrCache     = { ts: 0, html: '' };

// ── Calibración del radar: señales registradas y su resultado ──────────────
const CONF_CHECK_NAMES   = ['Multi-TF', 'CVD+funding', 'Régimen', 'Liquidez', 'Riesgo'];
const CONF_SIG_MIN_COUNT = 4;            // se registra como señal a partir de 4/5
const CONF_SIG_COOLDOWN  = 60 * 60_000;  // máx. 1 señal/h por símbolo+lado
const CONF_SIG_MAX       = 2000;
let confSignals  = JSON.parse(localStorage.getItem('scalp_confsig2') || '[]');
let confCalibOpen = false;

function saveConfSignals() {
  if (confSignals.length > CONF_SIG_MAX) confSignals = confSignals.slice(-CONF_SIG_MAX);
  try { localStorage.setItem('scalp_confsig2', JSON.stringify(confSignals)); } catch (_) {}
  if (typeof syncToServer === 'function') syncToServer();
}

// Borra la calibración del Radar de Confluencia. Necesario tras cambiar la
// composición del checklist (ej. de 7 a 5 checks): las señales viejas tienen
// 'count' y 'oks' indexados contra el checklist anterior — mezclarlas con las
// nuevas da lecturas sin sentido, hay que arrancar de cero.
function clearConfSignals() {
  if (!confirm('¿Borrar toda la calibración del Radar de Confluencia? Esto reinicia el winrate por check y por nivel desde cero.')) return;
  confSignals = [];
  prevConfCount.clear();
  saveConfSignals();
  renderConfCalib();
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
  else                                 dir = 'lateral · solo setups A+ (≥4/5) o esperar';
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

// ── Régimen propio fallback (sin trackHistory) a partir de ATR ─────────────
function fallbackSymbolRegime(row) {
  const n = v => v ?? 0;
  const atrPct = row.atr1h && row.price ? row.atr1h / row.price * 100 : null;
  if (atrPct == null || atrPct <= 0) return null;
  if (Math.abs(n(row.price4hPct)) >= atrPct * 2.5) return { regime: n(row.price4hPct) > 0 ? 'RUPTURA ↑' : 'RUPTURA ↓' };
  if (n(row.vol1hPct) > 40 || Math.abs(n(row.price1hPct)) > atrPct * 1.2) return { regime: 'VOLÁTIL' };
  return { regime: 'EN RANGO' };
}

// ── Motor de confluencia: el checklist de 5 señales por símbolo ────────────
// 'dist' (distancia σ del centro del mercado) se sigue calculando — ya no
// entra al checklist (edge medido +0pt, no aportaba) pero queda disponible
// para el estudio aparte de "outlier sostenido en el tiempo" pendiente.
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

// ── CALIBRACIÓN: registrar señales ≥4/5 y resolver resultados ──────────────
// Se llama en CADA ciclo de datos (desde load()), no solo al ver la pestaña.
function updateConfSignals(rows) {
  const res = computeConfluence(rows);
  if (!res) return;
  const now = Date.now();
  let dirty = false;

  // 1) registrar señales nuevas (≥4/5, con cooldown por símbolo+lado)
  for (const c of res.confs) {
    if (c.count < CONF_SIG_MIN_COUNT) continue;
    const recent = confSignals.some(s => s.symbol === c.symbol && s.side === c.side && now - s.ts < CONF_SIG_COOLDOWN);
    if (recent) continue;
    confSignals.push({ ts: now, symbol: c.symbol, side: c.side, count: c.count,
      price: c.price, quad: c.quad, oks: c.checks.map(ch => ch.ok ? 1 : 0) });
    dirty = true;
  }

  // 2) resolver resultados a +30m / +1h con el precio actual — SOLO dentro de
  //    la ventana (+30–35m / +60–65m). Antes, si la pestaña estuvo cerrada,
  //    se usaba el precio actual aunque hubieran pasado horas → la calibración
  //    quedaba contaminada. Las que se pasaron de ventana se resuelven retro
  //    con el precio real de ese momento (servidor de snapshots o kline).
  const priceOf = new Map(rows.map(r => [r.symbol, r.price]));
  for (const s of confSignals) {
    const age = now - s.ts;
    if (s.p30 == null && age >= 30 * 60_000 && age < 35 * 60_000 && priceOf.has(s.symbol)) { s.p30 = priceOf.get(s.symbol); dirty = true; }
    if (s.p60 == null && age >= 60 * 60_000 && age < 65 * 60_000 && priceOf.has(s.symbol)) { s.p60 = priceOf.get(s.symbol); dirty = true; }
  }
  if (dirty) saveConfSignals();
  resolveStaleConfSignals(); // async — señales que quedaron fuera de ventana
}

// ── Resolución retrospectiva de señales del radar ───────────────────────────
// Para señales cuya ventana de +30m/+1h pasó con la pestaña cerrada: pide el
// precio de ESE momento al servidor de snapshots (/api/prices/lookup, 5 min de
// resolución) y, si el servidor no lo tiene, cae a la kline 1m de Bybit.
let _confResolving = false;
async function resolveStaleConfSignals() {
  if (_confResolving) return;
  const now = Date.now();
  const pending = [];
  for (const s of confSignals) {
    if (s.p30 == null && now - s.ts >= 35 * 60_000) pending.push({ sig: s, hz: 'p30', ts: s.ts + 30 * 60_000 });
    if (s.p60 == null && now - s.ts >= 65 * 60_000) pending.push({ sig: s, hz: 'p60', ts: s.ts + 60 * 60_000 });
  }
  if (!pending.length) return;
  _confResolving = true;
  try {
    const batch = pending.slice(0, 60);
    let results = [];
    try {
      const res = await fetch('/api/prices/lookup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ queries: batch.map(p => ({ symbol: p.sig.symbol, ts: p.ts })), tolMs: 5 * 60_000 }),
      });
      if (res.ok) results = (await res.json()).results || [];
    } catch (_) { /* servidor sin snapshots */ }

    let dirty = false;
    let klineCalls = 0;
    for (let i = 0; i < batch.length; i++) {
      const p = batch[i];
      let price = results[i]?.price ?? null;
      // Fallback kline (máx. 8 por ciclo para no gastar rate limit de Bybit)
      if (price == null && typeof fetchPriceAtTime === 'function' && klineCalls < 8) {
        klineCalls++;
        price = await fetchPriceAtTime(p.sig.symbol, p.ts);
      }
      if (price != null) { p.sig[p.hz] = price; dirty = true; }
    }
    if (dirty) {
      saveConfSignals();
      renderConfCalib();
    }
  } finally {
    _confResolving = false;
  }
}

/** Win-rate por nivel (4/5) y por check individual (✓ vs ✗) a +30m/+1h. */
function confCalibStats() {
  const mk = () => ({ n: 0, h: 0, sum: 0 });
  const lvl = { 4: { p30: mk(), p60: mk() }, 5: { p30: mk(), p60: mk() } };
  const checks = CONF_CHECK_NAMES.map(() => ({ ok: mk(), ko: mk() })); // a +1h
  let resolved = 0;
  for (const s of confSignals) {
    for (const hz of ['p30', 'p60']) {
      if (s[hz] == null || !s.price) continue;
      const move = (s[hz] - s.price) / s.price * 100 * (s.side === 'long' ? 1 : -1);
      const L = lvl[Math.min(s.count, 5)]?.[hz];
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

  const wr  = a => {
    if (!a.n) return '—';
    const pct = (a.h / a.n * 100).toFixed(0);
    const ci = wilsonCI(a.h, a.n);
    return `${pct}%<span style="font-weight:400;opacity:.55">±${Math.round(ci.pm)}</span>${a.n < WR_MIN_N ? ' ⚠' : ''}`;
  };
  const avg = a => a.n ? ((a.sum / a.n >= 0 ? '+' : '') + (a.sum / a.n).toFixed(2) + '%') : '—';
  // Gris si la muestra es chica o el IC 95% cruza el 50% (no significativo)
  const col = a => {
    if (!a.n || a.n < WR_MIN_N) return '#5a6a85';
    const ci = wilsonCI(a.h, a.n);
    if (!ci || (ci.lo <= 50 && ci.hi >= 50)) return '#5a6a85';
    return a.h / a.n >= 0.5 ? '#2fe08a' : '#ee6666';
  };

  const lvlRows = [4, 5].map(k => {
    const L = st.lvl[k];
    return `<div class="calib-row"><span class="calib-name">${k}/5</span>
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

  // Alerta cuando un símbolo alcanza el máximo (5/5)
  for (const c of top) {
    const prev = prevConfCount.get(c.symbol) ?? 0;
    if (c.count >= 5 && prev < 5) {
      showToast(`🎯 ${c.symbol} ${c.count}/5 confluencia ${c.side.toUpperCase()}`, c.side);
      if (soundEnabled) beep(c.side === 'long' ? 1040 : 460, 'triangle', 180);
      notifyDesktop(`🎯 ${c.symbol} ${c.count}/5 ${c.side.toUpperCase()}`, c.checks.filter(ch => !ch.ok).map(ch => `✗ ${ch.k}`).join(' · ') || 'Todas las señales en verde');
    }
    prevConfCount.set(c.symbol, c.count);
  }

  grid.innerHTML = top.map(c => {
    const color = c.count >= 5 ? '#ffaa28' : c.count >= 4 ? '#2fe08a' : '#5a6a85';
    const fails = c.checks.filter(ch => !ch.ok).slice(0, 2).map(ch => `✗ ${ch.k}`).join(' · ');
    return `<div class="conf-card${c.count === 5 ? ' conf-full' : ''}${selectedBubble === c.symbol ? ' selected' : ''}" onclick="selectConfSymbol('${c.symbol}')">
      <div class="cc-top">
        <span class="cc-sym">${c.symbol}</span>
        <span class="cc-side ${c.side}">${c.side.toUpperCase()}</span>
        <span style="font-size:9px;color:#3a4558">${c.quad}</span>
        <span class="cc-count" style="color:${color}">${c.count}/5${c.count === 5 ? ' 🔥' : ''}</span>
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
      <span style="color:#3a4558;font-size:10px">cuadrante ${c.quad} · ${c.count}/5</span>
      <a href="https://www.tradingview.com/chart/?symbol=BYBIT:${sym}USDT.P" target="_blank" style="margin-left:auto;font-size:10px;color:#4a90d0;text-decoration:none">TradingView ↗</a>
    </div>${rowsHtml}`;
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
        const ci = wilsonCI(a.h, a.n);
        // Solo se colorea si es significativo: n suficiente Y el intervalo no cruza 50%
        const sig = a.n >= WR_MIN_N && ci && (ci.lo > 50 || ci.hi < 50);
        const col = !sig ? '#5a6a85' : wr >= 50 ? '#2fe08a' : '#ee6666';
        return `<span class="qwr-chip" title="aciertos a +1h estando en ${q} — n=${a.n}, IC 95%: ${ci.lo.toFixed(0)}–${ci.hi.toFixed(0)}%${sig ? '' : ' (no significativo aún)'}">${q} <b style="color:${col}">${wr.toFixed(0)}%<span style="font-weight:400;opacity:.55">±${Math.round(ci.pm)}</span></b></span>`;
      }).join('');
  _qwrCache = { ts: Date.now(), html: `<span style="font-size:9px;color:#283040">WR +1h por cuadrante:</span>` + chips };
  el.innerHTML = _qwrCache.html;
}

// ── Alineación total de cuadrante: mismo cuadrante en 15m·1h·4h·1d ─────────
// Si una moneda está en el MISMO cuadrante en las 4 temporalidades, la
// tendencia es consistente de punta a punta — ayuda visual para continuación.
function renderQuadAligned(rows) {
  const el = document.getElementById('conf-aligned');
  const strip = document.getElementById('aligned-strip'); // copia bajo el mapa (screener)
  if (!el && !strip) return;
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
    return `<span class="qal-chip" onclick="selectConfSymbol('${it.symbol}');if(typeof highlightScreenerRow==='function')highlightScreenerRow('${it.symbol}')" title="${title}"${full ? '' : ' style="opacity:.55"'}>
      ${it.symbol}
      <span class="qal-q" style="background:${bg};color:${fg}">${it.quad}</span>
      <span class="qal-pct" style="color:${pc}">${fmtPct(it.p1h) ?? '—'}</span>
      ${full ? '' : '<span class="qal-pct" style="color:#5a6a85">3/4</span>'}
    </span>`;
  }).join('');
  const fullCount = items.filter(i => i.tfs === 4).length;
  const html = `<div class="qal-head">🧭 Cuadrante alineado en 15m · 1h · 4h · 1d (${fullCount} completas)</div>
    <div class="qal-grid">${chips || '<span class="cc-note">Ninguna moneda con las temporalidades en el mismo cuadrante ahora mismo.</span>'}</div>`;
  if (el) el.innerHTML = html;
  if (strip) strip.innerHTML = html;
}

// ── 🎯 Outliers reales: se separa del resto con fuerza + liquidez real ─────
// 'dist' (misma fórmula que usaba el check "Outlier real" del checklist, y el
// filtro "Outliers" del mapa) mide cuántas σ combinadas de OI+precio (1h) está
// una moneda lejos del centro del mercado. Aquí se le suma piso de liquidez
// (mismo umbral que el check "Liquidez": turnover24h≥$20M, vol1h≥$500K — sin
// esto un pico ilíquido cuenta igual que uno real) y rastreo de PERSISTENCIA
// para distinguir un pico puntual de un movimiento sostenido.
const OUTLIER_DIST_MIN   = 1.5;          // mismo bar que tenía "Outlier real"
const OUTLIER_DIST_SPIKE = 2.2;          // "pico fuerte"
const OUTLIER_SUSTAIN_MS = 15 * 60_000;  // 15min seguidas por encima del piso = sostenido
let outlierTrack = new Map(); // symbol → { sinceTs, peakDist, side }

function computeOutliers(rows) {
  const res = computeConfluence(rows);
  if (!res) return [];
  const now = Date.now();
  const active = new Set();
  const out = [];
  for (const c of res.confs) {
    const row = rows.find(r => r.symbol === c.symbol);
    if (!row) continue;
    const liquid = (row.turnover24h ?? 0) >= 20e6 && (row.vol1hUSD ?? 0) >= 500_000;
    if (!liquid || c.dist < OUTLIER_DIST_MIN) continue;

    active.add(c.symbol);
    let t = outlierTrack.get(c.symbol);
    if (!t) { t = { sinceTs: now, peakDist: c.dist, side: c.side }; outlierTrack.set(c.symbol, t); }
    else     { t.peakDist = Math.max(t.peakDist, c.dist); t.side = c.side; }

    const durationMs = now - t.sinceTs;
    const sustained  = durationMs >= OUTLIER_SUSTAIN_MS;
    const spike      = c.dist >= OUTLIER_DIST_SPIKE;
    let label;
    if      (sustained && spike) label = '🔥⚡ sostenido + pico fuerte';
    else if (sustained)          label = '🔥 sostenido';
    else if (spike)              label = '⚡ pico puntual';
    else                         label = 'formándose';

    out.push({ symbol: c.symbol, side: c.side, dist: c.dist, peakDist: t.peakDist,
      sinceTs: t.sinceTs, durationMs, sustained, spike, label, price: row.price });
  }
  // se le acabó la racha: ya no califica, se borra el rastro
  for (const sym of [...outlierTrack.keys()]) if (!active.has(sym)) outlierTrack.delete(sym);

  out.sort((a, b) => b.dist - a.dist);

  if (typeof logPanelDetections === 'function') {
    logPanelDetections('outlier', out.map(o => ({
      symbol: o.symbol, side: o.side === 'long' ? 'l' : 's', score: Math.round(o.dist * 10),
    })));
  }
  return out;
}

function fmtOutlierDuration(ms) {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const min = Math.round(ms / 60_000);
  return min < 60 ? `${min}min` : `${(min / 60).toFixed(1)}h`;
}

function renderOutlierStrip(rows) {
  const el = document.getElementById('outlier-strip');
  if (!el) return;
  const list = computeOutliers(rows).slice(0, 16);
  if (!list.length) { el.innerHTML = ''; return; }

  const sustainedCount = list.filter(o => o.sustained).length;
  const chips = list.map(o => {
    const color = o.sustained ? '#ffbe3c' : o.spike ? '#2fe08a' : '#5a6a85';
    const symColor = o.side === 'long' ? '#00cc88' : '#ff5555';
    return `<span class="pat-chip${o.sustained ? ' pat-breaking' : ''}" onclick="openInRadar('${o.symbol}')"
      title="${o.symbol} ${o.side.toUpperCase()} · ${o.dist.toFixed(1)}σ del centro (pico máx ${o.peakDist.toFixed(1)}σ) · lleva ${fmtOutlierDuration(o.durationMs)} fuera de rango">
      <b style="color:${symColor}">${o.symbol}</b> <span class="cc-side ${o.side}" style="font-size:8.5px">${o.side === 'long' ? '▲' : '▼'}</span>
      <b style="color:${color}">${o.dist.toFixed(1)}σ</b>
      <span style="color:${color};font-size:9px">${o.label}</span>
    </span>`;
  }).join('');

  el.innerHTML = `<span class="qal-head">🎯 Outliers reales${sustainedCount ? ` — <b style="color:#ffbe3c">${sustainedCount} sostenidos</b>` : ''}</span>${chips}`;
}

// ── 🚀 Momentum confirmado: umbrales absolutos, no σ ────────────────────────
// Distinto del "Outliers reales" de arriba (que mide distancia relativa al
// centro del mercado): aquí se piden números reales fijos — precio 1h ≥5% Y
// OI 1h ≥10% EXPANDIÉNDOSE (no basta con que se mueva, tiene que crecer).
// OI creciendo junto al precio = dinero nuevo entrando en esa dirección
// (alcista si precio+OI suben juntos, bajista si precio cae mientras el OI
// sube = shorts nuevos). Si el precio se mueve pero el OI cae, es cierre de
// posiciones (cobertura de cortos / liquidación de largos) — no cuenta como
// momentum "confirmado", puede revertir en cualquier momento.
const MOM_PRICE_MIN = 5;   // % precio 1h (abs)
const MOM_OI_MIN     = 10; // % OI 1h, debe ser POSITIVO (expandiéndose)

function computeMomentumConfirmed(rows) {
  const out = [];
  for (const row of rows) {
    const price1h = row.price1hPct, oi1h = row.oi1h;
    if (price1h == null || oi1h == null) continue;
    if (Math.abs(price1h) < MOM_PRICE_MIN) continue;
    if (oi1h < MOM_OI_MIN) continue; // debe crecer, no solo moverse
    // mismo piso de liquidez que el resto del sistema (turnover24h/vol1h)
    if ((row.turnover24h ?? 0) < 20e6 || (row.vol1hUSD ?? 0) < 500_000) continue;
    out.push({ symbol: row.symbol, side: price1h >= 0 ? 'long' : 'short', price1h, oi1h, price: row.price });
  }
  out.sort((a, b) => Math.abs(b.price1h) - Math.abs(a.price1h));
  if (typeof logPanelDetections === 'function') {
    logPanelDetections('momentum', out.map(o => ({
      symbol: o.symbol, side: o.side === 'long' ? 'l' : 's', score: Math.round(Math.abs(o.price1h) * 10),
    })));
  }
  return out;
}

function renderMomentumStrip(rows) {
  const el = document.getElementById('momentum-strip');
  if (!el) return;
  const list = computeMomentumConfirmed(rows).slice(0, 16);
  if (!list.length) { el.innerHTML = ''; return; }

  const chips = list.map(o => {
    const symColor = o.side === 'long' ? '#00cc88' : '#ff5555';
    return `<span class="pat-chip" onclick="openInRadar('${o.symbol}')"
      title="${o.symbol} ${o.side.toUpperCase()} · precio 1h ${o.price1h >= 0 ? '+' : ''}${o.price1h.toFixed(1)}% · OI 1h +${o.oi1h.toFixed(1)}% (expandiéndose) · liquidez real detrás">
      <b style="color:${symColor}">${o.symbol}</b> <span class="cc-side ${o.side}" style="font-size:8.5px">${o.side === 'long' ? '▲' : '▼'}</span>
      <b style="color:${symColor}">${o.price1h >= 0 ? '+' : ''}${o.price1h.toFixed(1)}%</b>
      <span style="color:#8aa0c0;font-size:9px">OI +${o.oi1h.toFixed(1)}%</span>
    </span>`;
  }).join('');

  el.innerHTML = `<span class="qal-head">🚀 Momentum confirmado</span>${chips}`;
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

  // Piso de liquidez: sin esto, un funding/OI "extremo" en una moneda ilíquida
  // suele ser ruido de libro delgado, no una tesis real. Mismo umbral que ya
  // usa scoreSymbol() ($300k vol 1h) para ser consistentes en todo el sistema.
  if ((row.vol1hUSD ?? 0) < 300_000) { score = Math.min(score, 30); reasons.push('⚠ liquidez baja (vol 1h < $300k) — score limitado'); }

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

  // Registrar TODAS las candidatas (no solo las 8 que se muestran) en el mismo
  // sistema de evidencia del Comparador — key 'squeeze' para no chocar con
  // 'promising' (que ya usa la etiqueta "Potencial" en el Lab).
  if (typeof logPanelDetections === 'function') {
    logPanelDetections('squeeze', list.map(p => ({
      symbol: p.symbol, side: p.side === 'long' ? 'l' : 's', score: p.score,
    })));
  }

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

