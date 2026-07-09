/* public/track.js
 * Respaldo en servidor (sync Turso), seguimiento de favoritos/auto-track
 * (historial, tesis, libro de detecciones), comparador de estrategias y
 * análisis por hora. Requiere core.js, screener.js y lab.js cargados antes.
 */

// ── Respaldo en servidor (Turso, vía /api/sync) ────────────────────────────
// La app sigue funcionando solo con localStorage si el servidor no tiene Turso
// configurado (GET devuelve null). El push se manda con debounce para no saturar.
let syncPushTimer = null;
function syncToServer() {
  clearTimeout(syncPushTimer);
  syncPushTimer = setTimeout(() => {
    fetch('/api/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trackHistory, stratSignals, trackLedger, favorites: [...favorites], confSignals: typeof confSignals !== 'undefined' ? confSignals : [] }),
    }).catch(() => {});
  }, 5000);
}

// Fusiona libros de detecciones de dos orígenes: clave sym|t0, y si el mismo
// registro existe abierto en uno y cerrado en otro, gana el cerrado.
function mergeTrackLedger(local, remote) {
  if (!Array.isArray(remote) || !remote.length) return local;
  const byKey = new Map();
  for (const e of [...remote, ...local]) {
    if (!e || !e.sym || !e.t0) continue;
    const k = e.sym + '|' + e.t0;
    const prev = byKey.get(k);
    if (!prev || (e.closedAt && !prev.closedAt)) byKey.set(k, e);
  }
  return [...byKey.values()].sort((a, b) => a.t0 - b.t0).slice(-LEDGER_MAX);
}

function mergeTrackHistory(local, remote) {
  const merged = { ...local };
  for (const sym of Object.keys(remote || {})) {
    const a = local[sym] || [];
    const seen = new Set(a.map(s => s.ts));
    const combined = [...a];
    for (const s of (remote[sym] || [])) if (!seen.has(s.ts)) { combined.push(s); seen.add(s.ts); }
    combined.sort((x, y) => x.ts - y.ts);
    if (combined.length > TRACK_MAX) combined.splice(0, combined.length - TRACK_MAX);
    merged[sym] = combined;
  }
  return merged;
}

function mergeStratSignals(local, remote) {
  const key = s => `${s.ts}|${s.strategy}|${s.symbol}|${s.dir}`;
  const seen = new Set(local.map(key));
  const combined = [...local];
  for (const s of (remote || [])) {
    const k = key(s);
    if (!seen.has(k)) { combined.push(s); seen.add(k); }
  }
  combined.sort((a, b) => a.ts - b.ts);
  if (combined.length > STRAT_SIG_MAX) combined.splice(0, combined.length - STRAT_SIG_MAX);
  return combined;
}

// Trae el respaldo del servidor al iniciar y lo fusiona con lo que ya hay en
// localStorage (unión por timestamp, sin duplicar) — útil si usas la app desde
// más de un navegador/dispositivo.
async function syncFromServer() {
  try {
    const res = await fetch('/api/sync');
    if (!res.ok) return;
    const data = await res.json();
    if (!data) return;
    trackHistory = mergeTrackHistory(trackHistory, data.trackHistory);
    stratSignals = mergeStratSignals(stratSignals, data.stratSignals);
    trackLedger  = mergeTrackLedger(trackLedger, data.trackLedger);
    if (Array.isArray(data.favorites)) {
      for (const sym of data.favorites) favorites.add(sym);
      safeSetItem('scalp_favs', JSON.stringify([...favorites]));
    }
    if (Array.isArray(data.confSignals) && typeof confSignals !== 'undefined') {
      const seen = new Set(confSignals.map(s => `${s.ts}|${s.symbol}|${s.side}`));
      for (const s of data.confSignals) {
        if (!seen.has(`${s.ts}|${s.symbol}|${s.side}`)) { confSignals.push(s); seen.add(`${s.ts}|${s.symbol}|${s.side}`); }
      }
      confSignals.sort((a, b) => a.ts - b.ts);
      if (confSignals.length > CONF_SIG_MAX) confSignals = confSignals.slice(-CONF_SIG_MAX);
      saveConfSignals();
    }
    saveTrackLedger();
    saveTrackHistory();
    safeSetItem('scalp_stratsig', JSON.stringify(stratSignals));
  } catch (e) { /* sin servidor o sin Turso — seguimos solo con localStorage */ }
}

// ── Backfill del seguimiento desde el servidor de snapshots ─────────────────
// Con la pestaña cerrada no se registran snapshots locales, así que las señales
// previas (score ≥ 6) quedaban sin resolver para siempre. Al arrancar pedimos
// la serie de precios (cada 5 min) del servidor y la inyectamos como snapshots
// "solo precio" (score 0: nunca cuentan como señal nueva, solo sirven de
// referencia futura para que trackOutcomes resuelva las señales pendientes).
async function backfillTrackHistory() {
  try {
    const symbols = [...new Set([...favorites, ...autoTracked.keys()])].slice(0, 50);
    if (!symbols.length) return;
    const from = Date.now() - 24 * 3600_000; // TRACK_MAX cubre ~25h
    const res = await fetch(`/api/prices/series?symbols=${encodeURIComponent(symbols.join(','))}&from=${from}`);
    if (!res.ok) return;
    const data = await res.json();
    if (!Array.isArray(data.rows) || !data.rows.length) return;

    const bySym = new Map();
    for (const r of data.rows) {
      if (!bySym.has(r.symbol)) bySym.set(r.symbol, []);
      bySym.get(r.symbol).push(r);
    }
    let added = 0;
    for (const [sym, rows] of bySym) {
      const hist = trackHistory[sym] || (trackHistory[sym] = []);
      for (const r of rows) {
        // solo rellena huecos: si ya hay un snapshot local a <3 min, no aporta
        const near = hist.some(s => Math.abs(s.ts - r.ts) < 3 * 60_000);
        if (near) continue;
        hist.push({ ts: r.ts, price: r.price, score: 0, isLong: true, regime: '—', backfill: true });
        added++;
      }
      hist.sort((a, b) => a.ts - b.ts);
      if (hist.length > TRACK_MAX) hist.splice(0, hist.length - TRACK_MAX);
    }
    if (added) {
      saveTrackHistory();
      renderSeguimiento();
      console.log(`[backfill] ${added} snapshots de precio recuperados del servidor`);
    }
  } catch (_) { /* servidor sin snapshots — no pasa nada */ }
}

