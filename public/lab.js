/* public/lab.js
 * Laboratorio: bot de paper trading validado por el Comparador, estrategias
 * de scoring (percentil, régimen, z-score, ruptura, cascada, sector, ballenas,
 * beta, alpha), salud, señales accionables y renderLab().
 * Requiere core.js y screener.js cargados antes.
 */

// ── Paper Trading Bot — SOLO estrategias validadas por el Comparador ───────
// Antes había dos bots (confluencia genérica y alineado a régimen) que nunca
// se conectaron con lo que el propio Comparador demostraba que funcionaba.
// Este bot solo opera símbolos que salen en el Top de una estrategia que YA
// probó WR≥BOT_MIN_WR% sostenido con n≥BOT_MIN_N señales evaluadas a 1h —
// el mismo criterio (en positivo) que usa el Comparador para marcar
// "candidata a eliminar". Sin evidencia suficiente, el bot simplemente no opera.
const BOT_MIN_N  = 30;
const BOT_MIN_WR = 55;

const PT = { maxPos: 5, timeout: 4 * 3600_000 };

let paperTrades = JSON.parse(localStorage.getItem('scalp_pt') || '[]');

function savePT() { safeSetItem('scalp_pt', JSON.stringify(paperTrades)); }
function ptOpen()   { return paperTrades.filter(t => t.status === 'open'); }
function ptClosed() { return paperTrades.filter(t => t.status === 'closed'); }

