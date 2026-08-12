/* public/track.js
 * Respaldo en servidor (solo favoritos), registro de snapshots de precio,
 * comparador de estrategias y análisis por hora.
 * Requiere core.js, screener.js y lab.js cargados antes.
 */

// ── Respaldo en servidor (Turso, vía /api/sync) ────────────────────────────
// SOLO se sincronizan los favoritos. Antes viajaban también trackHistory,
// stratSignals, trackLedger y confSignals: el GET pesaba 962 KB comprimidos
// (7,1 MB en crudo) y se pedía en CADA carga de página, lo que convertía abrir
// el screener en ~1,1 MB de egress y se comía el plan gratuito de 5 GB de
// Render en unas 4.600 visitas. Con solo los favoritos son <1 KB.
// El histórico y la evidencia del Comparador siguen existiendo, pero viven
// únicamente en localStorage de este navegador — no se comparten entre
// dispositivos y se pierden si limpias el navegador. Es el trade que toca:
// el respaldo costaba más ancho de banda del que valía.
let syncPushTimer = null;
function syncToServer() {
  clearTimeout(syncPushTimer);
  syncPushTimer = setTimeout(() => {
    fetch('/api/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ favorites: [...favorites] }),
    }).catch(() => {});
  }, 5000);
}

async function syncFromServer() {
  try {
    const res = await fetch('/api/sync');
    if (!res.ok) return;
    const data = await res.json();
    if (!data) return;
    if (Array.isArray(data.favorites)) {
      for (const sym of data.favorites) favorites.add(sym);
      safeSetItem('scalp_favs', JSON.stringify([...favorites]));
    }
  } catch (e) { /* sin servidor o sin Turso — seguimos solo con localStorage */ }
}

// ── Backfill del seguimiento desde el servidor de snapshots ─────────────────
// Con la pestaña cerrada no se registran snapshots locales, así que las señales
// previas (score ≥ 6) quedaban sin resolver para siempre. Al arrancar pedimos
// la serie de precios (cada 5 min) del servidor y la inyectamos como snapshots
// "solo precio" (score 0: nunca cuentan como señal nueva, solo sirven de
// referencia futura para el régimen propio de cada moneda).
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
      console.log(`[backfill] ${added} snapshots de precio recuperados del servidor`);
    }
  } catch (_) { /* servidor sin snapshots — no pasa nada */ }
}

// ── Historial de precios por símbolo ───────────────────────────────────────
// Ya no alimenta ningún panel: su único consumidor es detectSymbolRegime()
// (lab.js), el "régimen propio" que usan el Brief, el radar y el panel de
// salud. trackHistory acumula símbolos para siempre (solo poda a TRACK_MAX
// entradas POR símbolo), así que sin esta poda localStorage crece sin freno.
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


function fmtTrackSpan(ms) {
  const h = ms / 3_600_000;
  if (h < 1) return Math.round(ms / 60_000) + 'm';
  if (h < 24) return h.toFixed(1) + 'h';
  return (h / 24).toFixed(1) + 'd';
}

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

// Throttle: antes solo corría cuando el Lab estaba abierto (cada visita, con
// minutos de por medio). Al quedar siempre activo en cada ciclo (~10s) sin
// este freno, el Top-4 de 19 estrategias × 100 símbolos generaba ~73 señales
// nuevas/min — el buffer de STRAT_SIG_MAX se reciclaba en ~41min, botando
// señales ANTES de llegar a la marca de 1h (eval60 se quedaba en 0% para
// siempre). 1 escaneo/min es de sobra para no perderse rotaciones reales.
let _lastStratLogTs = 0;
const STRAT_LOG_INTERVAL_MS = 60_000;
function logStrategySignals(topFn) {
  const now = Date.now();
  if (now - _lastStratLogTs < STRAT_LOG_INTERVAL_MS) return;
  _lastStratLogTs = now;
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
//
// Límite de peticiones por ciclo: como ahora corre siempre (no solo con el Lab
// abierto), un backlog grande de señales viejas sin evaluar podría disparar
// cientos de fetchPriceAtTime() de golpe en el primer ciclo. Se procesan de a
// poco por llamada — el backlog se drena en varios ciclos de ~10s sin ráfagas.
const EVAL_FETCH_CAP = 15;
function evalStrategySignals() {
  const now = Date.now();
  let changed = false;
  let fetchBudget = EVAL_FETCH_CAP;

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
        } else if (fetchBudget > 0) {
          fetchBudget--;
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
        } else if (fetchBudget > 0) {
          fetchBudget--;
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
      <div class="sc-name">${c.key === bestKey ? '<span class="sc-crown">👑</span>' : ''}${c.name}<span style="margin-left:auto;font-size:9px;color:#9da6b5;font-weight:400">${c.total} señales</span>${eliminate ? `<span class="sc-eliminate-pill" title="WR&lt;${ELIMINATE_WR}% sostenido con n≥${ELIMINATE_MIN_N} a 1h">🗑 candidata a eliminar</span>` : ''}</div>
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