// ── Seguimiento de favoritos ────────────────────────────────────────────────
// trackHistory acumula símbolos para siempre (solo poda a TRACK_MAX entradas
// POR símbolo, nunca símbolos enteros) — un auto-track que rota top-5 por OI
// cada minuto deja decenas de símbolos "fantasma" con historial que ya nadie
// lee (renderSeguimiento solo mira favorites ∪ autoTracked). Sin podarlos, el
// respaldo en Turso crece sin límite hasta reventar /api/sync (10MB).
function pruneTrackHistory() {
  const keep = new Set([...favorites, ...autoTracked.keys()]);
  for (const sym of Object.keys(trackHistory)) {
    if (!keep.has(sym)) delete trackHistory[sym];
  }
}

function saveTrackHistory() {
  pruneTrackHistory();
  safeSetItem('scalp_track', JSON.stringify(trackHistory));
  syncToServer();
}

// Guarda 1 snapshot por símbolo favorito cada ~60s: precio, score, dirección,
// régimen de mercado y contexto (OI/volumen/funding/liquidaciones). Esto permite
// reconstruir después "qué pasó tras la señal" sin necesitar marcar nada a mano.
function logTrackSnapshots(rows) {
  const symbols = new Set([...favorites, ...autoTracked.keys()]);
  if (!symbols.size) return;
  const now = Date.now();
  let regime = null;
  for (const sym of symbols) {
    const last = lastTrackLog.get(sym);
    if (last && now - last < 55_000) continue;
    const row = rows.find(r => r.symbol === sym);
    if (!row) continue;
    if (!regime) regime = detectRegime(allRows);
    const sc = scoreSymbol(row);
    const score  = Math.max(sc.longScore, sc.shortScore);
    const isLong = sc.longScore >= sc.shortScore;
    const liq = liqSumCache.get(sym) || { l: 0, s: 0 };
    if (!trackHistory[sym]) trackHistory[sym] = [];
    trackHistory[sym].push({
      ts: now, price: row.price, score, isLong,
      regime: regime.regime, auto: !favorites.has(sym),
      oi1h: row.oi1h, vol1hPct: row.vol1hPct, fundingRate: row.fundingRate,
      price1hPct: row.price1hPct, // para win-rate por cuadrante
      liqL: liq.l, liqS: liq.s,
    });
    if (trackHistory[sym].length > TRACK_MAX) trackHistory[sym].shift();
    lastTrackLog.set(sym, now);
  }
  if (regime) saveTrackHistory();
}

// Para cada snapshot que fue "señal" (score >= TRACK_SCORE_MIN), busca el primer
// snapshot posterior a >= lookaheadMs y calcula si el precio se movió a favor.
// Solo cuenta señales con suficiente tiempo transcurrido (resultado ya conocido).
function trackOutcomes(sym, lookaheadMs, regimeFilter = 'ALL') {
  const hist = trackHistory[sym] || [];
  const out = [];
  for (let i = 0; i < hist.length; i++) {
    const snap = hist[i];
    if (snap.score < TRACK_SCORE_MIN) continue;
    if (regimeFilter !== 'ALL' && snap.regime !== regimeFilter) continue;
    const target = snap.ts + lookaheadMs;
    let future = null;
    for (let j = i + 1; j < hist.length; j++) {
      if (hist[j].ts >= target) { future = hist[j]; break; }
    }
    if (!future) continue;
    const movePct = (future.price - snap.price) / snap.price * 100 * (snap.isLong ? 1 : -1);
    out.push({ snap, movePct, hit: movePct > 0 });
  }
  return out;
}

function trackStats(sym, regimeFilter = 'ALL') {
  const total = (trackHistory[sym] || []).length;
  if (total < 2) return null;
  const span = Date.now() - trackHistory[sym][0].ts;
  const o30 = trackOutcomes(sym, 30 * 60_000, regimeFilter);
  const o60 = trackOutcomes(sym, 60 * 60_000, regimeFilter);
  const agg = (outs) => {
    if (!outs.length) return null;
    const hits = outs.filter(o => o.hit).length;
    const avgMove = outs.reduce((a, o) => a + o.movePct, 0) / outs.length;
    return { n: outs.length, winRate: Math.round(hits / outs.length * 100), avgMove };
  };
  return { totalSnaps: total, spanMs: span, s30: agg(o30), s60: agg(o60) };
}

// Mini-gráfico SVG con la evolución del score en los últimos snapshots: línea +
// puntos coloreados (verde/rojo según isLong) cuando cruzan el umbral de señal.
function scoreSparkline(sym, n = 30) {
  const hist = (trackHistory[sym] || []).slice(-n);
  if (hist.length < 2) return '';
  const W = 180, H = 28, PAD = 2;
  const stepX = (W - PAD * 2) / (hist.length - 1);
  const y = (score) => H - PAD - Math.max(0, Math.min(10, score)) / 10 * (H - PAD * 2);
  const points = hist.map((s, i) => `${(PAD + i * stepX).toFixed(1)},${y(s.score).toFixed(1)}`).join(' ');
  const thresholdY = y(TRACK_SCORE_MIN).toFixed(1);
  const dots = hist.map((s, i) => {
    const cx = (PAD + i * stepX).toFixed(1);
    const cy = y(s.score).toFixed(1);
    const color = s.score >= TRACK_SCORE_MIN ? (s.isLong ? '#00c878' : '#ee5555') : '#2e4060';
    return `<circle cx="${cx}" cy="${cy}" r="1.6" fill="${color}" />`;
  }).join('');
  return `<svg class="tc-spark" width="100%" height="${H}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <line x1="0" y1="${thresholdY}" x2="${W}" y2="${thresholdY}" stroke="#2a3a55" stroke-width="1" stroke-dasharray="3,2" />
    <polyline points="${points}" fill="none" stroke="#3a6a9a" stroke-width="1.4" />
    ${dots}
  </svg>`;
}

// Cruza las señales evaluadas a 1h con el contexto que tenían al activarse
// (funding rate, dirección del OI 1h, sesgo de liquidaciones) para detectar
// condiciones bajo las que esa moneda acierta más o menos.
const CTX_MIN_SAMPLES = 3;
function trackContextBreakdown(sym, regimeFilter) {
  const outs = trackOutcomes(sym, 60 * 60_000, regimeFilter);
  if (outs.length < CTX_MIN_SAMPLES * 2) return null;
  const bucket = (groups) => {
    const res = {};
    for (const [label, list] of Object.entries(groups)) {
      if (list.length < CTX_MIN_SAMPLES) continue;
      const hits = list.filter(o => o.hit).length;
      res[label] = { n: list.length, winRate: Math.round(hits / list.length * 100) };
    }
    return Object.keys(res).length >= 2 ? res : null;
  };
  const funding = bucket({
    'funding −': outs.filter(o => (o.snap.fundingRate ?? 0) < 0),
    'funding +': outs.filter(o => (o.snap.fundingRate ?? 0) >= 0),
  });
  const oi = bucket({
    'OI 1h ↑': outs.filter(o => (o.snap.oi1h ?? 0) > 0),
    'OI 1h ↓': outs.filter(o => (o.snap.oi1h ?? 0) <= 0),
  });
  const liq = bucket({
    'liq. largos': outs.filter(o => (o.snap.liqL ?? 0) > (o.snap.liqS ?? 0)),
    'liq. cortos': outs.filter(o => (o.snap.liqS ?? 0) > (o.snap.liqL ?? 0)),
  });
  if (!funding && !oi && !liq) return null;
  return { funding, oi, liq };
}