function fmtDur(ms) {
  const h = Math.floor(ms / 3600_000), m = Math.floor((ms % 3600_000) / 60_000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// Drawdown máximo (caída desde el pico de PnL acumulado) y racha de pérdidas
// consecutivas más larga, recorriendo los trades cerrados en orden cronológico.
function ptExtraStats(closed) {
  if (!closed.length) return { maxDD: null, maxLossStreak: 0 };
  let cum = 0, peak = 0, maxDD = 0;
  let curStreak = 0, maxLossStreak = 0;
  for (const t of closed) {
    cum += (t.pnlUSD ?? 0);
    if (cum > peak) peak = cum;
    maxDD = Math.max(maxDD, peak - cum);
    if ((t.pnlPct ?? 0) < 0) { curStreak++; maxLossStreak = Math.max(maxLossStreak, curStreak); }
    else curStreak = 0;
  }
  return { maxDD, maxLossStreak };
}

function ptPnl(pos, currentPrice) {
  const dir = pos.direction === 'L' ? 1 : -1;
  return dir * (currentPrice - pos.entryPrice) / pos.entryPrice * 100;
}

function closePT(trade, reason, currentPrice) {
  trade.exitPrice  = currentPrice;
  trade.exitTime   = Date.now();
  trade.exitReason = reason;
  trade.pnlPct     = ptPnl(trade, currentPrice);
  trade.pnlUSD     = trade.pnlPct / 100 * 100;
  trade.status     = 'closed';
  savePT();
}

// Solo las 10 estrategias de scoring por símbolo — 'confluence'/'health'/
// 'promising' son paneles agregados sin estructura por símbolo+lado, no
// estrategias operables por el bot.
const BOT_STRAT_KEYS = ['cur', 'pct', 'reg', 'z', 'range', 'liq', 'sector', 'whale', 'beta', 'alpha'];

// Estrategias con evidencia real suficiente AHORA MISMO (Wilson, misma fuente
// que el Comparador): n≥BOT_MIN_N señales evaluadas a 1h y WR≥BOT_MIN_WR%.
// `strategyEvidence()` se define más abajo junto a renderActionableSignals().
function getValidatedStrategies() {
  return BOT_STRAT_KEYS.filter(key => {
    const ev = strategyEvidence(key);
    return ev.n >= BOT_MIN_N && ev.winRate >= BOT_MIN_WR;
  });
}

function checkPTExits() {
  const now = Date.now();
  for (const pos of ptOpen()) {
    const row = allRows.find(r => r.symbol === pos.symbol);
    if (!row) continue;
    const curr = row.price;
    const isLong = pos.direction === 'L';
    const hitTP = pos.tp   != null && (isLong ? curr >= pos.tp   : curr <= pos.tp);
    const hitSL = pos.stop != null && (isLong ? curr <= pos.stop : curr >= pos.stop);
    if (hitTP)                            { closePT(pos, 'TP',    curr); continue; }
    if (hitSL)                            { closePT(pos, 'SL',    curr); continue; }
    if (now - pos.entryTime > PT.timeout) { closePT(pos, 'TIME',  curr); continue; }
    const sc = scoreSymbol(row);
    const cs = isLong ? sc.longScore : sc.shortScore;
    if (cs < 3)                           { closePT(pos, 'SCORE', curr); }
  }
}

// Abre posiciones SOLO en símbolos que aparecen en el Top de una estrategia
// ya validada por el Comparador (ver getValidatedStrategies). Niveles de
// stop/TP por ATR — mismo cálculo que las tarjetas de "Señales accionables".
function checkPTEntries(topFn, validatedKeys) {
  if (!validatedKeys.length) return; // nada validado todavía: no operar
  if (ptOpen().length >= PT.maxPos) return;

  const candidates = new Map(); // symbol+side → { key, score }
  for (const key of validatedKeys) {
    for (const side of ['l', 's']) {
      for (const r of topFn(key, side)) {
        const k = r.symbol + side;
        if (!candidates.has(k)) candidates.set(k, { key, score: r[key][side] });
      }
    }
  }

  for (const [k, info] of candidates) {
    if (ptOpen().length >= PT.maxPos) break;
    const sym = k.slice(0, -1), side = k.slice(-1);
    const dir = side === 'l' ? 'L' : 'S';
    if (ptOpen().some(p => p.symbol === sym && p.direction === dir)) continue;

    const row = allRows.find(r => r.symbol === sym);
    if (!row?.price) continue;
    const atrPct = row.atr1h && row.price ? row.atr1h / row.price * 100 : null;
    if (atrPct == null) continue; // sin ATR no hay niveles fiables

    const isLong = dir === 'L';
    const stop = row.price * (1 - (isLong ? 1 : -1) * atrPct * 1.2 / 100);
    const tp   = row.price * (1 + (isLong ? 1 : -1) * atrPct * 1.8 / 100);

    const trade = {
      id: Date.now() + Math.random(),
      symbol: sym, direction: dir,
      entryPrice: row.price, entryTime: Date.now(),
      stop, tp,
      entryScore: { strategy: info.key, score: info.score },
      status: 'open',
    };
    paperTrades.push(trade);
    savePT();
  }
}

function clearPaperTrades() {
  if (!confirm('¿Borrar todo el historial de paper trading?')) return;
  paperTrades = [];
  savePT();
  renderPaperTrading([]);
}

function renderPaperTrading(validatedKeys) {
  const now    = Date.now();
  const open   = ptOpen();
  const closed = ptClosed();

  // Stats bar
  const winners  = closed.filter(t => t.pnlPct > 0);
  const winRate  = closed.length ? (winners.length / closed.length * 100).toFixed(0) + '%' : '—';
  const totalPnl = closed.reduce((a,t) => a + (t.pnlUSD ?? 0), 0);
  const pnls     = closed.map(t => t.pnlPct ?? 0);
  const best     = pnls.length ? Math.max(...pnls) : null;
  const worst    = pnls.length ? Math.min(...pnls) : null;

  const set = (id, html, color) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = html;
    if (color) el.style.color = color;
  };
  set('pt-stat-open',  `${open.length}/${PT.maxPos}`);
  set('pt-stat-total', closed.length);
  set('pt-stat-wr',    winRate, closed.length ? (parseFloat(winRate) >= 50 ? '#00c878' : '#ee5555') : '');
  set('pt-stat-pnl',   `${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}`, totalPnl >= 0 ? '#00c878' : '#ee5555');
  set('pt-stat-best',  best != null ? `+${best.toFixed(2)}%` : '—', '#00c878');
  set('pt-stat-worst', worst != null ? `${worst.toFixed(2)}%` : '—', '#ee5555');
  const ex = ptExtraStats(closed);
  set('pt-stat-dd',     ex.maxDD != null ? `-$${ex.maxDD.toFixed(2)}` : '—', ex.maxDD ? '#ee5555' : '');
  set('pt-stat-streak', closed.length ? `${ex.maxLossStreak}` : '—', ex.maxLossStreak >= 3 ? '#ee5555' : '');

  // Qué estrategias están validadas AHORA (WR≥55%, n≥30 a 1h) — sin esto el bot no opera
  const noteEl = document.getElementById('pt-validated-strats');
  if (noteEl) {
    noteEl.innerHTML = validatedKeys.length
      ? `✅ Validadas ahora mismo: ${validatedKeys.map(k => STRAT_NAMES[k] || k).join(', ')} (WR≥${BOT_MIN_WR}%, n≥${BOT_MIN_N} a 1h)`
      : `⏳ Ninguna estrategia tiene aún evidencia suficiente (WR≥${BOT_MIN_WR}%, n≥${BOT_MIN_N} a 1h) — el bot no abrirá posiciones hasta entonces.`;
  }

  // Open positions
  const openBody = document.getElementById('pt-open-body');
  if (openBody) {
    if (!open.length) {
      openBody.innerHTML = `<tr><td colspan="9" class="pt-empty">Sin posiciones abiertas · solo opera estrategias ya validadas por el Comparador</td></tr>`;
    } else {
      openBody.innerHTML = open.map(pos => {
        const row    = allRows.find(r => r.symbol === pos.symbol);
        const curr   = row?.price ?? pos.entryPrice;
        const pnlPct = ptPnl(pos, curr);
        const pnlUSD = pnlPct / 100 * 100;
        const pnlC   = pnlPct >= 0 ? 'pt-pnl-pos' : 'pt-pnl-neg';
        const sc     = row ? scoreSymbol(row) : null;
        const cs     = sc ? (pos.direction === 'L' ? sc.longScore : sc.shortScore) : '—';
        const csC    = cs >= 6 ? '#00c878' : cs >= 3 ? '#e09030' : '#ee5555';
        return `<tr>
          <td class="pt-sym">${pos.symbol}</td>
          <td class="pt-${pos.direction === 'L' ? 'long' : 'short'}">${pos.direction}</td>
          <td style="color:#4a6080">$${fmtPrice(pos.entryPrice)}</td>
          <td style="color:#8090b0">$${fmtPrice(curr)}</td>
          <td class="${pnlC}">${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%</td>
          <td class="${pnlC}">${pnlUSD >= 0 ? '+' : ''}$${pnlUSD.toFixed(2)}</td>
          <td style="color:${csC};font-weight:700">${cs}</td>
          <td style="color:#4a6080">${STRAT_NAMES[pos.entryScore?.strategy] || '—'}</td>
          <td style="color:#3a4a60">${fmtDur(now - pos.entryTime)}</td>
        </tr>`;
      }).join('');
    }
  }

  // Closed trades (last 20, newest first)
  const closedBody = document.getElementById('pt-closed-body');
  if (closedBody) {
    const recent = [...closed].reverse().slice(0, 20);
    if (!recent.length) {
      closedBody.innerHTML = `<tr><td colspan="8" class="pt-empty">Sin trades cerrados aún</td></tr>`;
    } else {
      const reasonMap = { TP:'🎯 TP', SL:'🛑 SL', SCORE:'📉 Score', TIME:'⏱ Tiempo' };
      const reasonClass = { TP:'pt-reason-tp', SL:'pt-reason-sl', SCORE:'pt-reason-score', TIME:'pt-reason-time' };
      closedBody.innerHTML = recent.map(t => {
        const pnlC = t.pnlPct >= 0 ? 'pt-pnl-pos' : 'pt-pnl-neg';
        return `<tr>
          <td class="pt-sym">${t.symbol}</td>
          <td class="pt-${t.direction === 'L' ? 'long' : 'short'}">${t.direction}</td>
          <td style="color:#4a6080">$${fmtPrice(t.entryPrice)}</td>
          <td style="color:#4a6080">$${fmtPrice(t.exitPrice)}</td>
          <td class="${pnlC}">${t.pnlPct >= 0 ? '+' : ''}${t.pnlPct?.toFixed(2)}%</td>
          <td class="${pnlC}">${t.pnlUSD >= 0 ? '+' : ''}$${t.pnlUSD?.toFixed(2)}</td>
          <td class="${reasonClass[t.exitReason] ?? ''}">${reasonMap[t.exitReason] ?? t.exitReason}</td>
          <td style="color:#3a4a60">${fmtDur(t.exitTime - t.entryTime)}</td>
        </tr>`;
      }).join('');
    }
  }
}

// ── 🎯 Patrones W/M — seguimiento hasta objetivo/stop (SIN límite de tiempo) ─
// A diferencia del bot de arriba (ATR, timeout a 4h, exige estrategia ya
// validada), esto es observación pura: ¿el objetivo medido del patrón
// (cuello ± profundidad) realmente se cumple antes de que salte el stop
// sugerido? No se cierra por tiempo — se queda abierto indefinidamente hasta
// tocar uno de los dos niveles. patterns.js abre cada entrada al romper el
// cuello (trackPatternSignal) y esto se resuelve cada ciclo, tenga la pestaña
// Lab abierta o no. Trailing stop: pendiente de evaluar más adelante.
let patternTrack = JSON.parse(localStorage.getItem('scalp_pattern_track') || '[]');
function savePatternTrack() { safeSetItem('scalp_pattern_track', JSON.stringify(patternTrack)); }
function patternTrackOpen()   { return patternTrack.filter(t => t.status === 'open'); }
function patternTrackClosed() { return patternTrack.filter(t => t.status !== 'open'); }

// Llamada por patterns.js cuando un patrón entra en 'breaking'. Dedup: si ya
// hay una entrada abierta para ese símbolo+lado, no abre otra.
function trackPatternSignal(row, p) {
  const side = p.type === 'W' ? 'L' : 'S';
  if (patternTrack.some(t => t.status === 'open' && t.symbol === row.symbol && t.side === side)) return;
  patternTrack.push({
    id: Date.now() + Math.random(),
    symbol: row.symbol, side, type: p.type,
    entryPrice: row.price, entryTime: Date.now(),
    target: p.target, stop: p.stop, quality: p.quality,
    status: 'open',
  });
  if (patternTrack.length > 500) patternTrack.splice(0, patternTrack.length - 500);
  savePatternTrack();
}

function closePatternTrack(t, reason, price) {
  const dir = t.side === 'L' ? 1 : -1;
  t.exitPrice  = price;
  t.exitTime   = Date.now();
  t.exitReason = reason; // 'TARGET' | 'STOP'
  t.pnlPct     = dir * (price - t.entryPrice) / t.entryPrice * 100;
  t.status     = 'closed';
  savePatternTrack();
  showToast(
    `${t.symbol} patrón ${t.type} ${reason === 'TARGET' ? '🎯 objetivo alcanzado' : '🛑 stop alcanzado'} · ${t.pnlPct >= 0 ? '+' : ''}${t.pnlPct.toFixed(2)}%`,
    t.pnlPct >= 0 ? 'long' : 'short'
  );
}

// Sin timeout a propósito — llamar en CADA ciclo de datos (no solo con el Lab
// abierto) para que se resuelva aunque estés viendo otra pestaña.
function checkPatternTrackOutcomes() {
  for (const t of patternTrackOpen()) {
    const row = allRows.find(r => r.symbol === t.symbol);
    if (!row?.price) continue;
    const isLong = t.side === 'L';
    const hitTarget = isLong ? row.price >= t.target : row.price <= t.target;
    const hitStop   = isLong ? row.price <= t.stop   : row.price >= t.stop;
    if (hitTarget)      closePatternTrack(t, 'TARGET', row.price);
    else if (hitStop)   closePatternTrack(t, 'STOP',   row.price);
  }
}

function clearPatternTrack() {
  if (!confirm('¿Borrar todo el seguimiento de patrones W/M?')) return;
  patternTrack = [];
  savePatternTrack();
  renderPatternTrack();
}

function renderPatternTrack() {
  const open   = patternTrackOpen();
  const closed = patternTrackClosed(); // ya solo tiene TARGET/STOP (no hay otro motivo de cierre)

  const wins    = closed.filter(t => t.exitReason === 'TARGET');
  const winRate = closed.length ? Math.round(wins.length / closed.length * 100) : null;
  const avgPnl  = closed.length ? closed.reduce((a, t) => a + t.pnlPct, 0) / closed.length : null;
  const avgTimeMs = closed.length ? closed.reduce((a, t) => a + (t.exitTime - t.entryTime), 0) / closed.length : null;

  const set = (id, html, color) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = html;
    if (color) el.style.color = color;
  };
  set('patt-stat-open',  `${open.length}`);
  set('patt-stat-total', `${closed.length}`);
  set('patt-stat-wr',    closed.length ? wrChip(winRate, closed.length) : '—', closed.length ? (winRate >= 50 ? '#00c878' : '#ee5555') : '');
  set('patt-stat-pnl',   avgPnl != null ? `${avgPnl >= 0 ? '+' : ''}${avgPnl.toFixed(2)}%` : '—', avgPnl != null ? (avgPnl >= 0 ? '#00c878' : '#ee5555') : '');
  set('patt-stat-time',  avgTimeMs != null ? fmtDur(avgTimeMs) : '—');

  const openBody = document.getElementById('patt-open-body');
  if (openBody) {
    if (!open.length) {
      openBody.innerHTML = `<tr><td colspan="8" class="pt-empty">Sin patrones en seguimiento — se registran solos al romper el cuello</td></tr>`;
    } else {
      openBody.innerHTML = open.map(t => {
        const row  = allRows.find(r => r.symbol === t.symbol);
        const curr = row?.price ?? t.entryPrice;
        const isLong = t.side === 'L';
        const progress = isLong
          ? (curr - t.entryPrice) / (t.target - t.entryPrice) * 100
          : (t.entryPrice - curr) / (t.entryPrice - t.target) * 100;
        const progC = progress >= 0 ? '#00c878' : '#ee5555';
        return `<tr>
          <td class="pt-sym">${t.symbol}</td>
          <td class="pt-${isLong ? 'long' : 'short'}">${t.type} ${isLong ? '▲' : '▼'}</td>
          <td style="color:#4a6080">$${fmtPrice(t.entryPrice)}</td>
          <td style="color:#8090b0">$${fmtPrice(curr)}</td>
          <td style="color:#00c878">$${fmtPrice(t.target)}</td>
          <td style="color:#ee5555">$${fmtPrice(t.stop)}</td>
          <td style="color:${progC}">${progress.toFixed(0)}%</td>
          <td style="color:#3a4a60">${fmtDur(Date.now() - t.entryTime)}</td>
        </tr>`;
      }).join('');
    }
  }

  const closedBody = document.getElementById('patt-closed-body');
  if (closedBody) {
    const recent = [...closed].reverse().slice(0, 20);
    if (!recent.length) {
      closedBody.innerHTML = `<tr><td colspan="5" class="pt-empty">Sin patrones completados aún</td></tr>`;
    } else {
      closedBody.innerHTML = recent.map(t => {
        const pnlC = t.pnlPct >= 0 ? 'pt-pnl-pos' : 'pt-pnl-neg';
        return `<tr>
          <td class="pt-sym">${t.symbol}</td>
          <td class="pt-${t.side === 'L' ? 'long' : 'short'}">${t.type} ${t.side === 'L' ? '▲' : '▼'}</td>
          <td class="${t.exitReason === 'TARGET' ? 'pt-reason-tp' : 'pt-reason-sl'}">${t.exitReason === 'TARGET' ? '🎯 Objetivo' : '🛑 Stop'}</td>
          <td class="${pnlC}">${t.pnlPct >= 0 ? '+' : ''}${t.pnlPct.toFixed(2)}%</td>
          <td style="color:#3a4a60">${fmtDur(t.exitTime - t.entryTime)}</td>
        </tr>`;
      }).join('');
    }
  }
}

