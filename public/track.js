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
  if (!STRAT_NAMES[strategy]) return;   // retirada del Comparador: no ocupa plazas del buffer
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

// Comisión de ida y vuelta a mercado, en % de precio y sin apalancamiento.
const COMP_COMISION  = 0.13;
// Horas de mercado distintas antes de dar un veredicto. Las señales de una misma hora se
// mueven juntas: 300 señales en 3 horas solo dicen si esas 3 horas subieron o bajaron. El
// mismo historial daba +0,75 a una estrategia en un navegador y −0,43 en otro.
const COMP_MIN_HORAS = 48;

function compararEstrategias() {
  const media = (lista, f) => lista.reduce((a, s) => a + f(s), 0) / lista.length;
  const grupos = new Map(Object.keys(STRAT_NAMES).map(k => [k, []]));
  for (const s of stratSignals) {
    if (stratRegimeFilter !== 'ALL' && s.regime !== stratRegimeFilter) continue;
    const g = grupos.get(s.strategy);
    if (g) g.push(s);
  }
  return [...grupos].map(([key, sigs]) => {
    const e30 = sigs.filter(s => s.eval30), e60 = sigs.filter(s => s.eval60);
    const fila = {
      key, nombre: STRAT_NAMES[key], n: e60.length, horas: 0, veredicto: 'sin',
      neto: null, bruto: null, error: null, winRate: null,
      neto30: e30.length ? media(e30, s => s.eval30.movePct) - COMP_COMISION : null,
    };
    if (!e60.length) return fila;
    const bruto = media(e60, s => s.eval60.movePct);
    const porHora = new Map();
    for (const s of e60) {
      const h = Math.floor(s.ts / 36e5), a = porHora.get(h) || [0, 0];
      a[0] += s.eval60.movePct; a[1]++;
      porHora.set(h, a);
    }
    let suma = 0;
    for (const [, a] of porHora) suma += (a[0] - bruto * a[1]) ** 2;
    const error = 1.96 * Math.sqrt(suma) / e60.length, neto = bruto - COMP_COMISION;
    return {
      ...fila, bruto, neto, error, horas: porHora.size,
      winRate: Math.round(e60.filter(s => s.eval60.hit).length / e60.length * 100),
      veredicto: porHora.size < COMP_MIN_HORAS ? 'faltan' : neto - error > 0 ? 'gana' : neto + error < 0 ? 'pierde' : 'empate',
    };
  }).sort((a, b) => (b.neto ?? -Infinity) - (a.neto ?? -Infinity));
}

function renderStrategyCompare() {
  const filas = compararEstrategias();
  _labComparador = {
    total: filas.length,
    gana: filas.filter(f => f.veredicto === 'gana').length,
    pierde: filas.filter(f => f.veredicto === 'pierde').length,
    faltan: filas.filter(f => f.veredicto === 'faltan' || f.veredicto === 'sin').length,
  };
  const tbody = document.getElementById('sc-body');
  if (!tbody) return;
  const pct = v => (v == null ? '—' : `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}%`);
  const color = v => (v == null ? '#d7dde8' : v > 0 ? '#2fe08a' : v < 0 ? '#ff6680' : '#d7dde8');
  const VEREDICTO = {
    gana:   ['Gana', '#2fe08a'],
    pierde: ['Pierde', '#ff6680'],
    empate: ['Sin ventaja clara', '#eef2fa'],
    faltan: ['Faltan datos', '#ffd76a'],
    sin:    ['Sin señales aún', '#d7dde8'],
  };
  tbody.innerHTML = filas.map(f => {
    const [txt, col] = VEREDICTO[f.veredicto];
    return `<tr>
      <td class="pt-sym">${f.nombre}</td>
      <td style="color:${col};font-weight:700">${txt}</td>
      <td style="color:${color(f.neto)};font-weight:700" title="Con su margen de error al 95%, agrupando las señales por hora">${pct(f.neto)}${f.error != null ? ` <span style="font-weight:400;opacity:.75">±${f.error.toFixed(2)}</span>` : ''}</td>
      <td>${pct(f.bruto)}</td>
      <td>${f.n ? wrChip(f.winRate, f.n) : '—'}</td>
      <td style="color:${color(f.neto30)}">${pct(f.neto30)}</td>
      <td style="color:${f.horas >= COMP_MIN_HORAS ? '#d7dde8' : '#ffd76a'}">${f.horas} de ${COMP_MIN_HORAS}</td>
      <td>${f.n}</td>
    </tr>`;
  }).join('');
}