function renderCtxRow(label, groups) {
  if (!groups) return '';
  const best = Object.entries(groups).sort((a, b) => b[1].winRate - a[1].winRate)[0][0];
  const parts = Object.entries(groups).map(([k, g]) =>
    `${k} <b class="${k === best ? 'pos' : ''}">${g.winRate}%</b> (${g.n})`);
  return `<div class="tc-ctx-row"><span>${label}</span><span>${parts.join(' · ')}</span></div>`;
}

// ── Playbook de largo plazo: patrón por día de la semana ───────────────────
// Reutiliza `stratSignals` (ya acumula semanas de señales evaluadas a 1h para
// cualquier símbolo que haya entrado al Top-4 de alguna estrategia, persistido
// vía Turso) en vez de crear un nuevo store de baja frecuencia: con eso basta
// para detectar "esta moneda rinde mejor los lunes" sin esperar nuevos datos.
const DOW_NAMES = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
const DOW_MIN_SIGNALS = 4;
function symbolDowBreakdown(sym, regimeFilter) {
  const evals = stratSignals
    .filter(s => s.symbol === sym && s.eval60 && (regimeFilter === 'ALL' || s.regime === regimeFilter))
    .map(s => ({ dow: new Date(s.ts).getDay(), ...s.eval60 }));
  if (evals.length < DOW_MIN_SIGNALS * 2) return null;
  const days = DOW_NAMES.map((label, dow) => {
    const list = evals.filter(e => e.dow === dow);
    if (list.length < DOW_MIN_SIGNALS) return null;
    const winRate = Math.round(list.filter(e => e.hit).length / list.length * 100);
    const avgMove = list.reduce((a, e) => a + e.movePct, 0) / list.length;
    return { label, n: list.length, winRate, avgMove };
  }).filter(Boolean);
  if (days.length < 2) return null;
  const sorted = [...days].sort((a, b) => b.winRate - a.winRate);
  return { best: sorted[0], worst: sorted[sorted.length - 1] };
}

function playbookDowRow(label, d, cls) {
  return `<div class="tc-ctx-row"><span>${label}</span>
    <span><b class="${cls}">${d.label}</b> ${d.winRate}% acierto · ${d.avgMove >= 0 ? '+' : ''}${d.avgMove.toFixed(2)}% (${d.n} señales)</span></div>`;
}

// ── Capa de IA narrativa (opcional) ────────────────────────────────────────
// Junta el contexto YA CALCULADO (heat score, confluencia, régimen, alineación,
// playbook…) y se lo pasa a /api/explain para que la IA lo interprete en
// lenguaje natural — nunca le mandamos datos crudos para que "adivine".
async function explainSymbol(sym) {
  const out = document.getElementById(`tc-ai-${sym}`);
  if (!out) return;
  out.innerHTML = '<span class="tc-ai-loading">🤖 Analizando contexto…</span>';
  try {
    const screenerRow = allRows.find(r => r.symbol === sym);
    const stats     = trackStats(sym, trackRegimeFilter);
    const align     = screenerRow ? timeframeAlignment(screenerRow) : null;
    const symRegime = detectSymbolRegime(sym);
    const dow       = symbolDowBreakdown(sym, trackRegimeFilter);
    const market    = allRows.length ? detectRegime(allRows) : null;
    const heatEntry = labScoredCache?.find(s => s.symbol === sym);
    const heat      = heatEntry ? computeHeatScore(heatEntry) : null;
    const auto      = autoTracked.get(sym);

    const ctx = {
      symbol: sym,
      heat: heat?.heat ?? auto?.heat ?? null,
      side: heat?.side ?? auto?.side ?? null,
      confluence: heat?.confluence ?? null,
      marketRegime: market?.regime ?? null,
      symbolRegime: symRegime ? `${symRegime.regime} — ${symRegime.desc}` : null,
      alignment: align ? `${align.count}/${align.total} ${align.dir === 'up' ? 'alcista' : 'bajista'}` : null,
      fundingRate: screenerRow?.fundingRate?.toFixed?.(4) ?? null,
      oi1h: screenerRow?.oi1h?.toFixed?.(2) ?? null,
      winRate1h: stats?.s60?.winRate ?? null,
      avgMove1h: stats?.s60?.avgMove?.toFixed?.(2) ?? null,
      bestDay: dow ? `${dow.best.label} (${dow.best.winRate}% acierto, ${dow.best.n} señales)` : null,
      worstDay: dow ? `${dow.worst.label} (${dow.worst.winRate}% acierto, ${dow.worst.n} señales)` : null,
    };

    const res = await fetch('/api/explain', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ctx),
    });
    if (res.status === 503) {
      out.innerHTML = '<span class="tc-ai-empty">Configura ANTHROPIC_API_KEY en el servidor (.env) para activar esto.</span>';
      return;
    }
    if (!res.ok) throw new Error('explain failed');
    const data = await res.json();
    out.innerHTML = data.text
      ? `<p class="tc-ai-text">${data.text.replace(/\n+/g, '<br>')}</p>`
      : '<span class="tc-ai-empty">Sin respuesta del modelo.</span>';
  } catch (e) {
    out.innerHTML = '<span class="tc-ai-empty">No se pudo generar la explicación — intenta de nuevo.</span>';
  }
}

function fmtTrackSpan(ms) {
  const h = ms / 3_600_000;
  if (h < 1) return Math.round(ms / 60_000) + 'm';
  if (h < 24) return h.toFixed(1) + 'h';
  return (h / 24).toFixed(1) + 'd';
}

// Tarjeta de acceso: alterna entre el resumen (picks destacados) y la lista
// completa de tarjetas de seguimiento, que puede crecer mucho con el tiempo.
function toggleTrackPanel() {
  trackPanelExpanded = !trackPanelExpanded;
  const body = document.getElementById('lab-track-body');
  const toggle = document.getElementById('track-summary-toggle');
  if (body)   body.classList.toggle('lab-track-body-collapsed', !trackPanelExpanded);
  if (toggle) toggle.textContent = trackPanelExpanded ? '▴ Ocultar' : '▾ Ver todas';
}