// ── Laboratorio de estrategias ──────────────────────────────────────────────

function buildPercentileFns(rows) {
  const keys = ['oi5m','oi1h','oi4h','vol1hPct','price5mPct','price1hPct','price4hPct','cvd5m'];
  const fns = {};
  for (const k of keys) {
    const sorted = rows.map(r => r[k] ?? 0).sort((a,b) => a-b);
    fns[k] = v => {
      if (v == null) return 50;
      let lo = 0, hi = sorted.length;
      while (lo < hi) { const m = (lo+hi)>>1; if (sorted[m] < v) lo = m+1; else hi = m; }
      return lo / sorted.length * 100;
    };
  }
  return fns;
}

function scorePercentile(row, pFns) {
  const p = k => pFns[k](row[k]);
  let L = 0, S = 0;
  const oi5p = p('oi5m'), oi1p = p('oi1h'), vp = p('vol1hPct');
  const p5p  = p('price5mPct'), p1p = p('price1hPct');

  // OI alto percentil suma a ambas direcciones (confirma actividad)
  if      (oi5p > 90) { L += 3; S += 3; }
  else if (oi5p > 75) { L += 2; S += 2; }
  else if (oi5p > 60) { L += 1; S += 1; }

  if      (oi1p > 90) { L += 3; S += 3; }
  else if (oi1p > 75) { L += 2; S += 2; }
  else if (oi1p > 60) { L += 1; S += 1; }

  // Precio: percentil alto = subiendo = Long
  if      (p5p > 80) L += 2; else if (p5p > 65) L += 1;
  if      (p1p > 80) L += 2; else if (p1p > 60) L += 1;
  // Precio: percentil bajo = bajando = Short
  if      (p5p < 20) S += 2; else if (p5p < 35) S += 1;
  if      (p1p < 20) S += 2; else if (p1p < 40) S += 1;

  // Volumen
  if (vp > 90) { L += 2; S += 2; } else if (vp > 75) { L += 1; S += 1; }

  // CVD (flujo agresor 5m): percentil alto = presión compradora dominante
  const cvdp = p('cvd5m');
  if      (cvdp > 85) L += 2; else if (cvdp > 70) L += 1;
  if      (cvdp < 15) S += 2; else if (cvdp < 30) S += 1;

  // Penalización si precio 1h va en contra
  if (p1p < 35) L = Math.floor(L * 0.35);
  if (p1p > 65) S = Math.floor(S * 0.35);

  // Piso de liquidez (mismo umbral que scoreSymbol/potentialScore): en volumen
  // bajo, un percentil "alto" de OI/precio suele ser ruido de libro delgado.
  if ((row.vol1hUSD ?? 0) < 300_000) { L = Math.min(L, 4); S = Math.min(S, 4); }

  return { longScore: Math.min(10, Math.max(0, L)), shortScore: Math.min(10, Math.max(0, S)) };
}

function detectRegime(rows) {
  const valid = rows.filter(r => r.oi1h != null && r.price1hPct != null);
  if (valid.length < 10) return { regime: 'CARGANDO', color: '#4a6080', desc: 'Datos insuficientes', bullPct: 0, bearPct: 0, avgOI1h: 0, avgVol: 0 };
  const n = v => v ?? 0;
  const bull = valid.filter(r => n(r.oi1h) > 0 && n(r.price1hPct) > 0).length;
  const bear = valid.filter(r => n(r.oi1h) > 0 && n(r.price1hPct) < 0).length;
  const tot  = valid.length;
  const bullPct = bull / tot * 100, bearPct = bear / tot * 100;
  const avgOI1h = valid.reduce((a,r) => a + n(r.oi1h), 0) / tot;
  const avgVol  = valid.reduce((a,r) => a + n(r.vol1hPct), 0) / tot;
  let regime, color, desc;
  if      (bullPct > 55) { regime = 'ALCISTA';  color = '#00c878'; desc = `${bullPct.toFixed(0)}% pares OI↑+P↑`; }
  else if (bearPct > 45) { regime = 'BAJISTA';  color = '#ee4444'; desc = `${bearPct.toFixed(0)}% pares OI↑+P↓`; }
  else if (avgVol  > 25) { regime = 'VOLÁTIL';  color = '#e09030'; desc = `Vol +${avgVol.toFixed(0)}% sobre media`; }
  else                   { regime = 'LATERAL';   color = '#4a7a8a'; desc = 'Bajo momentum, mercado mixto'; }
  return { regime, color, desc, bullPct, bearPct, avgOI1h, avgVol };
}

