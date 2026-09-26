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

// Las 10 estrategias core de scoring por símbolo, más 'confluence' y 'health'
// — estas dos ERAN paneles agregados sin estructura por símbolo+lado, pero
// resultaron ser las de MEJOR evidencia real (Confluencia ~62% WR, Saludable
// ~56% WR a 1h) así que se les da la misma estructura {l,s} más abajo en
// renderLab() para que el bot pueda operarlas igual que cualquier estrategia
// core. 'promising'/'patternWM'/'squeeze' quedan fuera: su evidencia actual
// no lo justifica (WR≈48% o menos) — no es limitación técnica, es la evidencia.
const BOT_STRAT_KEYS = ['cur', 'pct', 'reg', 'z', 'range', 'liq', 'sector', 'whale', 'beta', 'alpha', 'confluence', 'health'];

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
          <td style="color:#b3bcc9">$${fmtPrice(pos.entryPrice)}</td>
          <td style="color:#8090b0">$${fmtPrice(curr)}</td>
          <td class="${pnlC}">${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%</td>
          <td class="${pnlC}">${pnlUSD >= 0 ? '+' : ''}$${pnlUSD.toFixed(2)}</td>
          <td style="color:${csC};font-weight:700">${cs}</td>
          <td style="color:#b3bcc9">${STRAT_NAMES[pos.entryScore?.strategy] || '—'}</td>
          <td style="color:#a5adb7">${fmtDur(now - pos.entryTime)}</td>
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
      // Mismo criterio que la tabla de abiertas: separadas por temporalidad,
      // porque el acierto de una no dice nada del de las otras.
      const ordTf = { '15m': 0, '1h': 1, '4h': 2 };
      const ordRec = [...recent].sort((x, y) =>
        (ordTf[x.tf || '15m'] - ordTf[y.tf || '15m']) || (y.exitTime - x.exitTime));
      let tfPrev = null;
      closedBody.innerHTML = ordRec.map(t => {
        const tfC = t.tf || '15m';
        let cabC = '';
        if (tfC !== tfPrev) {
          tfPrev = tfC;
          const grupo = ordRec.filter(x => (x.tf || '15m') === tfC);
          const aciertos = grupo.filter(x => x.exitReason === 'TARGET').length;
          cabC = `<tr class="patt-tf-row"><td colspan="5">◭ ${tfC} — ${aciertos}/${grupo.length} en objetivo</td></tr>`;
        }
        return cabC + (() => {
        const pnlC = t.pnlPct >= 0 ? 'pt-pnl-pos' : 'pt-pnl-neg';
        return `<tr>
          <td class="pt-sym">${t.symbol}</td>
          <td class="pt-${t.direction === 'L' ? 'long' : 'short'}">${t.direction}</td>
          <td style="color:#b3bcc9">$${fmtPrice(t.entryPrice)}</td>
          <td style="color:#b3bcc9">$${fmtPrice(t.exitPrice)}</td>
          <td class="${pnlC}">${t.pnlPct >= 0 ? '+' : ''}${t.pnlPct?.toFixed(2)}%</td>
          <td class="${pnlC}">${t.pnlUSD >= 0 ? '+' : ''}$${t.pnlUSD?.toFixed(2)}</td>
          <td class="${reasonClass[t.exitReason] ?? ''}">${reasonMap[t.exitReason] ?? t.exitReason}</td>
          <td style="color:#a5adb7">${fmtDur(t.exitTime - t.entryTime)}</td>
        </tr>`; })();
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
// Lab abierta o no. Solo se admiten rupturas con R:R >= 1:1 al precio real.
let patternTrack = JSON.parse(localStorage.getItem('scalp_pattern_track') || '[]');
function savePatternTrack() { safeSetItem('scalp_pattern_track', JSON.stringify(patternTrack)); }
function patternTrackOpen()    { return patternTrack.filter(t => t.status === 'open'); }
// 'pending' = orden limite del retroceso puesta y sin llenar todavia.
function patternTrackPending() { return patternTrack.filter(t => t.status === 'pending'); }
// OJO: antes era `!== 'open'`, que metia las pendientes y las canceladas en el
// saco de "cerradas" y les inventaba un resultado. Solo cuenta lo que cerro.
function patternTrackClosed()  { return patternTrack.filter(t => t.status === 'closed'); }
function patternTrackCancelled() { return patternTrack.filter(t => t.status === 'cancelled'); }

// Ratio beneficio/riesgo mínimo para dar la entrada por buena. Se mide AL PRECIO
// REAL DE ENTRADA, no sobre el papel del patrón: cuando el cuello se rompe el
// precio ya se ha movido, así que lo que queda hasta el objetivo se encoge y la
// distancia al stop crece. Una ruptura detectada tarde puede tener un 1:1 sobre
// el papel y un 0,4:1 de verdad — y esas son justo las que hay que descartar.
const PATTERN_MIN_RR = 1;

// ── Costes de ejecucion ─────────────────────────────────────────────────────
// Hasta ahora el seguimiento media el PnL en BRUTO, y ese numero no sirve para
// decidir nada. El barrido de backtest/RESULTADOS-SCALP.md dio 0 de 1.728
// configuraciones rentables a comision taker y 44 de 1.728 a comision maker: en
// scalping la comision no es un ajuste fino, es la variable que decide si hay
// estrategia o no. Sobre este mismo patron W/M se midio +0,229 R en bruto y
// -0,664 R despues de comisiones, porque con el stop en el cuello el viaje de
// ida y vuelta se come el 23% del riesgo.
//
// Bybit perpetuos lineales:
const FEE_TAKER_PCT = 0.055;  // orden a mercado
const FEE_MAKER_PCT = 0.020;  // orden limite (lado pasivo)
const SLIP_PCT      = 0.010;  // deslizamiento estimado, solo al ejecutar a mercado

// Coste de ENTRAR, segun como se entra.
const _feeIn = kind => (kind === 'retest' ? FEE_MAKER_PCT : FEE_TAKER_PCT + SLIP_PCT);
// Coste de SALIR, segun por que se sale: un take-profit es una orden limite ya
// puesta en el nivel (maker); un stop, un trailing o un breakeven se disparan a
// mercado (taker + deslizamiento).
const _feeOut = reason => (reason === 'TARGET' ? FEE_MAKER_PCT : FEE_TAKER_PCT + SLIP_PCT);

// ── Stop de tiempo ──────────────────────────────────────────────────────────
// Sin esto, una entrada que no toca objetivo ni stop se queda 'open' para
// siempre y no cuenta en ninguna estadistica: sesgo de supervivencia puro. Al
// agotarse el plazo se cierra al precio que haya, con motivo TIME, y cuenta
// como resultado real igual que cualquier otro.
const PATTERN_MAX_HOLD_BARS = { '15m': 96, '1h': 72, '4h': 42 }; // 24h · 3 dias · 7 dias

// ── Entrada MAKER en el retroceso al cuello ─────────────────────────────────
// La entrada en la ruptura solo se puede ejecutar a mercado, y a comision taker
// este patron no sobrevive. La unica ejecucion que paga comision maker es una
// orden limite esperando en un nivel, y el nivel natural es el cuello ya roto,
// que pasa de resistencia a soporte (al reves en la M). Por eso cada ruptura
// abre EN PARALELO una entrada limite 'pending' en el cuello, para medir cara a
// cara: ruptura a mercado (taker, entra siempre) contra retroceso al cuello
// (maker, entra solo si el precio vuelve).
//
// El coste de esperar es real y se mide: las rupturas que se van sin retroceder
// quedan anotadas como MISSED. Sin ese numero la comparacion seria tramposa,
// porque solo se veria la mitad buena de operar con limite.
const RETEST_STOP_ATR = 0.5;  // stop bajo el cuello: si el cuello no aguanta, el setup fallo
const RETEST_MAX_BARS = 8;    // velas de su TF que la orden espera antes de cancelarse

// Ganancia a la que se arma el trailing stop de la variante C.
const TRAIL_ARM_PCT = 5;

// Antigüedad máxima de la ruptura, EN VELAS de su propia temporalidad. Medir
// esto en horas sería un error: se midieron las señales en 'breaking' y las de
// 4h con CERO velas transcurridas -lo más fresco que existe, la vela de ruptura
// ni siquiera ha cerrado- ya marcaban 2,2h, así que un corte de "máximo 2h"
// las habría matado todas mientras dejaba pasar las de 1h. Con 0 velas se entra
// solo en la vela que acaba de cerrar más allá del cuello; una entrada con 1
// vela ya pasada solo ocurre si la pestaña estuvo cerrada y al volver se
// encontró la ruptura hecha, que es justo lo que no queremos operar.
const PATTERN_MAX_BREAK_BARS = 0;

// Contador de descartes de la sesión, para poder juzgar si el filtro está
// dejando pasar poco o demasiado. En memoria: no engorda localStorage.
let _patSkipped = { rr: 0, old: 0, last: null };

// Llamada por patterns.js SOLO cuando un patrón entra en 'breaking' (una vela ya
// cerrada más allá del cuello), nunca en 'confirming' ni 'forming'. Dedup: si ya
// hay una entrada abierta para ese símbolo+lado+temporalidad, no abre otra.
// Duracion de una vela por temporalidad: hace falta para saber cual es la vela
// EN CURSO y no examinar su rango completo al resolver (contiene el movimiento
// anterior a la entrada, que no es nuestro).
const TF_MS = { '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000 };

function trackPatternSignal(row, p) {
  const side = p.type === 'W' ? 'L' : 'S';
  const tf = p.tf || '15m';
  const now = Date.now();
  const tfMs = TF_MS[tf] || 900_000;
  const barT = Math.floor(now / tfMs) * tfMs; // apertura de la vela en curso
  // Una entrada por simbolo+lado+TF y POR TIPO de entrada: la de mercado y la
  // del retroceso son dos formas de operar la misma ruptura y se miden juntas.
  const yaHay = kind => patternTrack.some(t =>
    (t.status === 'open' || t.status === 'pending') &&
    t.symbol === row.symbol && t.side === side && (t.tf || '15m') === tf &&
    (t.entryKind || 'break') === kind);

  // STOP DE LA ENTRADA: al otro lado del CUELLO ya roto, no tras el extremo del
  // patrón. Medido sobre 24 rupturas reales, con el stop tras el extremo el R:R
  // es estructuralmente imposible: el objetivo está a `profundidad` del precio y
  // el stop a `profundidad + 0.3·ATR`, así que el riesgo SIEMPRE supera al
  // beneficio (mediana 0,33; ninguna de las 24 llegaba a 1:1). Con el stop en el
  // cuello roto -que pasa a ser soporte/resistencia- pasan 8 de 24, y son justo
  // las rupturas frescas. El stop original se conserva en stopPattern.
  // Solo rupturas RECIENTES: si la vela de ruptura ya quedó atrás, se descarta.
  if (p.barsSinceBreak != null && p.barsSinceBreak > PATTERN_MAX_BREAK_BARS) {
    _patSkipped.old++;
    _patSkipped.last = { symbol: row.symbol, tf, type: p.type, bars: p.barsSinceBreak, ts: Date.now() };
    return;
  }

  const isLong = side === 'L';

  // Constructor comun a las dos entradas. riskPct y feeInPct se fijan aqui,
  // en la apertura, porque son lo que convierte el resultado en un multiplo de
  // R neto y no en un porcentaje sin contexto.
  const nueva = (kind, entryPrice, stop, status) => {
    const reward = Math.abs(p.target - entryPrice);
    const risk   = Math.abs(entryPrice - stop);
    const rr = risk > 0 ? reward / risk : 0;
    if (rr < PATTERN_MIN_RR) return { rr, rechazada: true };
    return { rr, entrada: {
      id: now + Math.random(),
      symbol: row.symbol, side, type: p.type, tf,
      entryKind: kind,                       // 'break' (mercado) | 'retest' (limite)
      entryPrice, entryTime: status === 'open' ? now : null,
      placedAt: now,                         // cuando se detecto la ruptura
      target: p.target, stop, stopPattern: p.stop, neckline: p.neckline,
      quality: p.quality, atr: p.atr, rr,
      riskPct: entryPrice > 0 ? risk / entryPrice * 100 : null,
      feeInPct: _feeIn(kind),
      status,
      lastBarT: barT,                        // ultima vela ya examinada
      v_be: { stop, status },                // breakeven al 50% de progreso
      v_tr: { stop, active: false, status }, // trailing 1.5×ATR desde +5%
    } };
  };

  // ── 1) Entrada de RUPTURA, a mercado y al precio de ahora ──────────────────
  // STOP: al otro lado del CUELLO ya roto, no tras el extremo del patron. Medido
  // sobre 24 rupturas reales, con el stop tras el extremo el R:R es
  // estructuralmente imposible: el objetivo esta a `profundidad` del precio y el
  // stop a `profundidad + 0.3·ATR`, asi que el riesgo SIEMPRE supera al
  // beneficio (mediana 0,33; ninguna de las 24 llegaba a 1:1). Con el stop en el
  // cuello roto -que pasa a ser soporte/resistencia- pasan 8 de 24, y son justo
  // las rupturas frescas. El stop original se conserva en stopPattern.
  const stopEntry = isLong ? p.neckline - 0.3 * p.atr : p.neckline + 0.3 * p.atr;
  // Si el precio ya volvió al otro lado del cuello, el stop quedaría del lado
  // equivocado: no hay entrada válida que medir.
  const cuelloPerdido = isLong ? row.price <= stopEntry : row.price >= stopEntry;
  if (!cuelloPerdido && !yaHay('break')) {
    const r = nueva('break', row.price, stopEntry, 'open');
    if (r.rechazada) {
      _patSkipped.rr++;
      _patSkipped.last = { symbol: row.symbol, tf, type: p.type, rr: r.rr, ts: now };
    } else {
      patternTrack.push(r.entrada);
    }
  }

  // ── 2) Entrada de RETROCESO, con orden limite en el cuello ─────────────────
  // Queda 'pending' hasta que el precio vuelva a tocar el cuello. El stop va
  // medio ATR por debajo (por encima en la M): si el cuello roto no aguanta como
  // soporte, la premisa del setup es falsa y no hay nada que esperar. Ese stop
  // corto es lo que da a esta entrada un R:R alto por construccion — la
  // profundidad del patron es >= 1·ATR y el riesgo es 0,5·ATR — pero tambien
  // hara que salte mas veces. Cual de las dos cosas pesa mas es exactamente lo
  // que este seguimiento tiene que responder, no algo que yo deba suponer.
  if (!yaHay('retest')) {
    const stopRetest = isLong ? p.neckline - RETEST_STOP_ATR * p.atr
                              : p.neckline + RETEST_STOP_ATR * p.atr;
    const r = nueva('retest', p.neckline, stopRetest, 'pending');
    if (r.entrada) {
      r.entrada.limitPrice = p.neckline;
      r.entrada.expiresAfterBar = barT + RETEST_MAX_BARS * tfMs;
      patternTrack.push(r.entrada);
    }
  }

  if (patternTrack.length > 800) patternTrack.splice(0, patternTrack.length - 800);
  savePatternTrack();
}

function closePatternTrack(t, reason, price) {
  const dir = t.side === 'L' ? 1 : -1;
  t.exitPrice  = price;
  t.exitTime   = Date.now();
  t.exitReason = reason; // 'TARGET' | 'STOP' | 'TIME'
  // NETO, no bruto: pnlPct es el numero que lee todo el panel, asi que el
  // descuento va aqui y no en la presentacion — si se descontara al pintar,
  // cualquier sitio que se olvidara de hacerlo volveria a mentir. El bruto se
  // guarda al lado para poder ver cuanto se lleva exactamente la friccion.
  t.pnlGrossPct = dir * (price - t.entryPrice) / t.entryPrice * 100;
  t.costPct     = (t.feeInPct != null ? t.feeInPct : _feeIn(t.entryKind)) + _feeOut(reason);
  t.pnlPct      = t.pnlGrossPct - t.costPct;
  t.r           = t.riskPct > 0 ? t.pnlPct / t.riskPct : null; // multiplo de R, neto
  t.status      = 'closed';
  savePatternTrack();
  if (canAlert('patternDone')) {
    showToast(
      `${t.symbol} patrón ${t.type} ${reason === 'TARGET' ? '🎯 objetivo alcanzado' : '🛑 stop alcanzado'} · ${t.pnlPct >= 0 ? '+' : ''}${t.pnlPct.toFixed(2)}%`,
      t.pnlPct >= 0 ? 'long' : 'short'
    );
    playAlertSound('patternDone', reason === 'TARGET' ? 'long' : 'short');
  }
}

// Sin timeout a propósito — llamar en CADA ciclo de datos (no solo con el Lab
// abierto). Resuelve la variante BASE (objetivo fijo vs stop fijo) y, en
// paralelo sobre la MISMA señal, dos variantes de salida alternativas:
//   🅱 Breakeven 50%: al recorrer la mitad hacia el objetivo, el stop sube a
//      la entrada (elimina los "casi-ganadores" que terminan en pérdida).
//   🅲 Trailing: SIN take-profit — al alcanzar +5% de GANANCIA arma un trailing
//      stop de 1.5×ATR de la temporalidad y deja correr el movimiento.
// Así el panel compara con datos reales cuál estrategia de salida rinde más.
// -- Velas CERRADAS aun sin examinar, en la temporalidad del seguimiento -----
// Resolver solo con el precio en vivo de cada ciclo (~10 s) deja invisible
// cualquier mecha que toque un nivel y se recupere, y eso no es un error
// simetrico: el stop esta mas cerca de la entrada que el objetivo, asi que es al
// stop al que se le escapan mas toques. La vela EN CURSO se excluye porque su
// rango todavia no esta cerrado y, en la vela de la entrada, contiene tambien el
// movimiento anterior a haber entrado, que no nos pertenece.
function _patBarsSince(row, tf, lastBarT, now) {
  const k = tf === '15m' ? row.k15
          : tf === '1h'  ? row.k60
          : (typeof _patAgg4h === 'function' ? _patAgg4h(row) : row._k240);
  if (!k || !k.t || !k.t.length) return [];
  const tfMs = TF_MS[tf] || 900_000;
  const out = [];
  for (let i = 0; i < k.t.length; i++) {
    if (k.t[i] <= lastBarT) continue;      // ya examinada en un ciclo anterior
    if (k.t[i] + tfMs > now) continue;     // en curso: rango aun sin cerrar
    out.push({ t: k.t[i], h: k.h[i], l: k.l[i], c: k.c[i] });
  }
  return out;
}

// Cierre de una variante de salida, con el mismo descuento de comisiones que la
// entrada principal.
function _patCloseVar(t, v, reason, price, when) {
  const dir = t.side === 'L' ? 1 : -1;
  v.status      = 'closed';
  v.exitReason  = reason;
  v.pnlGrossPct = dir * (price - t.entryPrice) / t.entryPrice * 100;
  v.costPct     = (t.feeInPct != null ? t.feeInPct : _feeIn(t.entryKind)) + _feeOut(reason);
  v.pnlPct      = v.pnlGrossPct - v.costPct;
  v.r           = t.riskPct > 0 ? v.pnlPct / t.riskPct : null;
  v.exitTime    = when || Date.now();
}

// Aplica un "tick" a las tres variantes. `ext` son los extremos de una vela
// cerrada, o el precio vivo (con h = l = c = precio).
function _patApplyTick(t, ext, when) {
  let dirty = false;
  const isLong = t.side === 'L';
  const dir = isLong ? 1 : -1;
  const pnlAt  = px => dir * (px - t.entryPrice) / t.entryPrice * 100;
  const tocoStop = lvl => (isLong ? ext.l <= lvl : ext.h >= lvl);
  const tocoTgt  = lvl => (isLong ? ext.h >= lvl : ext.l <= lvl);

  // (A) BASE -- el STOP se comprueba ANTES que el objetivo. Dentro de una misma
  // vela no hay forma de saber cual se toco primero, y suponer que fue el stop
  // es la convencion honesta. Antes se comprobaba al contrario, asi que cada
  // vela que contenia los dos niveles se apuntaba como GANADA.
  if (t.status === 'open') {
    if (tocoStop(t.stop))        { closePatternTrack(t, 'STOP',   t.stop);   dirty = true; }
    else if (tocoTgt(t.target))  { closePatternTrack(t, 'TARGET', t.target); dirty = true; }
  }

  // (B) BREAKEVEN 50% -- el stop sube a la entrada al recorrer media distancia.
  // El avance se mide con el CIERRE de la vela, no con su maximo: mover el stop
  // por una mecha que luego se deshace seria darse una ventaja que no existe.
  const vb = t.v_be;
  if (vb && vb.status === 'open') {
    if (tocoStop(vb.stop))       { _patCloseVar(t, vb, vb.stop === t.entryPrice ? 'BE' : 'STOP', vb.stop, when); dirty = true; }
    else if (tocoTgt(t.target))  { _patCloseVar(t, vb, 'TARGET', t.target, when); dirty = true; }
    else {
      const dist = Math.abs(t.target - t.entryPrice) || 1e-9;
      if (dir * (ext.c - t.entryPrice) / dist >= 0.5 && vb.stop !== t.entryPrice) { vb.stop = t.entryPrice; dirty = true; }
    }
  }

  // (C) TRAILING 1.5xATR, armado al llegar a +5% de ganancia (sin take-profit).
  // Se arma por GANANCIA REAL, no por porcentaje de recorrido hacia el objetivo:
  // el 60% de un objetivo pequeno puede ser un +0,8% que no merece proteger, y
  // el 60% de uno grande puede ser un +9% ya regalado si se gira.
  const vt = t.v_tr;
  if (vt && vt.status === 'open') {
    if (tocoStop(vt.stop)) { _patCloseVar(t, vt, vt.active ? 'TRAIL' : 'STOP', vt.stop, when); dirty = true; }
    else {
      if (!vt.active && pnlAt(ext.c) >= TRAIL_ARM_PCT) { vt.active = true; dirty = true; }
      if (vt.active) {
        const cand   = isLong ? ext.c - 1.5 * t.atr : ext.c + 1.5 * t.atr;
        const better = isLong ? Math.max(vt.stop, cand) : Math.min(vt.stop, cand);
        if (better !== vt.stop) { vt.stop = better; dirty = true; }
      }
    }
  }
  return dirty;
}

// La orden limite se llena y la entrada pasa a viva.
function _patFill(t, price, when) {
  const tfMs = TF_MS[t.tf || '15m'] || 900_000;
  t.status     = 'open';
  t.entryPrice = price;
  t.entryTime  = when;
  t.filledAt   = when;
  t.lastBarT   = Math.floor(when / tfMs) * tfMs;
  if (t.v_be) { t.v_be.status = 'open'; t.v_be.stop = t.stop; }
  if (t.v_tr) { t.v_tr.status = 'open'; t.v_tr.stop = t.stop; t.v_tr.active = false; }
  return true;
}

// La orden limite se retira sin haberse llenado. MISSED es el caso importante:
// la ruptura funciono y el precio nunca volvio a darnos la entrada. Es el precio
// que se paga por exigir comision maker y sin contarlo la comparacion mentiria.
function _patCancel(t, reason, when) {
  t.status       = 'cancelled';
  t.cancelReason = reason; // 'FAILED' | 'MISSED' | 'EXPIRED'
  t.exitTime     = when;
  if (t.v_be) t.v_be.status = 'cancelled';
  if (t.v_tr) t.v_tr.status = 'cancelled';
  return true;
}

function _patResolvePending(t, row, tf, tfMs, now) {
  let dirty = false;
  const isLong = t.side === 'L';
  const lim = t.limitPrice != null ? t.limitPrice : t.entryPrice;
  // Una orden limite de COMPRA se ejecuta cuando el precio BAJA hasta ella; una
  // de venta, cuando sube. Se mira vela a vela y al final el precio vivo.
  const toco = ext => (isLong ? ext.l <= lim : ext.h >= lim);

  for (const b of _patBarsSince(row, tf, t.lastBarT || 0, now)) {
    t.lastBarT = b.t; dirty = true;
    if (toco(b)) return _patFill(t, lim, b.t + tfMs);
    // El setup falla cuando una vela CIERRA al otro lado del cuello sin haber
    // tocado el limite: el cuello ya no hace de soporte y no hay nada que esperar.
    if (isLong ? b.c < t.neckline : b.c > t.neckline) return _patCancel(t, 'FAILED', now);
  }
  if (toco({ h: row.price, l: row.price })) return _patFill(t, lim, now);

  if (isLong ? row.price >= t.target : row.price <= t.target) return _patCancel(t, 'MISSED', now);
  if (t.expiresAfterBar && now > t.expiresAfterBar)           return _patCancel(t, 'EXPIRED', now);
  return dirty;
}

// Sin timeout a proposito -- llamar en CADA ciclo de datos (no solo con el Lab
// abierto). Resuelve la variante BASE (objetivo fijo vs stop fijo) y, en
// paralelo sobre la MISMA senal, dos variantes de salida alternativas, y llena
// o retira las ordenes limite del retroceso al cuello.
function checkPatternTrackOutcomes() {
  let dirty = false;
  const now = Date.now();
  for (const t of patternTrack) {
    if (t.status !== 'open' && t.status !== 'pending') continue;

    // migracion perezosa de entradas anteriores a esta version
    if (!t.entryKind) t.entryKind = 'break';
    if (t.feeInPct == null) t.feeInPct = _feeIn(t.entryKind);
    if (t.atr == null) t.atr = Math.abs(t.target - t.entryPrice) / 1.8;
    if (t.riskPct == null && t.entryPrice > 0) t.riskPct = Math.abs(t.entryPrice - t.stop) / t.entryPrice * 100;
    if (!t.v_be) t.v_be = { stop: t.stop, status: t.status };
    if (!t.v_tr) t.v_tr = { stop: t.stop, active: false, status: t.status };

    const tf   = t.tf || '15m';
    const tfMs = TF_MS[tf] || 900_000;
    const row  = allRows.find(r => r.symbol === t.symbol);

    if (!row || !row.price) {
      // La moneda salio del universo del screener: en este ciclo no hay precio.
      // Antes esto era un `continue` seco y la entrada se quedaba abierta PARA
      // SIEMPRE sin contar en ninguna estadistica. Con las 10 plazas de
      // movimiento las monedas rotan a diario, asi que el agujero se tragaba
      // justo a las senales mas finas -- las que mas probabilidades tienen de
      // ser perdedoras. Se marcan y las resuelve el servidor de snapshots.
      if (!t.orphanSince) { t.orphanSince = now; dirty = true; }
      continue;
    }
    if (t.orphanSince) { t.orphanSince = null; dirty = true; }

    if (t.status === 'pending') {
      if (_patResolvePending(t, row, tf, tfMs, now)) dirty = true;
      continue;
    }

    for (const b of _patBarsSince(row, tf, t.lastBarT || 0, now)) {
      t.lastBarT = b.t; dirty = true;
      if (_patApplyTick(t, b, b.t + tfMs)) dirty = true;
      if (t.status !== 'open' && t.v_be.status !== 'open' && t.v_tr.status !== 'open') break;
    }
    if (_patApplyTick(t, { h: row.price, l: row.price, c: row.price }, now)) dirty = true;

    // Stop de tiempo: lo que no se resuelve en su plazo se cierra al precio que
    // haya. Una entrada eterna no es un empate, es una estadistica que falta.
    const limite = (PATTERN_MAX_HOLD_BARS[tf] || 96) * tfMs;
    if (t.entryTime && now - t.entryTime > limite) {
      if (t.status === 'open')      { closePatternTrack(t, 'TIME', row.price); dirty = true; }
      if (t.v_be.status === 'open') { _patCloseVar(t, t.v_be, 'TIME', row.price, now); dirty = true; }
      if (t.v_tr.status === 'open') { _patCloseVar(t, t.v_tr, 'TIME', row.price, now); dirty = true; }
    }
  }
  if (dirty) savePatternTrack();
}

// -- Huerfanas: resolver contra el historico del servidor ---------------------
// El servidor guarda un snapshot de precio cada 5 min de los 150 pares mas
// liquidos, 14 dias. Con eso se resuelven las entradas cuya moneda ya no esta en
// el universo, en vez de dejarlas abiertas fingiendo que no existen. La
// granularidad de 5 min es peor que la de una vela, asi que aqui tambien se
// comprueba el stop antes del objetivo.
const ORPHAN_GRACE_MS = 10 * 60_000;   // margen antes de dar una moneda por ida
const ORPHAN_EVERY_MS = 5 * 60_000;    // los snapshots del servidor son de 5 min: mirar mas seguido no aporta
let _orphanBusy = false;
let _orphanLastRun = 0;

async function resolveOrphanPatternTracks() {
  if (_orphanBusy) return;
  const now = Date.now();
  if (now - _orphanLastRun < ORPHAN_EVERY_MS) return;
  const huerfanas = patternTrack.filter(t =>
    (t.status === 'open' || t.status === 'pending') &&
    t.orphanSince && now - t.orphanSince > ORPHAN_GRACE_MS);
  if (!huerfanas.length) return;

  _orphanBusy = true;
  _orphanLastRun = now;
  try {
    const symbols = [...new Set(huerfanas.map(t => t.symbol))].slice(0, 60);
    const from = Math.min(...huerfanas.map(t => t.lastSnapTs || t.entryTime || t.placedAt || now));
    const res = await fetch('/api/prices/series?symbols=' + encodeURIComponent(symbols.join(',')) + '&from=' + from);
    if (!res.ok) return;
    const data = await res.json();
    if (!Array.isArray(data.rows)) return;

    const bySym = new Map();
    for (const r of data.rows) {
      if (!bySym.has(r.symbol)) bySym.set(r.symbol, []);
      bySym.get(r.symbol).push(r);
    }

    let dirty = false;
    for (const t of huerfanas) {
      const serie = bySym.get(t.symbol);
      if (!serie || !serie.length) continue;
      const desde = t.lastSnapTs || t.entryTime || t.placedAt || 0;
      for (const s of serie) {
        if (s.ts <= desde) continue;
        t.lastSnapTs = s.ts; dirty = true;
        if (t.status === 'pending') {
          const isLong = t.side === 'L';
          const lim = t.limitPrice != null ? t.limitPrice : t.entryPrice;
          if (isLong ? s.price <= lim : s.price >= lim) { _patFill(t, lim, s.ts); continue; }
          if (isLong ? s.price >= t.target : s.price <= t.target) { _patCancel(t, 'MISSED', s.ts); break; }
          if (t.expiresAfterBar && s.ts > t.expiresAfterBar)      { _patCancel(t, 'EXPIRED', s.ts); break; }
          continue;
        }
        _patApplyTick(t, { h: s.price, l: s.price, c: s.price }, s.ts);
        if (t.status !== 'open' && t.v_be.status !== 'open' && t.v_tr.status !== 'open') break;
      }
      // Agotado el plazo y sin poder resolverla, se cierra al ultimo precio
      // conocido. Si el servidor tampoco cubre esa moneda queda abierta y se
      // muestra como tal: un hueco declarado es honesto, uno escondido no.
      const tfMs = TF_MS[t.tf || '15m'] || 900_000;
      const limite = (PATTERN_MAX_HOLD_BARS[t.tf || '15m'] || 96) * tfMs;
      const ultimo = serie[serie.length - 1];
      if (t.status === 'open' && t.entryTime && now - t.entryTime > limite) {
        closePatternTrack(t, 'TIME', ultimo.price); dirty = true;
      }
      if (t.status === 'pending' && t.expiresAfterBar && now > t.expiresAfterBar) {
        _patCancel(t, 'EXPIRED', now); dirty = true;
      }
    }
    if (dirty) savePatternTrack();
  } catch (_) {
    /* sin red o sin datos: el siguiente ciclo lo reintenta */
  } finally {
    _orphanBusy = false;
  }
}

// -- Migracion unica a resultados NETOS --------------------------------------
// Las entradas cerradas antes de esta version guardan el PnL en bruto. Mezclarlas
// con las nuevas daria una media sin sentido, asi que se les descuenta el coste
// una sola vez (marcador netV) suponiendo entrada a mercado, que es como se
// tomaron. Se conserva el bruto para poder auditar el cambio.
function _patMigrateToNet() {
  let dirty = false;
  const conv = (o, kind, riskPct) => {
    if (!o || o.netV === 2 || o.pnlPct == null || o.status !== 'closed') return false;
    o.pnlGrossPct = o.pnlPct;
    o.costPct = _feeIn(kind) + _feeOut(o.exitReason || 'STOP');
    o.pnlPct  = o.pnlGrossPct - o.costPct;
    o.r = riskPct > 0 ? o.pnlPct / riskPct : null;
    o.netV = 2;
    return true;
  };
  for (const t of patternTrack) {
    const kind = t.entryKind || 'break';
    if (t.riskPct == null && t.entryPrice > 0 && t.stop != null) {
      t.riskPct = Math.abs(t.entryPrice - t.stop) / t.entryPrice * 100;
    }
    if (conv(t, kind, t.riskPct)) dirty = true;
    if (conv(t.v_be, kind, t.riskPct)) dirty = true;
    if (conv(t.v_tr, kind, t.riskPct)) dirty = true;
  }
  if (dirty) savePatternTrack();
}
_patMigrateToNet();


// Exporta el seguimiento completo a JSON. Este historial vive SOLO en el
// localStorage de este navegador y nunca ha viajado al servidor, asi que sin
// esto no hay forma de sacarlo para analizarlo fuera. Incluye la configuracion
// de reglas vigente, porque un win-rate no significa nada sin saber con que
// filtros y que stop se genero.
function exportPatternTrack() {
  const abiertas = patternTrackOpen().length;
  const cerradas = patternTrackClosed().length;
  const datos = {
    exportadoEl: new Date().toISOString(),
    origen: location.origin,          // Render y localhost son almacenes distintos
    reglas: {
      minRR: PATTERN_MIN_RR,
      maxVelasDesdeRuptura: PATTERN_MAX_BREAK_BARS,
      trailingArmadoEnPct: TRAIL_ARM_PCT,
      stopDeEntrada: 'cuello roto -/+ 0.3 ATR',
      stopDelRetroceso: 'cuello -/+ ' + RETEST_STOP_ATR + ' ATR',
      velasQueEsperaLaOrdenLimite: RETEST_MAX_BARS,
      plazoMaximoEnVelas: PATTERN_MAX_HOLD_BARS,
      // Sin esto un win-rate no significa nada: son los numeros que convierten
      // un PnL bruto en un resultado que se puede creer.
      costes: { takerPct: FEE_TAKER_PCT, makerPct: FEE_MAKER_PCT, deslizamientoPct: SLIP_PCT },
      resolucion: 'maximo/minimo de vela; si una vela contiene stop y objetivo se supone STOP',
      resultadosNetos: true,
    },
    descartadasEstaSesion: { porRR: _patSkipped.rr, porNoRecientes: _patSkipped.old },
    resumen: {
      abiertas, cerradas, total: patternTrack.length,
      pendientes: patternTrackPending().length,
      canceladas: patternTrackCancelled().length,
      sinPrecioEnVivo: patternTrack.filter(t => t.orphanSince).length,
    },
    entradas: patternTrack,
  };
  const blob = new Blob([JSON.stringify(datos, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `patrones-wm-${location.hostname}-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  if (typeof showToast === 'function') {
    showToast(`Exportadas ${patternTrack.length} entradas (${abiertas} abiertas, ${cerradas} cerradas)`, 'long');
  }
}

function clearPatternTrack() {
  if (!confirm('¿Borrar todo el seguimiento de patrones W/M?')) return;
  patternTrack = [];
  savePatternTrack();
  renderPatternTrack();
}

function renderPatternTrack() {
  const open    = patternTrackOpen();
  const pending = patternTrackPending();
  const closed  = patternTrackClosed();
  const canceladas = patternTrackCancelled();

  const wins    = closed.filter(t => t.exitReason === 'TARGET');
  const winRate = closed.length ? Math.round(wins.length / closed.length * 100) : null;
  const conPnl  = closed.filter(t => Number.isFinite(t.pnlPct));
  const avgPnl  = conPnl.length ? conPnl.reduce((a, t) => a + t.pnlPct, 0) / conPnl.length : null;
  // La expectativa en R es el unico numero que dice si esto gana dinero: un
  // acierto del 40% con 3R de media gana, y uno del 70% con 0,3R pierde.
  const conR = closed.filter(t => t.r != null);
  const avgR = conR.length ? conR.reduce((a, t) => a + t.r, 0) / conR.length : null;
  // Cuanto del riesgo se lleva la friccion. Por encima del ~15% la comision
  // decide el resultado, y ese fue el diagnostico de este patron: 23%.
  const conCost = closed.filter(t => t.costPct != null && t.riskPct > 0);
  const friccion = conCost.length
    ? conCost.reduce((a, t) => a + t.costPct / t.riskPct, 0) / conCost.length * 100 : null;
  const avgTimeMs = closed.length
    ? closed.reduce((a, t) => a + ((t.exitTime || 0) - (t.entryTime || t.exitTime || 0)), 0) / closed.length : null;

  const set = (id, html, color) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = html;
    if (color) el.style.color = color;
  };
  const col = v => (v == null ? '' : v >= 0 ? '#00c878' : '#ee5555');
  set('patt-stat-open',    `${open.length}`);
  set('patt-stat-pending', `${pending.length}`, pending.length ? '#7fd4ff' : '');
  set('patt-stat-total',   `${closed.length}`);
  set('patt-stat-wr',      closed.length ? wrChip(winRate, closed.length) : '—', closed.length ? (winRate >= 50 ? '#00c878' : '#ee5555') : '');
  set('patt-stat-r',       avgR != null ? `${avgR >= 0 ? '+' : ''}${avgR.toFixed(3)} R <span style="font-weight:400;color:#8b9098">(n=${conR.length})</span>` : '—', col(avgR));
  set('patt-stat-pnl',     avgPnl != null ? `${avgPnl >= 0 ? '+' : ''}${avgPnl.toFixed(2)}%` : '—', col(avgPnl));
  set('patt-stat-fee',     friccion != null ? `${friccion.toFixed(1)}% del riesgo` : '—',
      friccion == null ? '' : friccion > 15 ? '#ee5555' : friccion > 8 ? '#ffbe3c' : '#00c878');
  set('patt-stat-time',    avgTimeMs != null ? fmtDur(avgTimeMs) : '—');

  const vEl = document.getElementById('patt-variants');
  if (vEl) {
    const agg = arr => {
      if (!arr.length) return null;
      const v = arr.filter(Number.isFinite);
      if (!v.length) return null;
      const w = v.filter(x => x > 0).length;
      return { n: v.length, wr: Math.round(w / v.length * 100), avg: v.reduce((a, b) => a + b, 0) / v.length };
    };

    // -- Ruptura a mercado contra retroceso al cuello --------------------------
    // Esta es la comparacion que decide el diseno del screener, no un detalle:
    // el barrido de backtest/RESULTADOS-SCALP.md dio 0 de 1.728 configuraciones
    // rentables a comision taker y 44 de 1.728 a comision maker. La pregunta no
    // es si el patron W/M funciona, es si se puede ejecutar sin pagar taker.
    // MISSED es la mitad incomoda de la respuesta: rupturas que funcionaron y a
    // las que la orden limite se quedo mirando. Sin ese numero esto seria un
    // argumento de vendedor, no una medicion.
    const ENTRADAS = [
      { kind: 'break',  label: '⚡ Ruptura a mercado', sub: 'taker 0,065%' },
      { kind: 'retest', label: '⏳ Retroceso al cuello', sub: 'maker 0,020%' },
    ];
    const porEntrada = ENTRADAS.map(e => {
      const c  = closed.filter(t => (t.entryKind || 'break') === e.kind);
      const rs = c.filter(t => t.r != null).map(t => t.r);
      const cc = canceladas.filter(t => (t.entryKind || 'break') === e.kind);
      return {
        ...e,
        n: c.length,
        nR: rs.length,   // cuantas aportaron un R: puede ser menos que n
        wr: c.length ? Math.round(c.filter(t => t.exitReason === 'TARGET').length / c.length * 100) : null,
        r: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null,
        abiertas: open.filter(t => (t.entryKind || 'break') === e.kind).length,
        pend: pending.filter(t => (t.entryKind || 'break') === e.kind).length,
        missed:  cc.filter(t => t.cancelReason === 'MISSED').length,
        failed:  cc.filter(t => t.cancelReason === 'FAILED').length,
        expired: cc.filter(t => t.cancelReason === 'EXPIRED').length,
      };
    });
    const mejorEntrada = porEntrada.filter(x => x.r != null && x.n >= 10).sort((a, b) => b.r - a.r)[0] || null;
    const entradaHtml = porEntrada.map(x => {
      const esMejor = mejorEntrada && x === mejorEntrada;
      const noTomadas = x.missed + x.failed + x.expired;
      const detalle = !x.n
        ? '<span style="color:#aab3c1">sin cerradas aún</span>'
        : x.r == null
          ? `${wrChip(x.wr, x.n)} <span style="color:#aab3c1">(n=${x.n}, sin R medible)</span>`
          : `${wrChip(x.wr, x.n)} · <b style="color:${col(x.r)}">${x.r >= 0 ? '+' : ''}${x.r.toFixed(3)} R</b> <span style="color:#aab3c1" title="Operaciones que aportaron un R medible${x.nR < x.n ? ` — las otras ${x.n - x.nR} son de una versión anterior y no guardaban el riesgo` : ''}">(n=${x.nR}${x.nR < x.n ? ` de ${x.n}` : ''})</span>`;
      const espera = x.pend ? ` · <span style="color:#7fd4ff">${x.pend} esperando</span>` : '';
      const perdidas = noTomadas
        ? ` · <span style="color:#ffbe3c" title="No se tomaron: ${x.missed} se fueron sin retroceder (MISSED) · ${x.failed} perdieron el cuello antes de llenar (FAILED) · ${x.expired} caducaron">${noTomadas} no tomadas${x.missed ? ` (${x.missed} se fueron sin volver)` : ''}</span>`
        : '';
      return `<span class="patt-var patt-var-entry${esMejor ? ' patt-var-best' : ''}" title="${x.sub}">${esMejor ? '👑 ' : ''}<b>${x.label}</b>
        <span style="color:#8b9098">${x.sub}</span>: ${detalle}${espera}${perdidas}</span>`;
    }).join('');

    const sBase = agg(closed.filter(t => t.pnlPct != null).map(t => t.pnlPct));
    const sBe   = agg(patternTrack.filter(t => t.v_be?.status === 'closed' && t.v_be.pnlPct != null).map(t => t.v_be.pnlPct));
    const sTr   = agg(patternTrack.filter(t => t.v_tr?.status === 'closed' && t.v_tr.pnlPct != null).map(t => t.v_tr.pnlPct));
    const rows2 = [
      { name: '🅰 Objetivo fijo (base)', s: sBase },
      { name: '🅱 Breakeven al 50%', s: sBe },
      { name: '🅲 Trailing 1.5×ATR (armado a +5%)', s: sTr },
    ];

    // -- Desglose por temporalidad --
    // Mezclar 15m, 1h y 4h en un solo win-rate esconde lo unico que importa
    // decidir: en que temporalidad merece la pena operar el patron.
    const TFS = ['15m', '1h', '4h'];
    const byTf = TFS.map(tf => {
      const c = closed.filter(t => (t.tf || '15m') === tf);
      const o = open.filter(t => (t.tf || '15m') === tf);
      const rs = c.filter(t => t.r != null).map(t => t.r);
      const w = c.filter(t => t.exitReason === 'TARGET').length;
      return {
        tf, abiertas: o.length, n: c.length, nR: rs.length,
        wr: c.length ? Math.round(w / c.length * 100) : null,
        r: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null,
      };
    }).filter(x => x.n || x.abiertas);
    const tfHtml = byTf.length ? byTf.map(x => {
      const det = !x.n
        ? '<span style="color:#aab3c1">sin cerradas aún</span>'
        : x.r == null
          ? `${wrChip(x.wr, x.n)} <span style="color:#aab3c1">(n=${x.n}, sin R medible)</span>`
          : `${wrChip(x.wr, x.n)} · <b style="color:${col(x.r)}">${x.r >= 0 ? '+' : ''}${x.r.toFixed(3)} R</b> <span style="color:#aab3c1" title="Operaciones que aportaron un R medible${x.nR < x.n ? ` — las otras ${x.n - x.nR} son de una versión anterior y no guardaban el riesgo` : ''}">(n=${x.nR}${x.nR < x.n ? ` de ${x.n}` : ''})</span>`;
      return `<span class="patt-var">◭ <b>${x.tf}</b> · ${x.abiertas} abierta${x.abiertas === 1 ? '' : 's'} · ${det}</span>`;
    }).join('') : '';

    const best = rows2.filter(r => r.s && r.s.n >= 10).sort((a, b) => b.s.avg - a.s.avg)[0] || null;
    const skipHtml = (_patSkipped.rr || _patSkipped.old)
      ? `<span class="patt-var" title="Rupturas confirmadas que no se tomaron: por no pagar el riesgo (R:R) o por no ser recientes (la vela de ruptura ya había quedado atrás)">
           🚫 descartadas: <b style="color:#ffbe3c">${_patSkipped.rr}</b> por R:R &lt; ${PATTERN_MIN_RR}:1 ·
           <b style="color:#ffbe3c">${_patSkipped.old}</b> por no ser recientes <span style="color:#aab3c1">(esta sesión)</span></span>`
      : '';
    // Entradas cuya moneda salio del universo y que el servidor tampoco cubre.
    // Se declara el hueco en vez de esconderlo: son las que antes se quedaban
    // abiertas para siempre sin contar en nada.
    const huerf = [...open, ...pending].filter(t => t.orphanSince).length;
    const huerfHtml = huerf
      ? `<span class="patt-var" title="Su moneda salió del universo del screener. Se intentan resolver contra el histórico de precios del servidor; las que el servidor tampoco cubre quedan aquí a la vista en vez de desaparecer de las estadísticas.">
           🛰 <b style="color:#ffbe3c">${huerf}</b> sin precio en vivo (fuera del universo)</span>`
      : '';

    vEl.innerHTML = entradaHtml + tfHtml + skipHtml + huerfHtml + rows2.map(r => {
      const isBest = best && r === best;
      if (!r.s) return `<span class="patt-var">${r.name}: <b style="color:#aab3c1">sin datos aún</b></span>`;
      return `<span class="patt-var${isBest ? ' patt-var-best' : ''}">${isBest ? '👑 ' : ''}${r.name}:
        <b>${wrChip(r.s.wr, r.s.n)}</b> · <b style="color:${col(r.s.avg)}">${r.s.avg >= 0 ? '+' : ''}${r.s.avg.toFixed(2)}% neto</b> <span style="color:#aab3c1">(n=${r.s.n})</span></span>`;
    }).join('');
  }

  // -- Ordenes limite esperando el retroceso --------------------------------
  const pendBody = document.getElementById('patt-pending-body');
  if (pendBody) {
    if (!pending.length) {
      pendBody.innerHTML = `<tr><td colspan="8" class="pt-empty">Sin órdenes esperando — se ponen solas en el cuello al confirmarse una ruptura</td></tr>`;
    } else {
      const ordenTf = { '15m': 0, '1h': 1, '4h': 2 };
      const ord = [...pending].sort((a, b) =>
        (ordenTf[a.tf || '15m'] - ordenTf[b.tf || '15m']) || (b.placedAt - a.placedAt));
      pendBody.innerHTML = ord.map(t => {
        const row = allRows.find(r => r.symbol === t.symbol);
        const curr = row?.price;
        const isLong = t.side === 'L';
        const lim = t.limitPrice != null ? t.limitPrice : t.entryPrice;
        // Cuanto le falta al precio para llegar a la orden (positivo = aun no).
        const falta = curr ? (isLong ? (curr - lim) / curr * 100 : (lim - curr) / curr * 100) : null;
        const faltaC = falta == null ? '#8b9098' : falta <= 0.3 ? '#2fe08a' : falta <= 1 ? '#ffbe3c' : '#8090b0';
        const restan = t.expiresAfterBar ? t.expiresAfterBar - Date.now() : null;
        return `<tr>
          <td class="pt-sym">${t.symbol}</td>
          <td class="pt-${isLong ? 'long' : 'short'}">${t.type} ${isLong ? '▲' : '▼'} <span style="font-size:8px;opacity:.6">${t.tf || '15m'}</span>${t.rr != null ? ` <span style="font-size:8px;color:#7fd4ff" title="Beneficio/riesgo desde el precio límite">R${t.rr.toFixed(1)}</span>` : ''}</td>
          <td style="color:#7fd4ff">$${fmtPrice(lim)}</td>
          <td style="color:#8090b0">${curr ? '$' + fmtPrice(curr) : '<span title="La moneda salió del universo del screener">—</span>'}</td>
          <td style="color:${faltaC}">${falta == null ? '—' : (falta >= 0 ? falta.toFixed(2) + '%' : '<b>en zona</b>')}</td>
          <td style="color:#00c878">$${fmtPrice(t.target)}</td>
          <td style="color:#ee5555">$${fmtPrice(t.stop)}</td>
          <td style="color:#a5adb7">${restan == null ? '—' : restan <= 0 ? 'caducada' : fmtDur(restan)}</td>
        </tr>`;
      }).join('');
    }
  }

  const openBody = document.getElementById('patt-open-body');
  if (openBody) {
    if (!open.length) {
      openBody.innerHTML = `<tr><td colspan="8" class="pt-empty">Sin patrones en seguimiento — se registran solos al romper el cuello</td></tr>`;
    } else {
      const patternOpenRow = t => {
        const row  = allRows.find(r => r.symbol === t.symbol);
        const curr = row?.price ?? t.entryPrice;
        const isLong = t.side === 'L';
        const progress = isLong
          ? (curr - t.entryPrice) / (t.target - t.entryPrice) * 100
          : (t.entryPrice - curr) / (t.entryPrice - t.target) * 100;
        const progC = progress >= 0 ? '#00c878' : '#ee5555';
        const kind = (t.entryKind || 'break') === 'retest'
          ? ' <span style="font-size:8px;color:#7fd4ff" title="Entró con orden límite en el cuello (comisión maker)">⏳LÍM</span>'
          : '';
        const huerfana = t.orphanSince
          ? ' <span style="font-size:8px;color:#ffbe3c" title="Su moneda salió del universo: se resuelve contra el histórico del servidor">🛰</span>' : '';
        return `<tr>
          <td class="pt-sym">${t.symbol}</td>
          <td class="pt-${isLong ? 'long' : 'short'}">${t.type} ${isLong ? '▲' : '▼'} <span style="font-size:8px;opacity:.6">${t.tf || '15m'}</span>${t.rr != null ? ` <span style="font-size:8px;color:#7fd4ff" title="Beneficio/riesgo al precio de entrada real">R${t.rr.toFixed(1)}</span>` : ''}${kind}${t.v_tr?.active ? ' <span style="font-size:8px;color:#ffbe3c" title="Trailing stop armado: la posición ya pasó de +5%">⇡TR</span>' : ''}${huerfana}</td>
          <td style="color:#b3bcc9">$${fmtPrice(t.entryPrice)}</td>
          <td style="color:#8090b0">$${fmtPrice(curr)}</td>
          <td style="color:#00c878">$${fmtPrice(t.target)}</td>
          <td style="color:#ee5555">$${fmtPrice(t.stop)}</td>
          <td style="color:${progC}">${progress.toFixed(0)}%</td>
          <td style="color:#a5adb7">${fmtDur(Date.now() - (t.entryTime || t.placedAt || Date.now()))}</td>
        </tr>`;
      };
      const ordenTf = { '15m': 0, '1h': 1, '4h': 2 };
      // Agrupadas por temporalidad: las tres TF rompen a ritmos muy distintos
      // y mezcladas no se lee cual esta activa ahora.
      const ordenadas = [...open].sort((a, b) =>
        (ordenTf[a.tf || '15m'] - ordenTf[b.tf || '15m']) || (b.entryTime - a.entryTime));
      let tfActual = null;
      openBody.innerHTML = ordenadas.map(t => {
        const tfT = t.tf || '15m';
        let cab = '';
        if (tfT !== tfActual) {
          tfActual = tfT;
          const n = ordenadas.filter(x => (x.tf || '15m') === tfT).length;
          cab = `<tr class="patt-tf-row"><td colspan="8">◭ ${tfT} — ${n} en seguimiento</td></tr>`;
        }
        return cab + patternOpenRow(t);
      }).join('');
    }
  }

  const closedBody = document.getElementById('patt-closed-body');
  if (closedBody) {
    const recent = [...closed].reverse().slice(0, 20);
    if (!recent.length) {
      closedBody.innerHTML = `<tr><td colspan="6" class="pt-empty">Sin patrones completados aún</td></tr>`;
    } else {
      // Mismo criterio que la tabla de abiertas: separadas por temporalidad,
      // porque el acierto de una no dice nada del de las otras.
      const ordTf = { '15m': 0, '1h': 1, '4h': 2 };
      const ordRec = [...recent].sort((x, y) =>
        (ordTf[x.tf || '15m'] - ordTf[y.tf || '15m']) || (y.exitTime - x.exitTime));
      let tfPrev = null;
      closedBody.innerHTML = ordRec.map(t => {
        const tfC = t.tf || '15m';
        let cabC = '';
        if (tfC !== tfPrev) {
          tfPrev = tfC;
          const grupo = ordRec.filter(x => (x.tf || '15m') === tfC);
          const aciertos = grupo.filter(x => x.exitReason === 'TARGET').length;
          cabC = `<tr class="patt-tf-row"><td colspan="6">◭ ${tfC} — ${aciertos}/${grupo.length} en objetivo</td></tr>`;
        }
        return cabC + (() => {
        const tienePnl = Number.isFinite(t.pnlPct);
        const pnlC = !tienePnl ? '' : t.pnlPct >= 0 ? 'pt-pnl-pos' : 'pt-pnl-neg';
        const motivo = t.exitReason === 'TARGET' ? '🎯 Objetivo'
                     : t.exitReason === 'TIME'   ? '⏱ Plazo agotado'
                     : '🛑 Stop';
        const clsMotivo = t.exitReason === 'TARGET' ? 'pt-reason-tp' : t.exitReason === 'TIME' ? '' : 'pt-reason-sl';
        const kind = (t.entryKind || 'break') === 'retest'
          ? ' <span style="font-size:8px;color:#7fd4ff" title="Entró con orden límite en el cuello (comisión maker)">⏳LÍM</span>' : '';
        const brutoTip = (Number.isFinite(t.pnlGrossPct) && Number.isFinite(t.costPct))
          ? ` title="Bruto ${t.pnlGrossPct >= 0 ? '+' : ''}${t.pnlGrossPct.toFixed(2)}% − comisión ${t.costPct.toFixed(3)}% = neto"` : '';
        return `<tr>
          <td class="pt-sym">${t.symbol}</td>
          <td class="pt-${t.side === 'L' ? 'long' : 'short'}">${t.type} ${t.side === 'L' ? '▲' : '▼'} <span style="font-size:8px;opacity:.6">${t.tf || '15m'}</span>${kind}</td>
          <td class="${clsMotivo}" style="${clsMotivo ? '' : 'color:#aab3c1'}">${motivo}</td>
          <td class="${pnlC}"${brutoTip}>${tienePnl ? (t.pnlPct >= 0 ? '+' : '') + t.pnlPct.toFixed(2) + '%' : '—'}</td>
          <td style="color:${col(t.r)}">${t.r != null ? (t.r >= 0 ? '+' : '') + t.r.toFixed(2) : '—'}</td>
          <td style="color:#a5adb7">${fmtDur((t.exitTime || 0) - (t.entryTime || t.exitTime || 0))}</td>
        </tr>`; })();
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

  // Evidencia de 'confluence' es la misma para toda tarjeta de esta lista (por
  // construcción, cnt≥2 = ya califica como señal de confluencia) — se calcula
  // una sola vez en vez de por candidato.
  const confluenceEv = strategyEvidence('confluence');

  const candidates = [...confMap.entries()]
    .filter(([, cnt]) => cnt >= 2)
    .map(([k, cnt]) => {
      const symbol = k.slice(0, -1), side = k.slice(-1);
      const row = allRows.find(r => r.symbol === symbol);
      if (!row) return null;
      const isLong = side === 'l';
      const health = healthScore(row);

      // Mejor evidencia disponible para esta señal: además de las estrategias
      // core que dispararon (confStrats), se compite también con 'confluence'
      // (siempre aplica aquí) y 'health' (si esta moneda ya califica como
      // saludable) — ambas resultaron tener de la MEJOR evidencia real medida
      // (~62% y ~56% WR), así que merecen competir por el puesto de "mejor".
      const strats = confStrats.get(k) || [];
      let best = null;
      if (confluenceEv.n >= WR_MIN_N) best = { key: 'confluence', ...confluenceEv };
      if (health.score >= 60) {
        const healthEv = strategyEvidence('health');
        if (healthEv.n >= WR_MIN_N && (!best || healthEv.lo > best.lo)) best = { key: 'health', ...healthEv };
      }
      for (const key of strats) {
        const ev = strategyEvidence(key);
        if (ev.n < WR_MIN_N) continue;
        if (!best || ev.lo > best.lo) best = { key, ...ev };
      }
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
      <span style="color:#b2b9c2">→${m}%</span>
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

  // Adjuntar 'confluence' y 'health' a `scored` con la misma forma {l,s} que
  // las 10 estrategias core — mismo umbral (score≥60 = nota B+) que usa
  // renderHealthPanel()/logPanelDetections('health',...) para loguear evidencia,
  // así lo que cuenta aquí como "señal de salud" es exactamente lo mismo que
  // lo que el Comparador está midiendo (56% WR real).
  const healthBySymbol = new Map(allRows.map(r => [r.symbol, healthScore(r)]));
  for (const r of scored) {
    r.confluence = { l: confMap.get(r.symbol + 'l') || 0, s: confMap.get(r.symbol + 's') || 0 };
    const h = healthBySymbol.get(r.symbol);
    r.health = {
      l: (h && h.side === 'long'  && h.score >= 60) ? h.score : 0,
      s: (h && h.side === 'short' && h.score >= 60) ? h.score : 0,
    };
  }

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