// Top-N monedas más prometedoras "para comprar o seguir" ahora mismo: reutiliza
// el heat score (confluencia + anomalía z + score base) ya calculado para el
// radar, sobre TODO el mercado (no solo las que ya se siguen).
function topPromisingPicks(n = 5) {
  if (!labScoredCache) return [];
  return labScoredCache
    .map(s => computeHeatScore(s))
    .filter(h => h.heat >= 3)
    .sort((a, b) => b.heat - a.heat)
    .slice(0, n);
}

function renderTrackSummary(trackedCount, agg) {
  const countEl = document.getElementById('track-summary-count');
  if (countEl) {
    let txt = trackedCount
      ? `${trackedCount} moneda${trackedCount === 1 ? '' : 's'} en seguimiento`
      : 'sin monedas en seguimiento aún';
    // El dato que mide si el sistema aporta: ¿las detecciones van a favor?
    if (agg && agg.n) {
      const cls = agg.avg >= 0 ? '#00c878' : '#ee5555';
      txt += ` — desde detección: ${agg.wins}/${agg.n} a favor · `;
      countEl.innerHTML = txt + `<b style="color:${cls}">${agg.avg >= 0 ? '+' : ''}${agg.avg.toFixed(2)}% prom.</b>`;
    } else countEl.textContent = txt;
  }
  const picksEl = document.getElementById('track-summary-picks');
  if (!picksEl) return;
  const picks = topPromisingPicks(5);
  logPanelDetections('promising', picks.map(p => ({
    symbol: p.symbol, side: p.side, score: Math.round(p.heat * 10),
  })));
  picksEl.innerHTML = picks.length
    ? picks.map(p => `<span class="track-pick ${p.side === 'l' ? 'track-pick-long' : 'track-pick-short'}">
        <b>${p.symbol}</b> ${p.side === 'l' ? '▲ LONG' : '▼ SHORT'} · <span class="track-pick-heat">🔥${p.heat}</span>
      </span>`).join('')
    : '<span class="lr-empty">Sin candidatas destacadas por ahora — vuelve en unos minutos</span>';
}

// ── 📒 Libro de detecciones: historial PERMANENTE del seguimiento ───────────
// Cada vez que una moneda entra al seguimiento se abre un registro (lado,
// precio, origen); cuando sale (expira el auto o se quita la ★) se cierra con
// el resultado final. Así el rendimiento histórico del sistema es auditable
// aunque las monedas ya no estén trackeadas.
let trackLedger = JSON.parse(localStorage.getItem('scalp_ledger') || '[]');
const LEDGER_MAX = 500;
function saveTrackLedger() {
  if (trackLedger.length > LEDGER_MAX) trackLedger = trackLedger.slice(-LEDGER_MAX);
  safeSetItem('scalp_ledger', JSON.stringify(trackLedger));
  if (typeof syncToServer === 'function') syncToServer(); // respaldo en Turso (debounced)
}

function updateTrackLedger(symbols, theses) {
  let dirty = false;
  // abrir registro para detecciones nuevas
  for (const sym of symbols) {
    const th = theses.get(sym);
    if (!th) continue;
    if (!trackLedger.some(e => e.sym === sym && !e.closedAt)) {
      trackLedger.push({ sym, side: th.side, t0: th.t0, p0: th.p0,
        origin: favorites.has(sym) ? 'fav' : 'auto', closedAt: null });
      dirty = true;
    }
  }
  // cerrar registros de monedas que salieron del seguimiento
  for (const e of trackLedger) {
    if (e.closedAt || symbols.has(e.sym)) continue;
    const row = allRows.find(r => r.symbol === e.sym);
    const hist = trackHistory[e.sym] || [];
    const pClose = row ? row.price : (hist.length ? hist[hist.length - 1].price : e.p0);
    e.closedAt = Date.now();
    e.pClose = pClose;
    e.movePct = +((pClose - e.p0) / e.p0 * 100 * (e.side === 'l' ? 1 : -1)).toFixed(2);
    e.estadoFinal = _trackStateMap.get(e.sym) || null;
    dirty = true;
  }
  if (dirty) saveTrackLedger();
}

function renderTrackLedger() {
  const el = document.getElementById('track-ledger');
  if (!el) return;
  const closed = trackLedger.filter(e => e.closedAt);
  if (!closed.length) {
    el.innerHTML = '<span class="lr-empty">📒 Aún no hay detecciones cerradas — se registran automáticamente cuando una moneda sale del seguimiento (expira el auto-track o le quitas la ★).</span>';
    return;
  }
  const wins = closed.filter(e => e.movePct > 0).length;
  const avg  = closed.reduce((a, e) => a + e.movePct, 0) / closed.length;
  const wr   = Math.round(wins / closed.length * 100);
  const last = closed.slice(-10).reverse();
  el.innerHTML = `<div class="tc-ctx-title">📒 Historial de detecciones cerradas — <b>${closed.length}</b> registradas ·
      acierto <b style="color:${closed.length < WR_MIN_N ? '#5a6a85' : wr >= 50 ? '#00c878' : '#ee5555'}" title="IC 95% (Wilson): ${wilsonCI(wins, closed.length).lo.toFixed(0)}–${wilsonCI(wins, closed.length).hi.toFixed(0)}%">${wr}%±${Math.round(wilsonCI(wins, closed.length).pm)}</b> ·
      promedio <b style="color:${avg >= 0 ? '#00c878' : '#ee5555'}">${avg >= 0 ? '+' : ''}${avg.toFixed(2)}%</b>
      <span style="color:#2e4060;font-weight:400">(resultado al cerrar, en la dirección de la tesis — el veredicto real del sistema)</span></div>
    <div class="ledger-rows">` + last.map(e => {
      const cls = e.movePct > 0 ? 'pos' : 'neg';
      const when = new Date(e.closedAt).toLocaleDateString('es-MX', { day: '2-digit', month: 'short' });
      return `<div class="ledger-row"><span class="qa-time">${when}</span><b style="color:#c8d8ff">${e.sym}</b>
        <span style="color:${e.side === 'l' ? '#00c878' : '#ee5555'};font-weight:700">${e.side === 'l' ? 'LONG' : 'SHORT'}</span>
        <span style="color:#3a5070">${e.origin === 'fav' ? '★' : '🔥'} · ${fmtTrackSpan(e.closedAt - e.t0)} en seguimiento</span>
        <b class="${cls}">${e.movePct >= 0 ? '+' : ''}${e.movePct}%</b></div>`;
    }).join('') + '</div>';
}

// ── Tesis y estado de cada moneda en seguimiento ────────────────────────────
// Responde lo que un trader necesita: ¿qué lado era la tesis?, ¿cómo va desde
// que se detectó?, ¿sigue viva o ya se invalidó?
let _trackStateMap = new Map(); // sym → estado anterior (para alertar transiciones)