// Cuenta cuántas temporalidades de precio (5m/1h/4h/24h) coinciden en
// dirección — una moneda "alineada" en todas suele tener movimientos más
// sostenidos que una que solo se mueve en una temporalidad puntual.
function timeframeAlignment(row) {
  const tfs = [
    { label: '5m',  val: row.price5mPct },
    { label: '1h',  val: row.price1hPct },
    { label: '4h',  val: row.price4hPct },
    { label: '24h', val: row.price24hPct },
  ].filter(tf => tf.val != null && tf.val !== 0);
  if (tfs.length < 2) return null;
  const pos = tfs.filter(tf => tf.val > 0).length;
  const neg = tfs.length - pos;
  const dir   = pos >= neg ? 'up' : 'down';
  const count = dir === 'up' ? pos : neg;
  return { count, total: tfs.length, dir };
}

function tfAlignmentBadge(align) {
  if (!align) return '';
  const strong = align.count === align.total && align.total >= 3;
  const arrow  = align.dir === 'up' ? '↑' : '↓';
  const color  = align.dir === 'up' ? '#00c878' : '#ee5555';
  return `<span class="tf-align${strong ? ' tf-align-strong' : ''}" style="color:${color}">⏱ ${align.count}/${align.total}${arrow}</span>`;
}

// Régimen propio de la moneda: a diferencia de detectRegime() (mercado
// completo), mide si ESTA moneda está rompiendo su propio rango reciente
// usando su historial de snapshots ya guardado (trackHistory).
function detectSymbolRegime(sym) {
  const hist = trackHistory[sym] || [];
  if (hist.length < 10) return null;
  const prices = hist.map(s => s.price);
  const last = prices[prices.length - 1];
  const max = Math.max(...prices), min = Math.min(...prices);
  const range = max - min;
  const span = fmtTrackSpan(Date.now() - hist[0].ts);
  if (range <= 0 || min <= 0) return null;
  const pos = (last - min) / range;       // 0 = en el mínimo, 1 = en el máximo
  const widthPct = range / min * 100;     // ancho del rango relativo al precio
  let regime, desc, color;
  if      (pos >= 0.92)        { regime = 'RUPTURA ↑';  desc = `precio en máx. de ${span}`; color = '#00c878'; }
  else if (pos <= 0.08)        { regime = 'RUPTURA ↓';  desc = `precio en mín. de ${span}`; color = '#ee5555'; }
  else if (widthPct < 1.5)     { regime = 'COMPRIMIDO'; desc = `rango estrecho (${widthPct.toFixed(2)}% en ${span})`; color = '#e0a830'; }
  else                         { regime = 'EN RANGO';   desc = `${Math.round(pos * 100)}% del rango de ${span}`; color = '#4a7a8a'; }
  return { regime, desc, color };
}

function scoreRegime(row, regime) {
  const base = scoreSymbol(row);
  let L = base.longScore, S = base.shortScore;
  if      (regime.regime === 'ALCISTA') { L = Math.min(10, L + 2); S = Math.max(0, S - 1); }
  else if (regime.regime === 'BAJISTA') { S = Math.min(10, S + 2); L = Math.max(0, L - 1); }
  else if (regime.regime === 'VOLÁTIL') { L = Math.min(L, 7); S = Math.min(S, 7); }
  else                                  { L = Math.min(L, 5); S = Math.min(S, 5); }
  return { longScore: L, shortScore: S };
}

function zScoreSymbol(row) {
  const snaps = oiSnaps.get(row.symbol + 'USDT') || [];
  if (snaps.length < 8) return null;
  const changes = [];
  for (let i = 1; i < Math.min(snaps.length, 60); i++) {
    if (snaps[i].oiUSD > 0) changes.push((snaps[i-1].oiUSD - snaps[i].oiUSD) / snaps[i].oiUSD * 100);
  }
  if (changes.length < 5) return null;
  const mean = changes.reduce((a,b) => a+b, 0) / changes.length;
  const std  = Math.sqrt(changes.map(c => (c-mean)**2).reduce((a,b) => a+b, 0) / changes.length);
  const curr = row.oi5m ?? 0;
  const z = std > 0.01 ? (curr - mean) / std : 0;
  const absZ = Math.abs(z);
  let score = absZ > 3 ? 9 : absZ > 2.5 ? 7 : absZ > 2 ? 5 : absZ > 1.5 ? 3 : absZ > 1 ? 1 : 0;
  const priceDir = z > 0 ? (row.price5mPct ?? 0) > 0 : (row.price5mPct ?? 0) < 0;
  if (!priceDir) score = Math.floor(score * 0.35);
  // Piso de liquidez: un z-score de OI "extremo" en una moneda de libro
  // delgado suele ser un par de órdenes moviendo el número, no flujo real.
  if ((row.vol1hUSD ?? 0) < 300_000) score = Math.min(score, 4);
  const isLong = z > 0;
  return { z, zStr: z.toFixed(1) + 'σ', score, isLong, longScore: isLong ? score : 0, shortScore: isLong ? 0 : score };
}

// ── Estrategia: Ruptura de rango propio ──────────────────────────────────────
// Reutiliza detectSymbolRegime(): si el precio rompe su propio rango reciente
// (RUPTURA ↑/↓) puntúa fuerte en esa dirección; rango/compresión apenas señala.
function scoreOwnRangeBreakout(row) {
  // El historial propio (trackHistory) solo es fiable si cubre ≥2h y ≥30
  // snapshots: con menos, "romper su rango" es ruido de minutos (p. ej. un
  // rebote de 30 min marcaba RUPTURA ↑ en una moneda en plena caída diaria).
  // Para monedas sin historial suficiente: fallback por ATR (price4h vs ATR).
  const hist = trackHistory[row.symbol] || [];
  const spanMs = hist.length ? Date.now() - hist[0].ts : 0;
  const histOk = hist.length >= 30 && spanMs >= 2 * 3600_000;
  const r = histOk ? detectSymbolRegime(row.symbol) : fallbackSymbolRegime(row);
  if (!r) return { longScore: 0, shortScore: 0 };

  // Confirmación por flujo: CVD 5m en la dirección de la ruptura
  const cvdUp = (row.cvd5m ?? 0) > 0, cvdDn = (row.cvd5m ?? 0) < 0;
  if (r.regime === 'RUPTURA ↑') return { longScore: Math.min(10, 7 + (cvdUp ? 1 : 0)), shortScore: 0 };
  if (r.regime === 'RUPTURA ↓') return { longScore: 0, shortScore: Math.min(10, 7 + (cvdDn ? 1 : 0)) };
  if (r.regime === 'COMPRIMIDO') {
    const up = (row.price1hPct ?? 0) > 0;
    return up ? { longScore: 3, shortScore: 0 } : { longScore: 0, shortScore: 3 };
  }
  return { longScore: 0, shortScore: 0 }; // EN RANGO / VOLÁTIL: sin señal de ruptura
}

// ── Estrategia: Cascada de liquidaciones ─────────────────────────────────────
// Reutiliza liqSumCache (USD liquidados en los últimos 5min por símbolo): un
// desbalance fuerte hacia liq.s (cortos liquidados → short squeeze) es presión
// alcista; hacia liq.l (largos liquidados → stop-loss en cadena) es bajista.
function scoreLiquidationCascade(row) {
  const liq = liqSumCache.get(row.symbol);
  if (!liq) return { longScore: 0, shortScore: 0 };
  const total = liq.l + liq.s;
  if (total < 20_000) return { longScore: 0, shortScore: 0 };
  const imbalance = Math.abs(liq.s - liq.l) / total;
  if (imbalance < 0.25) return { longScore: 0, shortScore: 0 };
  const magnitude = total > 300_000 ? 9 : total > 150_000 ? 7 : total > 75_000 ? 5 : total > 30_000 ? 3 : 2;
  let score = Math.min(10, Math.round(magnitude * (0.5 + imbalance * 0.5)));
  // Confirmación por CVD: cascada de cortos + flujo comprador (o viceversa) = +1
  const bull = liq.s > liq.l;
  const cvd = row.cvd5m ?? 0;
  if ((bull && cvd > 0) || (!bull && cvd < 0)) score = Math.min(10, score + 1);
  return bull ? { longScore: score, shortScore: 0 } : { longScore: 0, shortScore: score };
}

// ── Estrategia: Rotación sectorial ───────────────────────────────────────────
// Mapa fijo símbolo → sector (Bybit no expone categorías). Premia a las
// "rezagadas" de un sector que ya está en movimiento fuerte — la idea de que
// el capital rota dentro del mismo grupo y las que faltan por moverse tienen
// más recorrido potencial.
const SECTOR_MAP = {
  BTC:'L1', ETH:'L1', SOL:'L1', BNB:'L1', AVAX:'L1', ADA:'L1', DOT:'L1', NEAR:'L1',
  APT:'L1', SUI:'L1', TON:'L1', TRX:'L1', ATOM:'L1', INJ:'L1', SEI:'L1', TIA:'L1', ICP:'L1',
  HYPE:'L1', XPL:'L1',
  DOGE:'MEME', SHIB:'MEME', PEPE:'MEME', WIF:'MEME', BONK:'MEME', FLOKI:'MEME', TRUMP:'MEME',
  '1000PEPE':'MEME', '1000SHIB':'MEME', '1000BONK':'MEME', '1000FLOKI':'MEME', SHIB1000:'MEME',
  FARTCOIN:'MEME', PENGU:'MEME', PUMPFUN:'MEME',
  UNI:'DEFI', AAVE:'DEFI', LDO:'DEFI', CRV:'DEFI', MKR:'DEFI', SUSHI:'DEFI', COMP:'DEFI', SNX:'DEFI', GMX:'DEFI', DYDX:'DEFI', PENDLE:'DEFI',
  ENA:'DEFI', ONDO:'DEFI', JUP:'DEFI',
  ARB:'L2', OP:'L2', POL:'L2', STRK:'L2', ZK:'L2', MANTA:'L2', METIS:'L2',
  LINK:'ORACLE', PYTH:'ORACLE', BAND:'ORACLE',
  RENDER:'AI', RNDR:'AI', FET:'AI', TAO:'AI', WLD:'AI', AKT:'AI', ARKM:'AI', VIRTUAL:'AI',
  XRP:'PAYMENTS', XLM:'PAYMENTS', ALGO:'PAYMENTS', HBAR:'PAYMENTS', LTC:'PAYMENTS', BCH:'PAYMENTS',
};
function scoreSectorRotation(row, allRowsRef) {
  const sector = SECTOR_MAP[row.symbol];
  if (!sector) return { longScore: 0, shortScore: 0 };
  const peers = allRowsRef.filter(r => r.symbol !== row.symbol && SECTOR_MAP[r.symbol] === sector);
  if (peers.length < 2) return { longScore: 0, shortScore: 0 };
  const avg = key => peers.reduce((a, r) => a + (r[key] ?? 0), 0) / peers.length;
  const peer1h = avg('price1hPct'), peer4h = avg('price4hPct');
  const own1h  = row.price1hPct ?? 0;
  let L = 0, S = 0;
  if (peer1h > 0.5 && peer4h > 0) {
    L += peer1h > 1.5 ? 4 : peer1h > 0.8 ? 3 : 2;
    L += own1h > 0 ? 1 : 2; // rezagada en sector caliente = más recorrido potencial
  }
  if (peer1h < -0.5 && peer4h < 0) {
    S += peer1h < -1.5 ? 4 : peer1h < -0.8 ? 3 : 2;
    S += own1h < 0 ? 1 : 2;
  }
  // Piso de liquidez sobre la PROPIA moneda: que el sector se mueva no sirve
  // si la rezagada es tan ilíquida que no se puede entrar/salir limpio.
  if ((row.vol1hUSD ?? 0) < 300_000) { L = Math.min(L, 4); S = Math.min(S, 4); }
  return { longScore: Math.min(10, L), shortScore: Math.min(10, S) };
}

// ── Estrategia: Actividad de ballenas ────────────────────────────────────────
// Aproxima "tamaño grande entrando" sin nuevas llamadas a la API: un salto de
// volumen muy por encima de lo normal junto con OI creciendo pero precio casi
// plano sugiere absorción (acumulación o distribución silenciosa de gran tamaño).
function scoreWhaleActivity(row) {
  const n = v => v ?? 0;
  const volSpike = n(row.vol1hPct);
  if (volSpike < 40) return { longScore: 0, shortScore: 0 };
  // Piso de liquidez ABSOLUTO: un spike del 400% es ruido si viene de $10k/h
  // a $50k/h. Sin este piso, "ballenas" terminaba detectando microcaps ilíquidas.
  if (n(row.vol1hUSD) < 300_000) return { longScore: 0, shortScore: 0 };
  const oi5 = n(row.oi5m), price5 = n(row.price5mPct);
  const big = volSpike > 80;
  let L = 0, S = 0;
  const absorbing = oi5 > 0.15 && Math.abs(price5) < 0.15;
  if (absorbing) {
    // Dirección por CVD real (flujo agresor 5m): comprador = acumulación,
    // vendedor = distribución. Fallback a funding si el CVD no es significativo.
    const vol5mUSD = n(row.vol1hUSD) / 12;
    const cvd = row.cvd5m;
    if (cvd != null && vol5mUSD > 0 && Math.abs(cvd) > vol5mUSD * 0.08) {
      if (cvd > 0) L += big ? 5 : 3; else S += big ? 5 : 3;
    } else if (n(row.fundingRate) <= 0) {
      L += big ? 4 : 2; // sin CVD claro: señal más débil
    } else {
      S += big ? 4 : 2;
    }
  } else if (oi5 > 0.2 && price5 > 0.1) {
    L += big ? 3 : 1;
  } else if (oi5 > 0.2 && price5 < -0.1) {
    S += big ? 3 : 1;
  }
  return { longScore: Math.min(10, L), shortScore: Math.min(10, S) };
}

// ── Estrategia: Beta rezagada (lead-lag con BTC) ─────────────────────────────
// BTC se mueve con impulso claro (≥0.6×ATR en 15m) y las seguidoras confirmadas
// (ρ≥0.6) tienden a converger. Señal: seguidora que AÚN no se movió (gap) y
// cuyo flujo no va en contra → operar en la dirección de BTC antes de converger.
function scoreBetaLag(row, btcRow) {
  const zero = { longScore: 0, shortScore: 0 };
  if (!btcRow || row.symbol === 'BTC') return zero;
  const corr = row.btcCorr;
  if (corr == null || corr < 0.6) return zero;
  const btcAtr15 = btcRow.atr1h && btcRow.price ? (btcRow.atr1h / btcRow.price * 100) * 0.5 : null; // ATR escalado a 15m (√0.25)
  const ownAtr15 = row.atr1h && row.price ? (row.atr1h / row.price * 100) * 0.5 : null;
  if (!btcAtr15 || !ownAtr15) return zero;
  const btcMove = (btcRow.price15mPct ?? 0) / btcAtr15;   // impulso de BTC en ×ATR15
  const ownMove = (row.price15mPct ?? 0) / ownAtr15;
  if (Math.abs(btcMove) < 0.6) return zero;               // BTC sin impulso claro
  const dirUp = btcMove > 0;
  const followed = dirUp ? ownMove : -ownMove;            // cuánto siguió ya (en su propio ATR)
  if (followed > Math.abs(btcMove) * 0.4) return zero;    // ya convergió: el trade pasó
  if (followed < -0.5) return zero;                       // va fuerte en contra: divergencia, no lag
  let sc = 3;
  sc += corr >= 0.8 ? 2 : 1;                              // seguidora muy confirmada
  sc += Math.min(3, Math.abs(btcMove));                   // magnitud del impulso de BTC
  if (Math.abs(btcMove) - Math.max(followed, 0) > 1) sc += 1; // gap grande = más recorrido
  const cvd = row.cvd5m ?? 0;
  if ((dirUp && cvd < 0) || (!dirUp && cvd > 0)) sc -= 1; // flujo propio en contra
  sc = Math.max(0, Math.min(10, Math.round(sc)));
  return dirUp ? { longScore: sc, shortScore: 0 } : { longScore: 0, shortScore: sc };
}