function trackThesis(sym) {
  const row = allRows.find(r => r.symbol === sym);
  if (!row) return null;
  const auto = autoTracked.get(sym);
  const hist = trackHistory[sym] || [];
  let side = auto?.side ?? null;          // 'l' | 's' (lado al detectarla)
  const t0 = auto?.addedAt ?? (hist.length ? hist[0].ts : Date.now());
  let p0 = null;
  for (const s of hist) {
    if (s.ts >= t0) { p0 = s.price; if (side == null) side = s.isLong ? 'l' : 's'; break; }
  }
  if (p0 == null && hist.length) p0 = hist[0].price;
  const sc = scoreSymbol(row);
  if (side == null) side = sc.longScore >= sc.shortScore ? 'l' : 's';
  if (p0 == null) p0 = row.price;
  const dirUp = side === 'l';
  const movePct = (row.price - p0) / p0 * 100 * (dirUp ? 1 : -1); // a favor de la tesis
  const curScore = dirUp ? sc.longScore : sc.shortScore;
  const atrPct = row.atr1h && row.price ? row.atr1h / row.price * 100 : null;
  const cvdAgainst = dirUp ? (row.cvd5m ?? 0) < 0 : (row.cvd5m ?? 0) > 0;

  // INVALIDADA: movió >1.2×ATR en contra desde detección, o el score colapsó.
  // DÉBIL: score bajo o flujo en contra mientras pierde. ACTIVA: lo demás.
  const invalidated = (atrPct != null && movePct < -1.2 * atrPct) || curScore <= 2;
  const weak = !invalidated && (curScore <= 4 || (cvdAgainst && movePct < 0));
  const estado = invalidated ? 'inv' : weak ? 'weak' : 'ok';
  const ESTADOS = {
    ok:   ['✅ ACTIVA',     '#00c878', 'la tesis sigue respaldada por score y flujo'],
    weak: ['⚠️ DÉBIL',      '#e0a830', 'el score cayó o el flujo va en contra — vigilar de cerca'],
    inv:  ['❌ INVALIDADA', '#ee5555', 'movió más de 1.2×ATR en contra o el score colapsó — la tesis murió'],
  };
  const [estadoTxt, estadoCol, estadoTip] = ESTADOS[estado];
  return { sym, side, dirUp, t0, p0, movePct, curScore, estado, estadoTxt, estadoCol, estadoTip, atrPct, row };
}