// ── Estrategia: Alpha propio (descorrelacionadas con flujo) ──────────────────
// Monedas con ρ≈0 (movimiento por narrativa propia, inmunes al chop de BTC)
// con momentum real (≥1×ATR) Y confirmación: CVD significativo o racha de OI
// sostenida en la misma dirección. Liquidez mínima para que el scalp sea viable.
function scoreDecorrAlpha(row) {
  const zero = { longScore: 0, shortScore: 0 };
  const corr = row.btcCorr;
  if (corr == null || Math.abs(corr) > 0.25) return zero;
  if ((row.turnover24h ?? 0) < 20e6) return zero;
  const ma = row.moveAtr1h;
  if (ma == null || Math.abs(ma) < 1) return zero;        // exige movimiento real para SU volatilidad
  const dirUp = ma > 0;
  const vol5m = (row.vol1hUSD ?? 0) / 12;
  const cvd = row.cvd5m;
  const cvdOk = cvd != null && vol5m > 0 && (dirUp ? cvd > vol5m * 0.1 : cvd < -vol5m * 0.1);
  const st = oiStreaks.get(row.symbol);
  const streakMin = st && st.dir !== 0 ? (Date.now() - st.since) / 60_000 : 0;
  const oiOk = !!st && ((dirUp && st.dir > 0) || (!dirUp && st.dir < 0)) && streakMin >= 3;
  if (!cvdOk && !oiOk) return zero;                       // sin confirmación: no hay señal
  let sc = 2 + Math.min(3, Math.abs(ma));
  if (cvdOk) sc += 3;
  if (oiOk)  sc += 2;
  sc = Math.min(10, Math.round(sc));
  return dirUp ? { longScore: sc, shortScore: 0 } : { longScore: 0, shortScore: sc };
}

// ── 💎 Score de SALUD (0-100): ¿es un movimiento de calidad, operable? ──────
// Distinto del score de momentum (que mide "se mueve ahora"): la salud mide si
// el movimiento es FIABLE — con liquidez, tendencia coherente, flujo real
// respaldando, OI sano, sin euforia de funding, sin cascadas en contra y sin
// estar tan extendida que entrar sea chasear. Nota: A ≥75 · B ≥60 · C ≥45 · D.
function healthScore(row) {
  const n = v => v ?? 0;
  const dirUp = n(row.price4hPct) !== 0 ? n(row.price4hPct) > 0 : n(row.price1hPct) >= 0;
  const sgn = dirUp ? 1 : -1;
  let score = 0;
  const ok = [], bad = [];

  // 1) Liquidez (0-15): sin liquidez no hay scalp sano
  const turn = n(row.turnover24h);
  if      (turn >= 100e6) { score += 15; ok.push('liquidez alta (≥$100M/24h)'); }
  else if (turn >= 30e6)  { score += 10; ok.push('liquidez aceptable'); }
  else if (turn >= 10e6)  { score += 5;  bad.push('liquidez justa'); }
  else bad.push('ilíquida (<$10M/24h)');

  // 2) Tendencia multi-TF (0-15): todas las temporalidades contando lo mismo
  const al = timeframeAlignment(row);
  if (al && (al.dir === 'up') === dirUp) {
    if (al.count === al.total && al.total >= 3) { score += 15; ok.push(`tendencia alineada ${al.count}/${al.total} TFs`); }
    else if (al.count >= 3)                     { score += 10; ok.push(`tendencia ${al.count}/${al.total} TFs`); }
    else score += 5;
  } else bad.push('temporalidades en conflicto');

  // 3) Flujo real (0-15): CVD a favor, relativo al volumen propio
  const vol5m = n(row.vol1hUSD) / 12;
  if (row.cvd5m != null && vol5m > 0) {
    const ratio = (row.cvd5m * sgn) / vol5m;
    if      (ratio > 0.15)  { score += 15; ok.push('flujo agresor fuerte a favor'); }
    else if (ratio > 0.03)  { score += 9;  ok.push('flujo a favor'); }
    else if (ratio > -0.05) score += 4;
    else bad.push('CVD en contra (divergencia de flujo)');
  }

  // 4) OI sano (0-15): dinero nuevo entrando, de forma sostenida
  if      (n(row.oi1h) > 0.2 && n(row.oi4h) > 0) { score += 10; ok.push('OI creciendo (dinero nuevo)'); }
  else if (n(row.oi1h) > 0)                       score += 5;
  else bad.push('OI cayendo (interés saliendo)');
  const st = oiStreaks.get(row.symbol);
  if (st && st.dir > 0 && (Date.now() - st.since) >= 5 * 60_000) { score += 5; ok.push('acumulación de OI sostenida'); }

  // 5) Funding sin euforia (0-10)
  const fr = n(row.fundingRate);
  const overheated = dirUp ? fr > 0.05 : fr < -0.05;
  if (overheated) bad.push('funding sobrecalentado (euforia/apalancamiento estirado)');
  else if (Math.abs(fr) <= 0.02) { score += 10; ok.push('funding equilibrado'); }
  else score += 5;

  // 6) Sin cascada de liquidaciones en contra (0-10)
  const lq = liqSumCache.get(row.symbol);
  const liqAgainst = lq ? (dirUp ? lq.l : lq.s) : 0;
  if      (liqAgainst > 100_000) bad.push('cascada de liquidaciones en contra');
  else if (liqAgainst > 30_000)  score += 4;
  else score += 10;

  // 7) No sobre-extendida (0-10): que entrar no sea chasear
  if (row.moveAtr1h != null) {
    const ext = Math.abs(row.moveAtr1h);
    if      (ext > 2.5)  bad.push(`sobre-extendida (${row.moveAtr1h.toFixed(1)}×ATR): esperar retroceso`);
    else if (ext >= 0.5) { score += 10; ok.push('movimiento sano, no parabólico'); }
    else score += 6;
  }

  // 8) Estructura propia (0-10): rompiendo su rango a favor
  const reg = detectSymbolRegime(row.symbol) || fallbackSymbolRegime(row);
  if (reg && ((reg.regime === 'RUPTURA ↑' && dirUp) || (reg.regime === 'RUPTURA ↓' && !dirUp))) {
    score += 10; ok.push('rompiendo su propio rango a favor');
  } else if (reg && reg.regime === 'VOLÁTIL') score += 3;
  else if (reg) score += 5;

  score = Math.max(0, Math.min(100, Math.round(score)));
  const grade = score >= 75 ? 'A' : score >= 60 ? 'B' : score >= 45 ? 'C' : 'D';
  return { symbol: row.symbol, score, grade, side: dirUp ? 'long' : 'short', ok, bad };
}

const HEALTH_GRADE_STYLE = {
  A: ['#06291a', '#2fe08a'], B: ['#0a2518', '#55bb88'],
  C: ['#2a2410', '#e0a830'], D: ['#240808', '#aa6060'],
};

function renderHealthPanel() {
  const el = document.getElementById('lab-health-cards');
  const cnt = document.getElementById('lab-health-count');
  if (!el) return;
  const healths = allRows.map(healthScore).sort((a, b) => b.score - a.score);
  const good = healths.filter(h => h.score >= 60);
  if (cnt) cnt.textContent = good.length
    ? `${good.filter(h => h.grade === 'A').length} nota A · ${good.filter(h => h.grade === 'B').length} nota B`
    : '';
  if (!good.length) {
    el.innerHTML = '<span class="lr-empty">Ninguna moneda cumple los criterios de salud ahora mismo — a veces la mejor operación es esperar.</span>';
    return;
  }
  el.innerHTML = good.slice(0, 8).map(h => {
    const [bg, fg] = HEALTH_GRADE_STYLE[h.grade];
    const row = allRows.find(r => r.symbol === h.symbol);
    return `<div class="health-card">
      <div class="hc-head">
        <span class="hc-sym">${h.symbol}</span>
        <span class="cc-side ${h.side}">${h.side.toUpperCase()}</span>
        <span class="hc-grade" style="background:${bg};color:${fg}">${h.grade}</span>
        <span class="hc-score" style="color:${fg}">${h.score}</span>
        <span class="row-radar" style="margin-left:auto" title="Abrir en el radar de confluencia" onclick="openInRadar('${h.symbol}')">🎯</span>
        <span class="star${favorites.has(h.symbol) ? ' on' : ''}" title="Añadir al seguimiento" onclick="toggleFav('${h.symbol}')">★</span>
      </div>
      <div class="hc-rows">
        ${h.ok.slice(0, 3).map(t => `<div class="hc-row" style="color:#4a8a68">✓ ${t}</div>`).join('')}
        ${h.bad.slice(0, 2).map(t => `<div class="hc-row" style="color:#a05555">✗ ${t}</div>`).join('')}
      </div>
      <div class="hc-foot">${row ? fmtPrice(row.price) : ''} · ρBTC ${row && row.btcCorr != null ? row.btcCorr.toFixed(2) : '—'}</div>
    </div>`;
  }).join('');

  // Las nota A entran solas al seguimiento automático (si no son ya favoritas)
  const now = Date.now();
  for (const h of good.filter(x => x.grade === 'A').slice(0, 5)) {
    if (favorites.has(h.symbol)) continue;
    autoTracked.set(h.symbol, {
      addedAt: autoTracked.get(h.symbol)?.addedAt ?? now,
      expiresAt: now + AUTOTRACK_TTL_MS,
      side: h.side === 'long' ? 'l' : 's',
      heat: Math.round(h.score / 10),
    });
  }
  saveAutoTracked();

  logPanelDetections('health', good.map(h => ({
    symbol: h.symbol, side: h.side === 'long' ? 'l' : 's', score: h.score,
  })));
}

// Heat score 0-10: combina cuántas estrategias coinciden en el mismo lado
// (confluencia), qué tan anómalo es el movimiento de OI propio (z-score) y el
// score "actual" base — para detectar monedas "on fire" sin depender de ★.
function computeHeatScore(s) {
  const keys = ['cur', 'pct', 'reg', 'z'];
  let confL = 0, confS = 0;
  for (const k of keys) {
    const sc = s[k];
    if (!sc) continue;
    if (sc.l >= 2) confL++;
    if (sc.s >= 2) confS++;
  }
  const side = confL >= confS ? 'l' : 's';
  const confluence = side === 'l' ? confL : confS;
  const baseScore  = s.cur ? (side === 'l' ? s.cur.l : s.cur.s) : 0;
  const zAbs  = s.z ? Math.abs(s.z.zVal ?? 0) : 0;
  const zNorm = Math.min(10, zAbs * 2.5);
  const heat = confluence / keys.length * 10 * 0.4 + zNorm * 0.3 + baseScore * 0.3;
  return { symbol: s.symbol, side, heat: Math.round(heat * 10) / 10, confluence, zAbs, baseScore };
}

// Auto-puebla `autoTracked` con el Top-N por heat score (renovando expiración
// si reaparecen) y purga las entradas vencidas — así el seguimiento de
// "mejores monedas del momento" no depende de marcarlas con ★ a mano.
function updateAutoTracked(scored) {
  const now = Date.now();
  const heats = scored.map(computeHeatScore)
    .filter(h => h.heat >= 3)
    .sort((a, b) => b.heat - a.heat)
    .slice(0, AUTOTRACK_TOP_N);
  for (const h of heats) {
    if (favorites.has(h.symbol)) continue; // ya tiene seguimiento manual
    autoTracked.set(h.symbol, { addedAt: autoTracked.get(h.symbol)?.addedAt ?? now, expiresAt: now + AUTOTRACK_TTL_MS, side: h.side, heat: h.heat });
  }
  for (const [sym, info] of [...autoTracked]) {
    if (info.expiresAt <= now) autoTracked.delete(sym);
  }
  saveAutoTracked();
  return heats;
}

function fmtAutoTrackAge(ms) {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  return `${(m / 60).toFixed(1)}h`;
}

// ── 🎯 Señales accionables ahora ────────────────────────────────────────────
// Evidencia histórica real de una estrategia: agrega sus señales evaluadas a
// 1h (stratSignals) y devuelve el límite INFERIOR del IC de Wilson — igual
// criterio de honestidad que usa el Comparador para elegir la "mejor" estrategia.
function strategyEvidence(key) {
  const evals = stratSignals.filter(s => s.strategy === key && s.eval60).map(s => s.eval60);
  const n = evals.length;
  if (!n) return { n: 0, winRate: null, lo: null };
  const hits = evals.filter(e => e.hit).length;
  const winRate = Math.round(hits / n * 100);
  const ci = wilsonCI(hits, n);
  return { n, hits, winRate, lo: ci ? ci.lo : 0 };
}

const AS_GRADE_STYLE = {
  A: ['#06291a', '#2fe08a'], B: ['#0a2518', '#55bb88'],
  C: ['#2a2410', '#e0a830'], D: ['#240808', '#aa6060'],
};

// Sintetiza, por símbolo+lado con ≥2 estrategias de acuerdo: cuántas coinciden,
// la nota de Salud, el mejor win-rate histórico REAL (Wilson) entre las
// estrategias que dispararon, y niveles de entrada/stop/TP por ATR. Ordenadas
// por evidencia (el límite inferior de Wilson), no por score — una señal con
// mucho "score" pero cuya estrategia nunca ha demostrado acertar vale menos
// que una con score moderado pero WR real probado.
function renderActionableSignals(confMap, confStrats, totalStrats) {
  const grid = document.getElementById('lab-signals-grid');
  if (!grid) return;

  const candidates = [...confMap.entries()]
    .filter(([, cnt]) => cnt >= 2)
    .map(([k, cnt]) => {
      const symbol = k.slice(0, -1), side = k.slice(-1);
      const row = allRows.find(r => r.symbol === symbol);
      if (!row) return null;
      const isLong = side === 'l';

      // Mejor evidencia entre las estrategias que dispararon esta señal:
      // solo cuentan las que ya tienen n suficiente (WR_MIN_N) para fiarse.
      const strats = confStrats.get(k) || [];
      let best = null;
      for (const key of strats) {
        const ev = strategyEvidence(key);
        if (ev.n < WR_MIN_N) continue;
        if (!best || ev.lo > best.lo) best = { key, ...ev };
      }

      const health = healthScore(row);
      const atrPct = row.atr1h && row.price ? row.atr1h / row.price * 100 : null;
      const entry = row.price;
      const stop  = atrPct != null ? entry * (1 - (isLong ? 1 : -1) * atrPct * 1.2 / 100) : null;
      const tp    = atrPct != null ? entry * (1 + (isLong ? 1 : -1) * atrPct * 1.8 / 100) : null;

      return { symbol, side, isLong, cnt, strats, best, health, entry, stop, tp };
    })
    .filter(Boolean)
    // Evidencia primero (mejor límite inferior de Wilson), luego confluencia;
    // sin evidencia qualificada van al final.
    .sort((a, b) => {
      const al = a.best ? a.best.lo : -1, bl = b.best ? b.best.lo : -1;
      return bl - al || b.cnt - a.cnt;
    })
    .slice(0, 12);

  if (!candidates.length) {
    grid.innerHTML = '<span class="lr-empty">Sin señales con ≥2 estrategias de acuerdo por ahora…</span>';
    return;
  }

  grid.innerHTML = candidates.map(c => {
    const [bg, fg] = AS_GRADE_STYLE[c.health.grade];
    const sideTxt = c.isLong ? '▲ LONG' : '▼ SHORT';
    const evidenceRow = c.best
      ? `<div class="as-row"><span>Evidencia (${STRAT_NAMES[c.best.key] || c.best.key})</span>
          <span><b title="IC 95% (Wilson): ${c.best.lo.toFixed(0)}–${wilsonCI(c.best.hits, c.best.n).hi.toFixed(0)}%">${wrChip(c.best.winRate, c.best.n)}</b></span></div>`
      : '';
    const noEvidence = !c.best
      ? `<div class="as-note">⚠ sin evidencia aún — no operar (ninguna estrategia coincidente tiene n≥${WR_MIN_N} evaluado a 1h)</div>`
      : '';
    const levelsRow = c.stop != null
      ? `<div class="as-row"><span>Niveles (ATR)</span>
          <span>entra <b>${fmtPrice(c.entry)}</b> · stop <b class="neg">${fmtPrice(c.stop)}</b> · TP <b class="pos">${fmtPrice(c.tp)}</b></span></div>`
      : '';
    return `<div class="as-card ${c.isLong ? 'as-long' : 'as-short'}${c.best ? '' : ' as-no-evidence'}" onclick="openDetail('${c.symbol}')">
      <div class="as-head">
        <span class="as-sym">${c.symbol}</span>
        <span class="as-side">${sideTxt}</span>
        <span class="as-conf">${c.cnt}/${totalStrats} estrategias</span>
        <span class="as-grade" style="background:${bg};color:${fg}" title="Nota de Salud">${c.health.grade} ${c.health.score}</span>
      </div>
      ${evidenceRow}
      ${levelsRow}
      ${noEvidence}
    </div>`;
  }).join('');
}