function renderSeguimiento() {
  const wrap = document.getElementById('lab-track-cards');
  if (!wrap) return;
  const symbols = new Set([...favorites, ...autoTracked.keys()]);
  if (!symbols.size) {
    renderTrackSummary(0, null);
    wrap.innerHTML = `<div class="tc-empty">Marca monedas con ★ en el Screener — o espera a que el radar detecte alguna "on fire" — para empezar a registrar su historial.</div>`;
    return;
  }

  // Tesis de cada moneda + alertas de invalidación + resumen agregado
  const theses = new Map();
  let aggN = 0, aggWins = 0, aggSum = 0;
  for (const sym of symbols) {
    const th = trackThesis(sym);
    if (!th) continue;
    theses.set(sym, th);
    aggN++; aggSum += th.movePct; if (th.movePct > 0) aggWins++;
    const prev = _trackStateMap.get(sym);
    if (prev && prev !== 'inv' && th.estado === 'inv') {
      showToast(`❌ ${sym}: tesis ${th.dirUp ? 'LONG' : 'SHORT'} invalidada (${th.movePct.toFixed(1)}%)`, th.dirUp ? 'short' : 'long');
      if (soundEnabled) beep(330, 'sine', 200);
      notifyDesktop(`❌ ${sym} — tesis invalidada`, `Movió ${th.movePct.toFixed(1)}% en contra desde la detección`);
    }
    _trackStateMap.set(sym, th.estado);
  }
  renderTrackSummary(symbols.size, aggN ? { n: aggN, wins: aggWins, avg: aggSum / aggN } : null);
  updateTrackLedger(symbols, theses); // 📒 abre/cierra registros del libro de detecciones
  renderTrackLedger();

  // Orden por relevancia: activas primero (mejor rendimiento arriba), luego débiles, al final invalidadas
  const ORDER = { ok: 0, weak: 1, inv: 2 };
  const sorted = [...symbols].sort((a, b) => {
    const ta = theses.get(a), tb = theses.get(b);
    if (!ta || !tb) return ta ? -1 : tb ? 1 : a.localeCompare(b);
    return ORDER[ta.estado] - ORDER[tb.estado] || tb.movePct - ta.movePct;
  });

  const cards = sorted.map(sym => {
    const stats = trackStats(sym, trackRegimeFilter);
    const auto = autoTracked.get(sym);
    const th = theses.get(sym);
    const originPill = favorites.has(sym)
      ? '<span class="tc-origin tc-origin-fav">★ favorito</span>'
      : auto ? `<span class="tc-origin tc-origin-auto">🔥 auto · expira en ${fmtAutoTrackAge(auto.expiresAt - Date.now())}</span>` : '';
    const screenerRow = allRows.find(r => r.symbol === sym);
    const align = screenerRow ? timeframeAlignment(screenerRow) : null;
    const estadoPill = th ? `<span class="tc-state" style="color:${th.estadoCol};border-color:${th.estadoCol}55" title="${th.estadoTip}">${th.estadoTxt}</span>` : '';
    const head = `<div class="tc-head"><span class="tc-sym">${sym}</span>${estadoPill}${originPill}${tfAlignmentBadge(align)}<span class="tc-meta">${
      stats ? `${stats.totalSnaps} snapshots · ${fmtTrackSpan(stats.spanMs)}` : 'sin datos aún'
    }</span></div>`;

    // ── La respuesta del trader: tesis, rendimiento desde detección y niveles ──
    let thesisHtml = '';
    if (th) {
      const mvCls = th.movePct > 0 ? 'pos' : th.movePct < 0 ? 'neg' : '';
      const sideTxt = th.dirUp ? '▲ LONG' : '▼ SHORT';
      const sideCol = th.dirUp ? '#00c878' : '#ee5555';
      thesisHtml = `<div class="tc-thesis">
        <div class="tc-row"><span>Tesis</span>
          <span><b style="color:${sideCol}">${sideTxt}</b> · detectada hace ${fmtTrackSpan(Date.now() - th.t0)} @ ${fmtPrice(th.p0)}</span></div>
        <div class="tc-since"><span>Desde detección</span>
          <b class="${mvCls}">${th.movePct >= 0 ? '+' : ''}${th.movePct.toFixed(2)}%</b></div>
        <div class="tc-row"><span>Ahora</span>
          <span>${fmtPrice(th.row.price)} · score <b>${th.dirUp ? 'L' : 'S'}${th.curScore}</b>${th.row.cvd5m != null ? ` · CVD ${(th.dirUp ? th.row.cvd5m > 0 : th.row.cvd5m < 0) ? '<b class="pos">a favor</b>' : '<b class="neg">en contra</b>'}` : ''}</span></div>
        ${th.atrPct ? `<div class="tc-row"><span>Niveles (ATR)</span>
          <span>stop <b class="neg">${fmtPrice(th.row.price * (1 - (th.dirUp ? 1 : -1) * th.atrPct * 1.2 / 100))}</b> · TP <b class="pos">${fmtPrice(th.row.price * (1 + (th.dirUp ? 1 : -1) * th.atrPct * 1.8 / 100))}</b></span></div>` : ''}
      </div>`;
    }

    const symRegime = detectSymbolRegime(sym);
    const symRegimeHtml = symRegime ? `<div class="tc-row tc-symregime"><span>Régimen propio</span>
      <span style="color:${symRegime.color}"><b>${symRegime.regime}</b> · ${symRegime.desc}</span></div>` : '';
    if (!stats) {
      return `<div class="track-card">${head}${thesisHtml}${symRegimeHtml}<div class="tc-empty">Registrando snapshots — el historial se construye con la app abierta.</div></div>`;
    }

    // Estadística honesta: win-rate solo con n≥5; antes, mostrar que acumula
    const MIN_N = 5;
    const row = (label, agg) => {
      if (!agg) return `<div class="tc-row"><span>${label}</span><b>${trackRegimeFilter === 'ALL' ? 'esperando…' : 'sin señales en ' + trackRegimeFilter}</b></div>`;
      if (agg.n < MIN_N) return `<div class="tc-row"><span>${label}</span><span style="color:#4a6080">acumulando datos (${agg.n}/${MIN_N} señales)</span></div>`;
      const cls = agg.avgMove > 0 ? 'pos' : agg.avgMove < 0 ? 'neg' : '';
      return `<div class="tc-row"><span>${label} (n=${agg.n})</span>
        <span><b>${wrChip(agg.winRate, agg.n)} acierto</b> · <span class="${cls}">${agg.avgMove >= 0 ? '+' : ''}${agg.avgMove.toFixed(2)}% prom.</span></span></div>`;
    };
    const spark = scoreSparkline(sym);
    const sparkHtml = spark ? `<div class="tc-spark-wrap">
      <div class="tc-spark-label">Evolución del score (${Math.min(30, trackHistory[sym].length)} snapshots)</div>
      ${spark}
    </div>` : '';
    const ctx = trackContextBreakdown(sym, trackRegimeFilter);
    const ctxHtml = ctx ? `<div class="tc-ctx">
      <div class="tc-ctx-title">Acierto a 1h según contexto al activarse</div>
      ${renderCtxRow('Funding', ctx.funding)}
      ${renderCtxRow('OI 1h', ctx.oi)}
      ${renderCtxRow('Liquidaciones', ctx.liq)}
    </div>` : '';
    // Playbook solo cuando es APROVECHABLE: mejor día con ≥50% acierto y prom. positivo
    const dow = symbolDowBreakdown(sym, trackRegimeFilter);
    const playbookHtml = (dow && dow.best.winRate >= 50 && dow.best.avgMove > 0) ? `<div class="tc-ctx">
      <div class="tc-ctx-title">Playbook — patrón por día de la semana (1h)</div>
      ${playbookDowRow('Mejor día', dow.best, 'pos')}
      ${playbookDowRow('Peor día', dow.worst, 'neg')}
    </div>` : '';
    return `<div class="track-card${th && th.estado === 'inv' ? ' track-card-inv' : ''}">
      ${head}
      ${thesisHtml}
      ${symRegimeHtml}
      ${row('A 30 min', stats.s30)}
      ${row('A 1 h', stats.s60)}
      ${sparkHtml}
      ${ctxHtml}
      ${playbookHtml}
      <div class="tc-ai">
        <button class="tc-ai-btn" onclick="explainSymbol('${sym}')">🤖 Explicar con IA</button>
        <button class="tc-ai-btn" onclick="openInRadar('${sym}')">🎯 Ver en radar</button>
        <div class="tc-ai-out" id="tc-ai-${sym}"></div>
      </div>
    </div>`;
  });
  wrap.innerHTML = cards.join('');
}

function clearTrackHistory() {
  if (!confirm('¿Borrar todo el historial de seguimiento de favoritos?')) return;
  trackHistory = {};
  lastTrackLog.clear();
  saveTrackHistory();
  renderSeguimiento();
}