function renderLab() {
  if (!allRows.length) return;

  const regime = detectRegime(allRows);

  // Régimen banner
  const badge = document.getElementById('lab-regime-badge');
  const stats = document.getElementById('lab-regime-stats');
  const dist  = document.getElementById('lab-regime-dist');
  if (badge) { badge.textContent = regime.regime; badge.style.color = regime.color; badge.style.borderColor = regime.color + '80'; }
  if (stats) stats.textContent = `${regime.desc} · OI mkt ${regime.avgOI1h >= 0 ? '+' : ''}${regime.avgOI1h.toFixed(2)}%`;
  if (dist) {
    const b = Math.round(regime.bullPct), r = Math.round(regime.bearPct), m = Math.max(0, 100 - b - r);
    dist.innerHTML = `<div class="regime-bar">
      <div style="width:${b}%;background:#006638"></div>
      <div style="width:${r}%;background:#882020"></div>
      <div style="width:${m}%;background:#1a2535"></div>
    </div>
    <div class="regime-bar-labels">
      <span style="color:#00c878">▲${b}%</span>
      <span style="color:#ee4444">▼${r}%</span>
      <span style="color:#4a5a70">→${m}%</span>
    </div>`;
  }

  const pFns = buildPercentileFns(allRows);
  const btcRow = allRows.find(r => r.symbol === 'BTC');

  const scored = allRows.map(r => {
    const cur    = scoreSymbol(r);
    const pct    = scorePercentile(r, pFns);
    const reg    = scoreRegime(r, regime);
    const z      = zScoreSymbol(r);
    const range  = scoreOwnRangeBreakout(r);
    const liq    = scoreLiquidationCascade(r);
    const sector = scoreSectorRotation(r, allRows);
    const whale  = scoreWhaleActivity(r);
    const beta   = scoreBetaLag(r, btcRow);
    const alpha  = scoreDecorrAlpha(r);
    return { symbol: r.symbol,
      cur:    { l: cur.longScore,    s: cur.shortScore },
      pct:    { l: pct.longScore,    s: pct.shortScore },
      reg:    { l: reg.longScore,    s: reg.shortScore },
      z:      z ? { l: z.longScore, s: z.shortScore, zStr: z.zStr, zVal: z.z } : null,
      range:  { l: range.longScore,  s: range.shortScore },
      liq:    { l: liq.longScore,    s: liq.shortScore },
      sector: { l: sector.longScore, s: sector.shortScore },
      whale:  { l: whale.longScore,  s: whale.shortScore },
      beta:   { l: beta.longScore,   s: beta.shortScore },
      alpha:  { l: alpha.longScore,  s: alpha.shortScore },
    };
  });
  labScoredCache = scored;

  const top = (key, side) => [...scored]
    .filter(r => r[key] && r[key][side] >= 2)
    .sort((a,b) => b[key][side] - a[key][side])
    .slice(0, 4);

  // `cols` sigue definiendo qué estrategias existen y alimenta al Comparador
  // (top() se usa para registrar señales); ya no se renderiza como muro de
  // columnas — ver renderActionableSignals() más abajo.
  const cols = [
    { key: 'cur' }, { key: 'pct' }, { key: 'reg' }, { key: 'z' }, { key: 'range' },
    { key: 'liq' }, { key: 'sector' }, { key: 'whale' }, { key: 'beta' }, { key: 'alpha' },
  ];
  renderHealthPanel(); // 💎 monedas saludables (y auto-seguimiento de las nota A)

  // Confluencia: símbolo aparece en ≥2 estrategias — ya no se renderiza como
  // panel propio ("Alta confluencia" quedaba redundante con Seguimiento y con
  // el nuevo panel de abajo); se conserva el cómputo para alimentar al
  // Comparador (tarjeta "Confluencia") y como insumo de renderActionableSignals().
  const confMap = new Map();      // symbol+side → nº de estrategias de acuerdo
  const confStrats = new Map();   // symbol+side → [keys de estrategias que dispararon]
  for (const c of cols) {
    for (const side of ['l','s']) {
      for (const r of top(c.key, side)) {
        const k = r.symbol + side;
        confMap.set(k, (confMap.get(k) || 0) + 1);
        if (!confStrats.has(k)) confStrats.set(k, []);
        confStrats.get(k).push(c.key);
      }
    }
  }

  logPanelDetections('confluence', [...confMap.entries()].filter(([,cnt]) => cnt >= 2)
    .map(([k, cnt]) => ({ symbol: k.slice(0,-1), side: k.slice(-1), score: cnt })));

  // Radar automático: sigue temporalmente las monedas "on fire" del momento
  // sin depender de marcarlas con ★ (alimenta Seguimiento); el panel "Radar"
  // standalone se retiró por ser redundante con Seguimiento/Señales accionables.
  updateAutoTracked(scored);

  // 🎯 Señales accionables ahora: sintetiza confluencia + salud + evidencia
  // histórica real (Comparador, Wilson) + niveles por ATR en una sola tarjeta.
  renderActionableSignals(confMap, confStrats, cols.length);

  // Comparador de estrategias: registra señales nuevas (entradas al Top-4),
  // evalúa las que ya tienen 30min/1h de antigüedad y refresca el panel
  logStrategySignals(top);
  evalStrategySignals();
  renderStrategyCompare();
  renderHourAnalysis();
  renderSeguimiento();

  // 🤖 Paper trading — solo opera estrategias que el Comparador YA validó
  // (WR≥55%, n≥30 a 1h). Los bots anteriores (confluencia genérica / alineado
  // a régimen) se retiraron por no estar conectados a ninguna evidencia real.
  const validatedKeys = getValidatedStrategies();
  checkPTExits();
  checkPTEntries(top, validatedKeys);
  renderPaperTrading(validatedKeys);

  // 🎯 Patrones W/M — el registro y la resolución corren siempre (en
  // patterns.js, cada ciclo, sin depender de esta pestaña); aquí solo se
  // refresca la tabla cuando el Lab está visible.
  renderPatternTrack();
}

function toggleFav(sym) {
  if (favorites.has(sym)) favorites.delete(sym);
  else favorites.add(sym);
  safeSetItem('scalp_favs', JSON.stringify([...favorites]));
  syncToServer();
  render();
}