// Descarga trackHistory + stratSignals + confSignals como un único archivo
// JSON, para respaldar el historial fuera de localStorage (se pierde al
// limpiar el navegador) y para poder auditar offline la calibración del Radar
// de Confluencia (antes faltaba confSignals — sin eso no se podía revisar esa
// parte de Estrategia con datos reales).
function exportHistory() {
  const payload = {
    exportedAt: new Date().toISOString(),
    trackHistory,
    stratSignals,
    trackLedger, // 📒 libro de detecciones cerradas
    confSignals: typeof confSignals !== 'undefined' ? confSignals : [], // calibración del Radar de Confluencia
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = `scalp-historial-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Borra todo el historial del Comparador (stratSignals) y reinicia los mapas
// de deduplicación, para que las estrategias vuelvan a acumular desde cero —
// útil tras un cambio en la fórmula de una estrategia (ej. nuevo piso de
// liquidez), cuando la muestra vieja ya no es comparable con la nueva.
function clearStratSignals() {
  if (!confirm('¿Borrar todo el historial del Comparador (todas las estrategias)? Esto reinicia el winrate acumulado de cero.')) return;
  stratSignals = [];
  activeStratPick.clear();
  activePanelPick.clear();
  safeSetItem('scalp_stratsig', JSON.stringify(stratSignals));
  syncToServer();
  renderStrategyCompare();
}

// ── Comparador de estrategias (Lab) ─────────────────────────────────────────
// `topFn(key, side)` es la misma función `top()` de renderLab — recibe los
// símbolos que están en el Top-4 de cada estrategia/lado en este ciclo.
function logPanelDetections(strategy, entries) {
  const now = Date.now();
  const regime = detectRegime(allRows).regime;
  const stillActive = new Set();
  let added = false;
  for (const e of entries) {
    const pickKey = `${strategy}|${e.symbol}|${e.side}`;
    stillActive.add(pickKey);
    if (activePanelPick.has(pickKey)) continue;
    const row = allRows.find(r => r.symbol === e.symbol);
    if (!row) continue;
    stratSignals.push({
      ts: now, strategy, symbol: e.symbol, dir: e.side,
      score: e.score, entryPrice: row.price, regime,
      eval30: null, eval60: null,
    });
    if (stratSignals.length > STRAT_SIG_MAX) stratSignals.shift();
    added = true;
  }
  for (const k of [...activePanelPick.keys()]) {
    if (k.startsWith(strategy + '|') && !stillActive.has(k)) activePanelPick.delete(k);
  }
  for (const k of stillActive) activePanelPick.set(k, now);
  if (added) { safeSetItem('scalp_stratsig', JSON.stringify(stratSignals)); syncToServer(); }
}

function logStrategySignals(topFn) {
  const now = Date.now();
  const regime = detectRegime(allRows).regime;
  const stillActive = new Set();
  for (const key of Object.keys(STRAT_NAMES)) {
    for (const side of ['l', 's']) {
      for (const r of topFn(key, side)) {
        const pickKey = `${key}|${r.symbol}|${side}`;
        stillActive.add(pickKey);
        if (activeStratPick.has(pickKey)) continue; // ya estaba activo, no es señal nueva
        const row = allRows.find(rr => rr.symbol === r.symbol);
        if (!row) continue;
        stratSignals.push({
          ts: now, strategy: key, symbol: r.symbol, dir: side,
          score: r[key][side], entryPrice: row.price, regime,
          eval30: null, eval60: null,
        });
        if (stratSignals.length > STRAT_SIG_MAX) stratSignals.shift();
      }
    }
  }
  for (const k of [...activeStratPick.keys()]) if (!stillActive.has(k)) activeStratPick.delete(k);
  for (const k of stillActive) activeStratPick.set(k, now);
  safeSetItem('scalp_stratsig', JSON.stringify(stratSignals));
  syncToServer();
}

// Helper para obtener el precio de una moneda en un timestamp pasado.
// 1º pregunta al servidor de snapshots (5 min de resolución, no gasta rate
// limit de Bybit); 2º cae a la kline 1m de Bybit (precisión de minuto).
// FIX: antes se mandaba el símbolo corto ("BTC") a la kline — Bybit requiere
// "BTCUSDT", así que la evaluación retrospectiva vía API nunca funcionaba.
async function fetchPriceAtTime(symbol, targetTs) {
  const short = symbol.replace('USDT', '');
  const full  = short + 'USDT';
  try {
    const r = await fetch('/api/prices/lookup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ queries: [{ symbol: short, ts: targetTs }], tolMs: 5 * 60_000 }),
    });
    if (r.ok) {
      const hit = (await r.json()).results?.[0];
      if (hit && Number.isFinite(hit.price)) return hit.price;
    }
  } catch (_) { /* servidor sin snapshots — probamos Bybit */ }
  try {
    const endTs = targetTs + 120_000; // ventana de 2 minutos
    const data = await bybitGet(`/v5/market/kline?category=linear&symbol=${full}&interval=1&start=${targetTs}&end=${endTs}&limit=1`);
    if (data && data.result && data.result.list && data.result.list.length > 0) {
      return +data.result.list[0][4]; // Precio de cierre de Bybit
    }
  } catch (err) {
    console.error('Error obteniendo precio histórico para', full, err);
  }
  return null;
}

// Congela el resultado de cada señal la primera vez que cumple 30min / 1h de
// antigüedad, comparando el precio de entrada vs. el precio real de ese momento.
// Si la pestaña estuvo cerrada, busca retrospectivamente en trackHistory o consulta Bybit.
function evalStrategySignals() {
  const now = Date.now();
  let changed = false;

  for (const sig of stratSignals) {
    const age = now - sig.ts;

    // 1) Evaluar 30 minutos
    if (!sig.eval30 && age >= 30 * 60_000) {
      const targetTs = sig.ts + 30 * 60_000;
      if (age < 35 * 60_000) {
        const row = allRows.find(r => r.symbol === sig.symbol);
        if (row) {
          const movePct = (row.price - sig.entryPrice) / sig.entryPrice * 100 * (sig.dir === 'l' ? 1 : -1);
          sig.eval30 = { price: row.price, movePct, hit: movePct > 0 };
          changed = true;
        }
      } else {
        // Evaluación retrospectiva
        const hist = trackHistory[sig.symbol] || [];
        const matched = hist.find(h => Math.abs(h.ts - targetTs) <= 3 * 60_000);
        if (matched) {
          const movePct = (matched.price - sig.entryPrice) / sig.entryPrice * 100 * (sig.dir === 'l' ? 1 : -1);
          sig.eval30 = { price: matched.price, movePct, hit: movePct > 0 };
          changed = true;
        } else {
          fetchPriceAtTime(sig.symbol, targetTs).then(price => {
            if (price) {
              const movePct = (price - sig.entryPrice) / sig.entryPrice * 100 * (sig.dir === 'l' ? 1 : -1);
              sig.eval30 = { price, movePct, hit: movePct > 0 };
              safeSetItem('scalp_stratsig', JSON.stringify(stratSignals));
              syncToServer();
              renderStrategyCompare();
            }
          });
        }
      }
    }

    // 2) Evaluar 60 minutos
    if (!sig.eval60 && age >= 60 * 60_000) {
      const targetTs = sig.ts + 60 * 60_000;
      if (age < 65 * 60_000) {
        const row = allRows.find(r => r.symbol === sig.symbol);
        if (row) {
          const movePct = (row.price - sig.entryPrice) / sig.entryPrice * 100 * (sig.dir === 'l' ? 1 : -1);
          sig.eval60 = { price: row.price, movePct, hit: movePct > 0 };
          changed = true;
        }
      } else {
        // Evaluación retrospectiva
        const hist = trackHistory[sig.symbol] || [];
        const matched = hist.find(h => Math.abs(h.ts - targetTs) <= 3 * 60_000);
        if (matched) {
          const movePct = (matched.price - sig.entryPrice) / sig.entryPrice * 100 * (sig.dir === 'l' ? 1 : -1);
          sig.eval60 = { price: matched.price, movePct, hit: movePct > 0 };
          changed = true;
        } else {
          fetchPriceAtTime(sig.symbol, targetTs).then(price => {
            if (price) {
              const movePct = (price - sig.entryPrice) / sig.entryPrice * 100 * (sig.dir === 'l' ? 1 : -1);
              sig.eval60 = { price, movePct, hit: movePct > 0 };
              safeSetItem('scalp_stratsig', JSON.stringify(stratSignals));
              syncToServer();
              renderStrategyCompare();
            }
          });
        }
      }
    }
  }

  if (changed) {
    safeSetItem('scalp_stratsig', JSON.stringify(stratSignals));
    syncToServer();
  }
}

function renderStrategyCompare() {
  const grid = document.getElementById('sc-grid');
  if (!grid) return;
  const agg = (evals) => {
    if (!evals.length) return null;
    const hits = evals.filter(e => e.hit).length;
    return {
      n: evals.length,
      hits,
      winRate: Math.round(hits / evals.length * 100),
      avgMove: evals.reduce((a, e) => a + e.movePct, 0) / evals.length,
    };
  };
  const cards = Object.entries(STRAT_NAMES).map(([key, name]) => {
    const sigs  = stratSignals.filter(s => s.strategy === key
      && (stratRegimeFilter === 'ALL' || s.regime === stratRegimeFilter));
    const s30   = agg(sigs.map(s => s.eval30).filter(Boolean));
    const s60   = agg(sigs.map(s => s.eval60).filter(Boolean));
    return { key, name, total: sigs.length, s30, s60 };
  });
  // "Más peso" = mejor límite INFERIOR del IC de Wilson a 1h con n suficiente —
  // premia consistencia con muestra, no un 100% con 3 señales de suerte.
  const ranked = cards.filter(c => c.s60 && c.s60.n >= WR_MIN_N)
    .sort((a, b) => wilsonCI(b.s60.hits, b.s60.n).lo - wilsonCI(a.s60.hits, a.s60.n).lo);
  const bestKey = ranked.length ? ranked[0].key : null;

  // El Comparador como juez: estrategia sostenida (n≥30) con WR<48% a 1h se
  // marca "candidata a eliminar" — la evidencia manda, no la intuición de
  // que "podría servir en otro régimen".
  const ELIMINATE_MIN_N = 30, ELIMINATE_WR = 48;
  const isEliminate = c => c.s60 && c.s60.n >= ELIMINATE_MIN_N && c.s60.winRate < ELIMINATE_WR;

  grid.innerHTML = cards.map(c => {
    const row = (label, agg) => {
      if (!agg) return `<div class="sc-row"><span>${label}</span><b>${stratRegimeFilter === 'ALL' ? 'esperando…' : 'sin señales en ' + stratRegimeFilter}</b></div>`;
      const cls = agg.avgMove > 0 ? 'pos' : agg.avgMove < 0 ? 'neg' : '';
      return `<div class="sc-row"><span>${label} (n=${agg.n})</span>
        <span><b title="IC 95% (Wilson): ${wilsonCI(agg.hits, agg.n).lo.toFixed(0)}–${wilsonCI(agg.hits, agg.n).hi.toFixed(0)}%">${wrChip(agg.winRate, agg.n)}</b> · <span class="${cls}">${agg.avgMove >= 0 ? '+' : ''}${agg.avgMove.toFixed(2)}%</span></span></div>`;
    };
    const eliminate = isEliminate(c);
    return `<div class="sc-card${c.key === bestKey ? ' sc-best' : ''}${eliminate ? ' sc-eliminate' : ''}">
      <div class="sc-name">${c.key === bestKey ? '<span class="sc-crown">👑</span>' : ''}${c.name}<span style="margin-left:auto;font-size:9px;color:#2e4060;font-weight:400">${c.total} señales</span>${eliminate ? `<span class="sc-eliminate-pill" title="WR&lt;${ELIMINATE_WR}% sostenido con n≥${ELIMINATE_MIN_N} a 1h">🗑 candidata a eliminar</span>` : ''}</div>
      ${row('30 min', c.s30)}
      ${row('1 h', c.s60)}
    </div>`;
  }).join('');
}

const HOUR_BUCKETS = [
  { label: '00–04h', from: 0,  to: 4  },
  { label: '04–08h', from: 4,  to: 8  },
  { label: '08–12h', from: 8,  to: 12 },
  { label: '12–16h', from: 12, to: 16 },
  { label: '16–20h', from: 16, to: 20 },
  { label: '20–24h', from: 20, to: 24 },
];
const HOUR_MIN_SIGNALS = 3;

// Agrupa las señales del Comparador (ya evaluadas a 1h) por la hora local en la
// que se generó la señal, para detectar franjas horarias con mejor win rate.
function renderHourAnalysis() {
  const grid = document.getElementById('ha-grid');
  if (!grid) return;
  const evaluated = stratSignals
    .filter(s => s.eval60 && (stratRegimeFilter === 'ALL' || s.regime === stratRegimeFilter))
    .map(s => ({ hour: new Date(s.ts).getHours(), ...s.eval60 }));

  const buckets = HOUR_BUCKETS.map(b => {
    const evals = evaluated.filter(e => e.hour >= b.from && e.hour < b.to);
    if (evals.length < HOUR_MIN_SIGNALS) return { ...b, n: evals.length, winRate: null, avgMove: null };
    const hits = evals.filter(e => e.hit).length;
    const winRate = Math.round(hits / evals.length * 100);
    const avgMove = evals.reduce((a, e) => a + e.movePct, 0) / evals.length;
    return { ...b, n: evals.length, hits, winRate, avgMove };
  });

  const withData = buckets.filter(b => b.winRate != null);
  if (!withData.length) {
    grid.innerHTML = `<span class="sc-empty">Necesitas al menos ${HOUR_MIN_SIGNALS} señales evaluadas a 1h por franja — sigue dejando la app abierta.</span>`;
    return;
  }
  const bestHour = [...withData].sort((a, b) => b.winRate - a.winRate)[0];

  grid.innerHTML = buckets.map(b => {
    if (b.winRate == null) {
      return `<div class="ha-row">
        <span class="ha-label">${b.label}</span>
        <div class="ha-track"></div>
        <span class="ha-meta">${b.n}/${HOUR_MIN_SIGNALS} señales — esperando…</span>
      </div>`;
    }
    const isBest = b.label === bestHour.label;
    const cls = b.avgMove > 0 ? 'pos' : b.avgMove < 0 ? 'neg' : '';
    return `<div class="ha-row">
      <span class="ha-label">${b.label}${isBest ? '<span class="ha-crown">👑</span>' : ''}</span>
      <div class="ha-track"><div class="ha-bar${isBest ? ' ha-best' : ''}" style="width:${b.winRate}%"></div></div>
      <span class="ha-meta"><b title="IC 95% (Wilson): ${wilsonCI(b.hits, b.n).lo.toFixed(0)}–${wilsonCI(b.hits, b.n).hi.toFixed(0)}%">${wrChip(b.winRate, b.n)} acierto</b> · <span class="${cls}">${b.avgMove >= 0 ? '+' : ''}${b.avgMove.toFixed(2)}%</span> (n=${b.n})</span>
    </div>`;
  }).join('');
}
