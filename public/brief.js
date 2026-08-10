/* public/brief.js
 * 🧠 BRIEF DEL ANALISTA — la capa de SÍNTESIS de la pestaña Estrategia.
 *
 * El resto del sistema mide FUERZA (scoreSymbol), CONFLUENCIA (radar de 5
 * checks) y SETUPS sueltos (patrones W/M, potencial de squeeze). Ninguno
 * responde la pregunta que uno se hace de verdad delante de la pantalla:
 * «¿compro algo ahora, qué, y por qué esa y no otra?».
 *
 * Aporta tres cosas que no existían en el resto de módulos:
 *
 *  1) MÉTRICAS DE CALIDAD derivadas de columnas que ya se calculan pero que
 *     nadie cruzaba: calidad del apalancamiento (contado vs perpetuos),
 *     tendencia del volumen, extensión del movimiento y divergencias.
 *  2) Una nota de FIABILIDAD (0-100) distinta de la de fuerza. scoreSymbol
 *     dice cuánto se mueve una moneda; esta dice si el movimiento es REAL y
 *     si todavía llegas a tiempo. Son preguntas diferentes: casi todo lo que
 *     puntúa 9 de fuerza ya está extendido.
 *  3) Un VEREDICTO DE MERCADO que decide el tamaño y el modo de operar antes
 *     de mirar ninguna moneda.
 *
 * Nada se recalcula desde cero: bebe de scoreSymbol, marketRiskLight,
 * detectRegime, computeConfluence, confExpectation, scanPatterns (patrones ya
 * puestos en la fila) y liqSumCache.
 */

// ── Umbrales ────────────────────────────────────────────────────────────────
// El piso de liquidez es el MISMO que usa scoreSymbol() ($300k de volumen 1h)
// para que todo el sistema descarte con la misma vara.
const BRIEF_MIN_VOL1H    = 300_000;
const BRIEF_MIN_TURNOVER = 10e6;
const BRIEF_TIER_A = 72;   // fiable: se puede operar
const BRIEF_TIER_B = 55;   // vigilable: falta una pieza
const BRIEF_TIER_C = 40;   // débil: solo para contexto
const BRIEF_LIQ_CAP = 45;  // techo si no cumple liquidez (no puede ser tier A)

let briefOnlyLongs = false; // filtro de la cabecera
let briefExpanded  = new Set(); // símbolos con el desglose abierto

// ════════════════════════════════════════════════════════════════════════════
// 1. MÉTRICAS DERIVADAS DE CALIDAD
// ════════════════════════════════════════════════════════════════════════════

/** Calidad del apalancamiento: ¿el movimiento de 24h lo hizo el CONTADO o los
 *  PERPETUOS? Si el OI crece mucho más rápido que el precio, el movimiento se
 *  sostiene sobre apalancamiento — y eso se deshace en cascada. Si el precio
 *  se movió mucho más de lo que creció el OI, es dinero al contado: aguanta
 *  retrocesos. Y si el OI CAYÓ mientras el precio subía, no hay dinero nuevo
 *  detrás: es cierre de posiciones (squeeze), que se agota solo. */
function briefLeverage(row) {
  const p = row.price24hPct, oi = row.oi24h;
  if (p == null || oi == null || Math.abs(p) < 1) return null; // sin movimiento que juzgar
  const ratio = oi / Math.abs(p); // puntos de OI nuevo por cada punto de precio
  if (ratio < -0.15) return { kind: 'cierre', ratio, pts: 4,
    txt: `OI ${fmtPct(oi)} en 24h con el precio ${fmtPct(p)}: el movimiento es CIERRE de posiciones, no dinero nuevo` };
  if (ratio < 0.8)   return { kind: 'contado', ratio, pts: 18,
    txt: `precio ${fmtPct(p)} en 24h con OI solo ${fmtPct(oi)}: movimiento de CONTADO, no apalancado` };
  if (ratio < 2.5)   return { kind: 'mixto', ratio, pts: 10,
    txt: `OI y precio crecen a la par (×${ratio.toFixed(1)}): contado y perpetuos mezclados` };
  return { kind: 'perp', ratio, pts: 2,
    txt: `OI ${fmtPct(oi)} contra precio ${fmtPct(p)} (×${ratio.toFixed(1)}): lo empujan los PERPETUOS — frágil` };
}

/** Tendencia del volumen. Un precio que sube con el volumen secándose es
 *  liquidez fina: sube fácil y se devuelve igual de fácil. Se miran las tres
 *  ventanas ya calculadas (1h · 12h · 24h, % sobre su propia media). */
function briefVolumeTrend(row) {
  const v1 = row.vol1hPct, v12 = row.vol12hPct, v24 = row.vol24hPct;
  if (v1 == null && v12 == null && v24 == null) return null;
  const dry = (v12 != null && v12 < -35) && (v24 != null && v24 < -35);
  if (dry)                      return { kind: 'secando', pts: 0,  txt: `volumen secándose (12h ${fmtPct(v12)} · 24h ${fmtPct(v24)}): liquidez fina` };
  if (v1 != null && v1 > 50)    return { kind: 'expande', pts: 8,  txt: `volumen 1h ${fmtPct(v1)} sobre su media: participación entrando` };
  if (v1 != null && v1 > 15)    return { kind: 'activo',  pts: 5,  txt: `volumen 1h ${fmtPct(v1)}: actividad por encima de lo normal` };
  if (v1 != null && v1 < -30)   return { kind: 'cae',     pts: 1,  txt: `volumen 1h ${fmtPct(v1)}: el interés se está yendo` };
  return { kind: 'estable', pts: 3, txt: 'volumen en su media' };
}

/** Extensión: ¿llegas temprano o estás persiguiendo? Cruza el recorrido de 24h
 *  con el múltiplo de ATR de la última hora (cuánto se ha movido respecto a lo
 *  normal PARA ELLA, que es lo que de verdad importa).
 *
 *  Es DIRECCIONAL a propósito: solo es persecución si el movimiento ya fue a tu
 *  favor y llegas tarde. Si las 24h fueron en tu CONTRA no estás persiguiendo,
 *  estás comprando un cuchillo cayendo — problema distinto, bandera distinta.
 *  Y `hot` distingue las dos caras de un +40%: si además se está moviendo ahora
 *  mismo (≥0.8×ATR) entras dentro del impulso; si ya se enfrió, el mismo +40%
 *  es una consolidación en alto, que es un setup de continuación, no una trampa. */
function briefExtension(row, side) {
  const sgn = side === 'long' ? 1 : -1;
  const fav = sgn * (row.price24hPct ?? 0); // recorrido ya consumado A FAVOR
  const mv  = Math.abs(row.moveAtr1h ?? 0);
  const hot = mv >= 0.8;
  const head = `${fmtPct(row.price24hPct)} en 24h · ${mv.toFixed(1)}×ATR en 1h`;

  if (fav <= -15) return { level: 'contra', pen: 16, hot, counter: true,
    txt: `${head} — las 24h van EN CONTRA de la tesis: esto es un rebote dentro de una caída, no un giro` };
  if (fav >= 40 || mv >= 2.5) return { level: 'vertical', pen: 22, hot, counter: false,
    txt: hot ? `${head} — movimiento vertical y todavía caliente: entrar aquí es perseguir`
             : `${head} — ya recorrió mucho pero se ha enfriado: consolidación en alto, solo con gatillo` };
  if (fav >= 20 || mv >= 1.5) return { level: 'extendido', pen: 10, hot, counter: false,
    txt: `${head} — ya extendido, entrada solo en retroceso` };
  if (fav < 8 && mv < 0.8) return { level: 'temprano', pen: 0, hot, counter: false,
    txt: `${head} — movimiento todavía joven` };
  return { level: 'normal', pen: 0, hot, counter: false, txt: `${head} — recorrido normal` };
}

/** Banderas rojas: patrones de trampa que ninguna columna suelta enseña, solo
 *  el CRUCE de varias. 'hard' = descalifica por sí sola (va a EVITAR). */
function briefFlags(row, side, lev, vol, ext) {
  const n = v => v ?? 0;
  const sgn = side === 'long' ? 1 : -1;
  const out = [];

  // Distribución: cargan OI a un lado, el lado paga funding y el precio NO
  // avanza. Alguien está repartiendo papel contra ese apalancamiento. El umbral
  // del precio es RELATIVO al OI que ha entrado: lo que delata la trampa no es
  // un número fijo, es que entre mucho apalancamiento y el precio no lo pague.
  if (n(row.oi1h) > 2 && Math.abs(n(row.price1hPct)) < n(row.oi1h) * 0.15 && sgn * n(row.fundingRate) > 0.05) {
    out.push({ id: 'distribucion', hard: true, pen: 20,
      txt: `OI 1h ${fmtPct(row.oi1h)} y funding ${fmtPct(row.fundingRate)} pero el precio apenas se mueve (${fmtPct(row.price1hPct)}): distribución contra el lado ${side}` });
  }

  // Squeeze agotándose: el precio sube mientras el OI se cierra, y ya lleva
  // mucho recorrido. El combustible (los cortos) ya se quemó.
  if (n(row.oi1h) < -3 && sgn * n(row.price1hPct) > 1 && Math.abs(n(row.price24hPct)) > 20) {
    out.push({ id: 'squeezeAgotado', hard: false, pen: 14,
      txt: `OI 1h ${fmtPct(row.oi1h)} con el precio ${fmtPct(row.price1hPct)}: el combustible del squeeze se está agotando` });
  }

  // Persecución: vertical Y todavía caliente. Si ya se enfrió no descalifica —
  // baja la nota (ext.pen) pero puede seguir siendo una continuación válida.
  if (ext.level === 'vertical') out.push({ id: 'persecucion', hard: ext.hot, pen: 0, txt: ext.txt });

  // Contratendencia: las 24h fueron en contra de la tesis. Un rebote técnico
  // dentro de una caída no es un giro, y es donde más caro sale equivocarse.
  if (ext.counter) out.push({ id: 'contratendencia', hard: true, pen: 0, txt: ext.txt });

  // Liquidez: sin esto cualquier señal es ruido de libro delgado.
  const thin = n(row.vol1hUSD) < BRIEF_MIN_VOL1H || n(row.turnover24h) < BRIEF_MIN_TURNOVER;
  if (thin) out.push({ id: 'liquidez', hard: true, pen: 0,
    txt: `liquidez insuficiente (1h ${fmtUSD(n(row.vol1hUSD))} · 24h ${fmtUSD(n(row.turnover24h))}): el precio lo mueve una sola orden` });

  // Volumen secándose mientras el precio avanza.
  if (vol && vol.kind === 'secando' && sgn * n(row.price1hPct) > 0.5) {
    out.push({ id: 'volSeco', hard: false, pen: 0, txt: vol.txt + ' — sube sin participación' });
  }

  // Flujo agresor en contra del movimiento.
  const v5 = n(row.vol1hUSD) / 12;
  if (row.cvd5m != null && v5 > 0 && sgn * row.cvd5m < -v5 * 0.10) {
    out.push({ id: 'flujoContra', hard: false, pen: 0,
      txt: `CVD 5m ${row.cvd5m >= 0 ? '+' : '−'}${fmtUSD(Math.abs(row.cvd5m))} en contra del movimiento: el flujo agresor no acompaña` });
  }

  // RS marcada como poco fiable por liquidez (mismo criterio que la tabla).
  if (row.rsLowLiq) out.push({ id: 'rsRuido', hard: false, pen: 0,
    txt: 'la fuerza relativa vs BTC de esta moneda está marcada ⚠ (turnover < $10M): es ruido, no fuerza' });

  return out;
}

// ════════════════════════════════════════════════════════════════════════════
// 2. NOTA DE FIABILIDAD + NIVELES
// ════════════════════════════════════════════════════════════════════════════

/** Niveles operativos. Si hay un patrón W/M en la dirección correcta se usan
 *  sus niveles ESTRUCTURALES (cuello, objetivo medido, stop bajo el extremo),
 *  que es lo correcto. Solo si no hay patrón se cae a niveles por ATR, que son
 *  orientativos: un stop bueno va bajo una estructura, no a un % fijo. */
function briefLevels(row, side, pat) {
  const price = row.price;
  const atr = row.atr1h;
  if (!price) return null;
  const long = side === 'long';

  if (pat && ((pat.type === 'W') === long) && pat.stop != null && pat.target != null) {
    const entry = pat.state === 'forming' ? pat.neckline : price;
    const risk  = Math.abs(entry - pat.stop);
    return {
      src: `patrón ${pat.type} ${pat.tf}`, entry, stop: pat.stop, tp1: pat.target,
      tp2: long ? pat.target + (pat.target - pat.neckline) * 0.6 : pat.target - (pat.neckline - pat.target) * 0.6,
      rr: risk > 0 ? Math.abs(pat.target - entry) / risk : null,
      note: pat.state === 'forming' ? `entrada en la ruptura del cuello ${fmtPrice(pat.neckline)}` : 'ruptura ya en marcha',
    };
  }

  if (!atr) return null;
  const dir = long ? 1 : -1;
  const entry = price - dir * atr * 0.4;             // retroceso, no a mercado
  const stop  = entry - dir * atr * 1.2;             // mismo múltiplo que el check "Riesgo definido" del radar
  const tp1   = entry + dir * atr * 1.8;
  const tp2   = entry + dir * atr * 3.0;
  return { src: 'ATR 1h', entry, stop, tp1, tp2, rr: 1.5, note: 'orientativo — afina el stop bajo la estructura del gráfico' };
}

/** Nota de FIABILIDAD 0-100. Devuelve el desglose completo (parts) para que la
 *  tarjeta pueda explicar punto por punto de dónde sale la nota: es el mismo
 *  criterio que partsL/partsS en scoreSymbol — ningún número sin su porqué. */
function briefReliability(row, conf) {
  const n = v => v ?? 0;
  const side = n(row.price1hPct) >= 0 ? 'long' : 'short';
  const sgn  = side === 'long' ? 1 : -1;
  const parts = [], pros = [], cons = [], caps = [];
  let sc = 0;
  const add = (k, pts, max, txt, ok) => { sc += pts; parts.push({ k, pts, max, txt, ok }); (ok ? pros : cons).push(txt); };

  // 1) Alineación estructural OI + precio en las 5 ventanas (0-22).
  //    Que coincidan TODAS es lo que separa una acumulación continua de un pico.
  const oiW = [row.oi5m, row.oi15m, row.oi1h, row.oi4h, row.oi24h];
  const prW = [row.price5mPct, row.price15mPct, row.price1hPct, row.price4hPct, row.price24hPct];
  const oiUp = oiW.filter(v => v != null && v > 0).length;
  const prOk = prW.filter(v => v != null && sgn * v > 0).length;
  const both = Math.min(oiUp, prOk);
  if      (both >= 5) add('Alineación', 22, 22, `OI y precio alineados en las 5 ventanas (5m·15m·1h·4h·24h): acumulación continua, no un pico`, true);
  else if (both >= 4) add('Alineación', 16, 22, `OI y precio alineados en ${both}/5 ventanas`, true);
  else if (both >= 3) add('Alineación', 10, 22, `OI y precio alineados en ${both}/5 ventanas`, true);
  else if (prOk >= 4) add('Alineación',  5, 22, `el precio va ${prOk}/5 a favor pero el OI solo ${oiUp}/5: sube sin dinero nuevo`, false);
  else                add('Alineación',  0, 22, `sin alineación multi-ventana (OI ${oiUp}/5 · precio ${prOk}/5)`, false);

  // 2) Calidad del apalancamiento (0-18) — el discriminador más fuerte.
  const lev = briefLeverage(row);
  if (lev) add('Apalancamiento', lev.pts, 18, lev.txt, lev.pts >= 10);
  else     add('Apalancamiento', 8, 18, 'movimiento de 24h demasiado pequeño para juzgar el apalancamiento', true);

  // 3) Flujo agresor (CVD 5m) — umbral relativo al volumen propio, como scoreSymbol.
  const v5 = n(row.vol1hUSD) / 12;
  if (row.cvd5m == null || v5 <= 0) add('Flujo', 4, 12, 'sin datos de CVD', false);
  else if (sgn * row.cvd5m > v5 * 0.10) add('Flujo', 12, 12, `CVD 5m ${row.cvd5m >= 0 ? '+' : '−'}${fmtUSD(Math.abs(row.cvd5m))} a favor: el flujo agresor confirma`, true);
  else if (sgn * row.cvd5m > 0)         add('Flujo', 6, 12, `CVD 5m levemente a favor (${row.cvd5m >= 0 ? '+' : '−'}${fmtUSD(Math.abs(row.cvd5m))})`, true);
  else                                  add('Flujo', 0, 12, `CVD 5m en contra (${row.cvd5m >= 0 ? '+' : '−'}${fmtUSD(Math.abs(row.cvd5m))}): nadie está pagando el spread en esa dirección`, false);

  // 4) Funding (0-12). Que el lado contrario pague es combustible; que pague el
  //    tuyo es una posición abarrotada esperando a ser exprimida.
  const fr = n(row.fundingRate);
  if      (sgn * fr < -0.01) add('Funding', 12, 12, `funding ${fmtPct(fr)}: paga el lado contrario — combustible para el ${side}`, true);
  else if (Math.abs(fr) <= 0.01) add('Funding', 8, 12, `funding ${fmtPct(fr)} neutro: nadie sobrepaga por este lado, sin crowding`, true);
  else if (sgn * fr > 0.05) add('Funding', 0, 12, `funding ${fmtPct(fr)}: el lado ${side} paga y está abarrotado`, false);
  else                      add('Funding', 5, 12, `funding ${fmtPct(fr)}: ligeramente en contra`, true);

  // 5) Liquidez (0-12) + techo duro si no llega.
  const to = n(row.turnover24h), v1h = n(row.vol1hUSD);
  if      (to >= 50e6 && v1h >= 1e6)  add('Liquidez', 12, 12, `liquidez sobrada (24h ${fmtUSD(to)} · 1h ${fmtUSD(v1h)})`, true);
  else if (to >= 20e6 && v1h >= 500e3) add('Liquidez', 9, 12, `liquidez suficiente (24h ${fmtUSD(to)} · 1h ${fmtUSD(v1h)})`, true);
  else if (to >= BRIEF_MIN_TURNOVER && v1h >= BRIEF_MIN_VOL1H) add('Liquidez', 5, 12, `liquidez justa (24h ${fmtUSD(to)} · 1h ${fmtUSD(v1h)})`, true);
  else                                 add('Liquidez', 0, 12, `liquidez insuficiente (24h ${fmtUSD(to)} · 1h ${fmtUSD(v1h)})`, false);

  // 6) Fuerza relativa vs BTC CON consistencia (0-10). Un +RS de una sola
  //    ventana es ruido; el badge N/4 es lo que lo convierte en fuerza real.
  const cw = row.rsWins == null ? null : (side === 'long' ? row.rsWins : (row.rsValidTf || 4) - row.rsWins);
  const rsFav = row.rsBtc1h != null && sgn * row.rsBtc1h > 0;
  if (cw == null) add('vs BTC', 3, 10, 'sin datos de fuerza relativa', false);
  else if (cw >= 4 && rsFav) add('vs BTC', 10, 10, `${side === 'long' ? 'supera' : 'pierde contra'} a BTC en las 4 ventanas (RS ${fmtPct(row.rsBtc1h)}): fuerza consistente`, true);
  else if (cw >= 3 && rsFav) add('vs BTC', 6, 10, `${side === 'long' ? 'supera' : 'pierde contra'} a BTC en ${cw}/4 ventanas (RS ${fmtPct(row.rsBtc1h)})`, true);
  else if (cw >= 2)          add('vs BTC', 3, 10, `solo ${cw}/4 ventanas a favor frente a BTC: consistencia débil`, false);
  else                       add('vs BTC', 0, 10, `${cw}/4 ventanas frente a BTC: va a remolque del mercado`, false);
  if (row.rsLowLiq) { sc -= 4; parts.push({ k: 'vs BTC', pts: -4, max: 0, txt: 'RS marcada ⚠ por liquidez baja', ok: false }); }

  // 7) Tendencia del volumen (0-8).
  const vol = briefVolumeTrend(row);
  if (vol) add('Volumen', vol.pts, 8, vol.txt, vol.pts >= 5);
  else     add('Volumen', 3, 8, 'sin datos de volumen', false);

  // 8) Confirmación técnica (0-16): patrón W/M ya detectado en la fila, y si no
  //    lo hay, el régimen propio de la moneda.
  const pat = [row.pattern1h, row.pattern].find(p => p && ((p.type === 'W') === (side === 'long')));
  const sr = typeof detectSymbolRegime === 'function' ? (detectSymbolRegime(row.symbol) || (typeof fallbackSymbolRegime === 'function' ? fallbackSymbolRegime(row) : null)) : null;
  if (pat && pat.state === 'breaking')        add('Técnico', 16, 16, `doble ${pat.type === 'W' ? 'suelo' : 'techo'} en ${pat.tf} con ruptura CONFIRMADA al cierre (calidad ${pat.quality}/10)`, true);
  else if (pat && pat.state === 'confirming') add('Técnico', 9, 16, `doble ${pat.type === 'W' ? 'suelo' : 'techo'} en ${pat.tf} cruzando el cuello — esperando cierre de vela`, true);
  else if (pat && pat.state === 'broken')     add('Técnico', 6, 16, `doble ${pat.type === 'W' ? 'suelo' : 'techo'} en ${pat.tf} con el cuello ya roto hace varias velas`, true);
  else if (pat)                               add('Técnico', 2, 16, `doble ${pat.type === 'W' ? 'suelo' : 'techo'} en ${pat.tf} formándose · cuello ${fmtPrice(pat.neckline)}`, false);
  else if (sr && sr.regime === 'RUPTURA ↑' && side === 'long')  add('Técnico', 8, 16, `régimen propio: ${sr.regime} — ${sr.desc}`, true);
  else if (sr && sr.regime === 'RUPTURA ↓' && side === 'short') add('Técnico', 8, 16, `régimen propio: ${sr.regime} — ${sr.desc}`, true);
  else if (sr && sr.regime === 'COMPRIMIDO') add('Técnico', 4, 16, `régimen propio: COMPRIMIDO — ${sr.desc}, esperando ruptura`, false);
  else                                       add('Técnico', 0, 16, 'sin patrón ni ruptura de rango que confirme', false);

  // ── Penalizaciones: lo que resta después de sumar ─────────────────────────
  const ext = briefExtension(row, side);
  if (ext.pen) { sc -= ext.pen; cons.push(ext.txt); parts.push({ k: 'Extensión', pts: -ext.pen, max: 0, txt: ext.txt, ok: false }); }
  else pros.push(ext.txt);

  const flags = briefFlags(row, side, lev, vol, ext);
  for (const f of flags) {
    if (f.pen) { sc -= f.pen; parts.push({ k: 'Bandera', pts: -f.pen, max: 0, txt: f.txt, ok: false }); }
    // 'persecucion' y 'contratendencia' reutilizan el texto de ext, ya en cons
    if (f.id !== 'persecucion' && f.id !== 'contratendencia') cons.push(f.txt);
  }

  // Relación riesgo/beneficio: por bonito que sea el resto, un setup cuyo stop
  // está más lejos que el objetivo pierde dinero aunque acierte más del 50%.
  const levels = briefLevels(row, side, pat);
  if (levels && levels.rr != null && levels.rr < 1) {
    sc -= 6;
    const t = `R:R ${levels.rr.toFixed(1)}:1 — el stop está más lejos que el objetivo`;
    cons.push(t); parts.push({ k: 'R:R', pts: -6, max: 0, txt: t, ok: false });
  }

  // Techo por liquidez: coherente con el cap a 4 de scoreSymbol. Una señal
  // preciosa en una moneda ilíquida sigue siendo una señal que no puedes operar.
  const thin = flags.some(f => f.id === 'liquidez');
  if (thin && sc > BRIEF_LIQ_CAP) { caps.push(`nota limitada a ${BRIEF_LIQ_CAP} por liquidez insuficiente`); sc = BRIEF_LIQ_CAP; }

  sc = Math.max(0, Math.min(100, Math.round(sc)));

  // Tier. Una bandera 'hard' descalifica por sí sola, puntúe lo que puntúe:
  // no es una cuestión de grados, es que ese trade no se toma.
  const hard = flags.filter(f => f.hard);
  let tier;
  if (hard.length)           tier = 'EVITAR';
  else if (sc >= BRIEF_TIER_A) tier = 'A';
  else if (sc >= BRIEF_TIER_B) tier = 'B';
  else if (sc >= BRIEF_TIER_C) tier = 'C';
  else                         tier = 'D';

  return { symbol: row.symbol, side, score: sc, tier, parts, pros, cons, caps, flags, hard,
    lev, vol, ext, pat, sr, price: row.price, levels,
    conf, exp: conf && typeof confExpectation === 'function' ? confExpectation(conf.count, conf.side, conf.quad) : null,
    verdict: briefVerdictLine(row, side, sc, tier, hard, ext, lev, pat) };
}

/** La frase que resume la decisión — lo primero que se lee en la tarjeta. */
function briefVerdictLine(row, side, sc, tier, hard, ext, lev, pat) {
  const s = side === 'long' ? 'compra' : 'venta';
  if (hard.length) return `NO ENTRAR — ${hard[0].txt}`;
  if (tier === 'A' && ext.level === 'temprano') return `${s.toUpperCase()} con el movimiento todavía joven y estructura limpia: es la que mejor relación fiabilidad/timing tiene ahora.`;
  if (tier === 'A') return `${s.toUpperCase()} válida: la estructura acompaña. Entrada en retroceso, no a mercado — ${ext.txt}.`;
  if (tier === 'B' && pat && pat.state === 'forming') return `Todavía no. Falta que cierre la ruptura del cuello en ${pat.tf}; ahí se convierte en entrada.`;
  if (tier === 'B') return `Vigilar, no entrar: la tesis está viva pero le falta confirmación${lev && lev.kind === 'perp' ? ' y el movimiento va apalancado' : ''}.`;
  if (tier === 'C') return 'Solo contexto: hay movimiento pero no confluencia suficiente para arriesgar capital.';
  return 'Descartada.';
}

// ════════════════════════════════════════════════════════════════════════════
// 3. VEREDICTO DE MERCADO
// ════════════════════════════════════════════════════════════════════════════

/** Antes de mirar ninguna moneda: ¿es momento de comprar, de ser selectivo o
 *  de estar fuera? Y sobre todo el tamaño, que es la decisión que más dinero
 *  ahorra. Cruza el semáforo de riesgo, el régimen, la CALIDAD de la amplitud
 *  (cuántos de los pares al alza son compra real y cuántos solo cierre de
 *  cortos) y el estado de BTC. */
function briefMarket(rows) {
  const valid = rows.filter(r => r.oi1h != null && r.price1hPct != null);
  if (valid.length < 10) return null;

  const longQ   = valid.filter(r => r.oi1h >= 0 && r.price1hPct >= 0).length;
  const shortQ  = valid.filter(r => r.oi1h >= 0 && r.price1hPct <  0).length;
  const squeeze = valid.filter(r => r.oi1h <  0 && r.price1hPct >= 0).length;
  const liq     = valid.filter(r => r.oi1h <  0 && r.price1hPct <  0).length;
  const up = longQ + squeeze, total = valid.length;

  const risk = typeof marketRiskLight === 'function' ? marketRiskLight() : null;
  const reg  = typeof detectRegime === 'function' ? detectRegime(rows) : { regime: '—' };
  const btc  = rows.find(r => r.symbol === 'BTC');

  const notes = [];

  // BTC: sin dirección propia no hay viento de cola para nada.
  if (btc) {
    const oiW = [btc.oi5m, btc.oi15m, btc.oi1h, btc.oi4h, btc.oi24h];
    const oiDn = oiW.filter(v => v != null && v < 0).length;
    const oiN  = oiW.filter(v => v != null).length;
    const mv = Math.abs(btc.moveAtr1h ?? 0);
    const state = mv < 0.5 ? 'plano' : mv < 1.2 ? 'moviéndose' : 'movimiento extremo';
    notes.push({ icon: '₿', txt: `BTC ${state} (${(btc.moveAtr1h ?? 0).toFixed(1)}×ATR 1h) con el OI ${oiDn >= Math.ceil(oiN * 0.6) ? `cayendo en ${oiDn}/${oiN} ventanas — desapalancamiento, no acumulación` : `mixto (${oiDn}/${oiN} ventanas a la baja)`}`,
      bad: oiDn >= Math.ceil(oiN * 0.6) || mv >= 1.2 });
  }

  // Calidad de la amplitud: el número que el "48 vs 52" esconde.
  const sqShare = up > 0 ? squeeze / up : 0;
  notes.push({ icon: '📊', txt: `${up} de ${total} pares al alza, pero ${squeeze} son SQUEEZE (cierre de cortos, no compra): solo ${longQ} tienen compra real. ${liq} pares están en LIQ desapalancándose.`,
    bad: sqShare > 0.3 || liq / total > 0.35 });

  // Apalancamiento del sistema entero.
  const stretched = valid.filter(r => Math.abs(r.fundingRate ?? 0) >= 0.05).length;
  if (stretched >= 5) notes.push({ icon: '💸', txt: `${stretched} pares con funding extremo (≥0.05%): hay combustible para squeezes en ambos sentidos`, bad: stretched >= 15 });

  for (const w of (risk?.why || [])) notes.push({ icon: '⚠', txt: w, bad: true });

  // Veredicto + tamaño.
  let verdict, sizePct, mode, color;
  if (risk && risk.risk >= 60) {
    verdict = 'FUERA'; sizePct = 0; color = '#ff5555';
    mode = 'Riesgo de mercado en rojo. No es momento de abrir nada: espera a que pase.';
  } else if (reg.regime === 'ALCISTA' && sqShare < 0.3 && (!risk || risk.risk < 30)) {
    verdict = 'COMPRAR'; sizePct = 100; color = '#2fe08a';
    mode = 'Mercado con compra real y riesgo bajo: continuaciones a favor con tamaño normal.';
  } else if (reg.regime === 'BAJISTA' && (!risk || risk.risk < 45)) {
    verdict = 'VENDER'; sizePct = 70; color = '#ff5555';
    mode = 'Sesgo bajista del mercado: evita longs en alts, los rebotes son para vender.';
  } else if (risk && risk.risk >= 30) {
    verdict = 'SELECTIVO'; sizePct = 40; color = '#e0a830';
    mode = `Riesgo ${risk.risk}/100 en ámbar: tamaño reducido y solo setups que pasen el filtro entero. Máximo 2 posiciones abiertas.`;
  } else {
    verdict = 'ESPERAR'; sizePct = 25; color = '#4a7a8a';
    mode = 'Sin dirección de mercado: no hay beta que montar. Solo gatillos concretos (rupturas de cuello), nunca perseguir velas.';
  }

  return { verdict, sizePct, mode, color, notes, longQ, shortQ, squeeze, liq, up, total,
    sqShare, risk, regime: reg.regime, stretched };
}

// ════════════════════════════════════════════════════════════════════════════
// 4. MOTOR: analiza todo el mercado y ordena
// ════════════════════════════════════════════════════════════════════════════

function buildBrief(rows) {
  const mkt = briefMarket(rows);
  if (!mkt) return null;

  // Confluencia del radar, para colgar de cada candidata su expectativa
  // histórica REAL (win-rate medido, no opinión).
  const confRes = typeof computeConfluence === 'function' ? computeConfluence(rows) : null;
  const confBySym = new Map((confRes?.confs || []).map(c => [c.symbol, c]));

  const all = rows
    .filter(r => r.symbol !== 'BTC' && r.price1hPct != null && r.oi1h != null)
    .map(r => briefReliability(r, confBySym.get(r.symbol) || null));

  const pick = all.filter(a => a.tier !== 'EVITAR' && a.tier !== 'D')
    .filter(a => !briefOnlyLongs || a.side === 'long')
    .sort((a, b) => b.score - a.score);

  // Evitar: solo las que además tienen movimiento (una moneda dormida e
  // ilíquida no es una trampa, es que no existe). Se ordenan por lo llamativas
  // que resultan, que es justo el orden en que uno cae en ellas.
  const p24 = new Map(rows.map(r => [r.symbol, Math.abs(r.price24hPct ?? 0)]));
  const avoid = all.filter(a => a.tier === 'EVITAR' && (p24.get(a.symbol) ?? 0) >= 8)
    .sort((a, b) => (b.hard.length - a.hard.length) || b.score - a.score)
    .slice(0, 10);

  // Vigilar: cuellos cercanos. El mejor R/R del tablero porque el gatillo es
  // objetivo y el stop está definido antes de entrar.
  const watch = [];
  for (const r of rows) {
    for (const p of [r.pattern1h, r.pattern]) {
      if (!p || (p.state !== 'forming' && p.state !== 'confirming')) continue;
      if ((r.vol1hUSD ?? 0) < BRIEF_MIN_VOL1H) continue;
      const dist = (p.neckline - r.price) / r.price * 100 * (p.type === 'W' ? 1 : -1);
      if (dist < 0 || dist > 3) continue; // a menos de un 3% del gatillo
      watch.push({ symbol: r.symbol, type: p.type, tf: p.tf, dist, neckline: p.neckline,
        target: p.target, stop: p.stop, quality: p.quality, state: p.state });
      break;
    }
  }
  watch.sort((a, b) => a.dist - b.dist);

  return { mkt, top: pick[0] || null, list: pick.slice(0, 9), avoid, watch: watch.slice(0, 12), all };
}

// ════════════════════════════════════════════════════════════════════════════
// 5. RENDER
// ════════════════════════════════════════════════════════════════════════════

const BRIEF_TIER_META = {
  A: { label: 'A · FIABLE',   color: '#2fe08a' },
  B: { label: 'B · VIGILAR',  color: '#e0a830' },
  C: { label: 'C · CONTEXTO', color: '#4a7a8a' },
  EVITAR: { label: '⛔ EVITAR', color: '#ff5555' },
};

// Etiqueta corta del motivo por el que una moneda va a la lista de evitar.
const BRIEF_FLAG_LABEL = {
  persecucion:     'persecución',
  contratendencia: 'contratendencia',
  distribucion:    'distribución',
  liquidez:        'liquidez baja',
  squeezeAgotado:  'squeeze agotado',
  volSeco:         'sin volumen',
  flujoContra:     'flujo en contra',
  rsRuido:         'RS no fiable',
};

// ── Ciclo: cálculo + alertas en CUALQUIER pestaña ──────────────────────────
// Coste de red: CERO. load() ya descarga los datos cada ~10s estés en la
// pestaña que estés; esto solo cruza allRows, que ya está en memoria. Lo único
// que se gasta son unos pocos ms de CPU sobre ~100 filas.
//
// El PINTADO sí sigue atado a la pestaña activa: construir 14KB de HTML que
// nadie está mirando no aporta nada. Por eso se separa en dos: briefOnCycle()
// calcula y avisa siempre; renderBrief() solo dibuja lo ya calculado.
let briefCache = null;
let briefAlertArmed = new Map();  // symbol → {armed, ts}
let _prevBriefVerdict = null;

const BRIEF_ALERT_REARM    = BRIEF_TIER_A - 8; // hay que enfriarse por debajo para volver a avisar
const BRIEF_ALERT_COOLDOWN = 45 * 60_000;      // y como mucho 1 aviso por moneda cada 45 min

function briefOnCycle() {
  if (!allRows.length) return;
  briefCache = buildBrief(allRows);
  if (briefCache) briefAlerts(briefCache);
}

/** Avisos. Dos únicos disparadores, ambos raros y accionables: que el mercado
 *  cambie de veredicto (decide el tamaño) y que una moneda entre en tier A. */
function briefAlerts(b) {
  const now = Date.now();

  // 1) Veredicto de mercado. Es la decisión que más dinero ahorra, y cambia
  //    pocas veces al día: merece interrumpir.
  const v = b.mkt.verdict;
  if (_prevBriefVerdict && v !== _prevBriefVerdict && canAlert('briefMkt')) {
    const dir = v === 'COMPRAR' ? 'long' : v === 'VENDER' ? 'short' : 'neutral';
    showToast(`🧠 Mercado → ${v} · tamaño ${b.mkt.sizePct}%`, dir === 'neutral' ? '' : dir);
    playAlertSound('briefMkt', dir);
    notifyDesktop(`🧠 Brief: mercado → ${v}`, b.mkt.mode);
  }
  _prevBriefVerdict = v;

  // 2) Promoción a tier A, CON HISTÉRESIS. Una moneda rondando el umbral
  //    cruzaría arriba y abajo cada ciclo y avisaría cada 10 segundos: se avisa
  //    al entrar y no se vuelve a armar hasta que caiga claramente por debajo.
  //    Se recorre b.all y no b.list a propósito — las alertas no deben depender
  //    del filtro "solo longs" de la cabecera, que es cosa de la vista.
  const seen = new Set();
  for (const a of b.all) {
    seen.add(a.symbol);
    const st = briefAlertArmed.get(a.symbol) || { armed: true, ts: 0 };
    if (a.tier !== 'A') {
      if (a.score < BRIEF_ALERT_REARM) st.armed = true; // se enfrió: rearmar
      briefAlertArmed.set(a.symbol, st);
      continue;
    }
    if (st.armed && now - st.ts > BRIEF_ALERT_COOLDOWN && canAlert('briefTop')) {
      const lv = a.levels;
      showToast(`🧠 ${a.symbol} ${a.side.toUpperCase()} → tier A (${a.score}/100)`, a.side);
      playAlertSound('briefTop', a.side);
      notifyDesktop(`🧠 ${a.symbol} ${a.side.toUpperCase()} es tier A · ${a.score}/100`,
        a.verdict + (lv ? `\nEntrada ${fmtPrice(lv.entry)} · stop ${fmtPrice(lv.stop)} · TP ${fmtPrice(lv.tp1)}` : ''));
      st.armed = false; st.ts = now;
    }
    briefAlertArmed.set(a.symbol, st);
  }
  for (const s of [...briefAlertArmed.keys()]) if (!seen.has(s)) briefAlertArmed.delete(s);
}

function toggleBriefLongs() { briefOnlyLongs = !briefOnlyLongs; briefCache = null; renderBrief(); }
function toggleBriefDetail(sym) {
  if (briefExpanded.has(sym)) briefExpanded.delete(sym); else briefExpanded.add(sym);
  renderBrief();
}

function briefBar(pts, max) {
  const pct = max > 0 ? Math.max(0, Math.min(100, pts / max * 100)) : 0;
  const col = pts < 0 ? '#ff5555' : pct >= 75 ? '#2fe08a' : pct >= 40 ? '#e0a830' : '#4a5870';
  return `<div class="bf-bar"><div class="bf-bar-fill" style="width:${pts < 0 ? 100 : pct}%;background:${col}"></div></div>`;
}

/** Tarjeta completa de "la más fiable": el porqué entero de la decisión. */
function briefTopCard(a) {
  const t = BRIEF_TIER_META[a.tier] || BRIEF_TIER_META.C;
  const lv = a.levels;
  const lvHtml = !lv ? '<span class="bf-dim">sin ATR ni patrón para calcular niveles</span>' : `
    <span>entrada <b>${fmtPrice(lv.entry)}</b></span>
    <span>stop <b class="neg">${fmtPrice(lv.stop)}</b></span>
    <span>TP1 <b class="pos">${fmtPrice(lv.tp1)}</b></span>
    <span>TP2 <b class="pos">${fmtPrice(lv.tp2)}</b></span>
    ${lv.rr ? `<span>R:R <b>${lv.rr.toFixed(1)}:1</b></span>` : ''}
    <span class="bf-dim">· ${lv.src}${lv.note ? ' — ' + lv.note : ''}</span>`;

  const exp = a.exp
    ? `<div class="bf-exp">📐 Evidencia histórica de esta configuración: <b>${a.exp.wr}%</b> ±${a.exp.pm} de acierto a +1h en <b>${a.exp.n}</b> señales previas de <i>${a.exp.grp}</i></div>`
    : `<div class="bf-exp bf-dim">📐 Sin muestra histórica suficiente todavía para esta configuración (hacen falta ≥15 señales resueltas)</div>`;

  return `<div class="bf-top">
    <div class="bf-top-head">
      <span class="bf-crown">★ LA MÁS FIABLE AHORA</span>
      <span class="cc-sym" style="font-size:17px">${a.symbol}</span>
      <span class="cc-side ${a.side}">${a.side.toUpperCase()}</span>
      <span class="bf-tier" style="background:${t.color}22;color:${t.color};border-color:${t.color}55">${t.label}</span>
      <span class="bf-price">${fmtPrice(a.price)}</span>
      <span class="bf-score" style="color:${t.color}">${a.score}<span class="bf-score-max">/100</span></span>
    </div>
    <div class="bf-verdict" style="color:${t.color}">${a.verdict}</div>
    <div class="bf-cols">
      <div class="bf-col">
        <div class="bf-col-h pos">✓ A favor</div>
        ${a.pros.map(p => `<div class="bf-li pos">· ${p}</div>`).join('') || '<div class="bf-li bf-dim">—</div>'}
      </div>
      <div class="bf-col">
        <div class="bf-col-h neg">✗ En contra</div>
        ${a.cons.map(p => `<div class="bf-li neg">· ${p}</div>`).join('') || '<div class="bf-li bf-dim">nada relevante en contra</div>'}
      </div>
    </div>
    <div class="bf-levels">${lvHtml}</div>
    ${exp}
    ${a.caps.length ? `<div class="bf-cap">⚠ ${a.caps.join(' · ')}</div>` : ''}
    <div class="bf-breakdown">
      <div class="bf-col-h">Desglose de la nota</div>
      ${a.parts.map(p => `<div class="bf-part">
        <span class="bf-part-k">${p.k}</span>
        ${briefBar(p.pts, p.max)}
        <span class="bf-part-p" style="color:${p.pts < 0 ? '#ff5555' : p.pts > 0 ? '#c8d8ff' : '#4a5870'}">${p.pts > 0 ? '+' : ''}${p.pts}${p.max ? '/' + p.max : ''}</span>
        <span class="bf-part-t">${p.txt}</span>
      </div>`).join('')}
    </div>
  </div>`;
}

/** Tarjeta compacta del resto del ranking (expandible al desglose completo). */
function briefCard(a) {
  const t = BRIEF_TIER_META[a.tier] || BRIEF_TIER_META.C;
  const open = briefExpanded.has(a.symbol);
  const lv = a.levels;
  return `<div class="bf-card${open ? ' bf-open' : ''}" onclick="toggleBriefDetail('${a.symbol}')" title="Clic para ver el desglose completo">
    <div class="cc-top">
      <span class="cc-sym">${a.symbol}</span>
      <span class="cc-side ${a.side}">${a.side.toUpperCase()}</span>
      <span class="bf-tier" style="background:${t.color}22;color:${t.color};border-color:${t.color}55">${t.label}</span>
      <span class="cc-count" style="color:${t.color}">${a.score}</span>
    </div>
    <div class="bf-verdict-sm">${a.verdict}</div>
    <div class="bf-mini">
      ${a.pros.slice(0, 2).map(p => `<div class="bf-li pos">· ${p}</div>`).join('')}
      ${a.cons.slice(0, 1).map(p => `<div class="bf-li neg">· ${p}</div>`).join('')}
    </div>
    ${lv ? `<div class="bf-levels bf-levels-sm">
      <span>ent <b>${fmtPrice(lv.entry)}</b></span>
      <span>stop <b class="neg">${fmtPrice(lv.stop)}</b></span>
      <span>TP <b class="pos">${fmtPrice(lv.tp1)}</b></span>
      ${lv.rr ? `<span><b>${lv.rr.toFixed(1)}R</b></span>` : ''}
    </div>` : ''}
    ${open ? `<div class="bf-breakdown">
      ${a.parts.map(p => `<div class="bf-part">
        <span class="bf-part-k">${p.k}</span>${briefBar(p.pts, p.max)}
        <span class="bf-part-p" style="color:${p.pts < 0 ? '#ff5555' : '#c8d8ff'}">${p.pts > 0 ? '+' : ''}${p.pts}</span>
        <span class="bf-part-t">${p.txt}</span>
      </div>`).join('')}
      ${a.exp ? `<div class="bf-exp">📐 ${a.exp.wr}% ±${a.exp.pm} a +1h · n=${a.exp.n} (${a.exp.grp})</div>` : ''}
    </div>` : ''}
  </div>`;
}

function renderBrief() {
  const el = document.getElementById('brief-body');
  if (!el) return;
  if (!allRows.length) { el.innerHTML = '<div class="cc-note">Esperando datos…</div>'; return; }

  // Reutiliza lo que ya calculó briefOnCycle() este ciclo; solo recalcula si
  // aún no hay nada (primer pintado, o tras tocar el filtro de la cabecera).
  const b = briefCache || (briefCache = buildBrief(allRows));
  if (!b) { el.innerHTML = '<div class="cc-note">Datos insuficientes para el brief.</div>'; return; }
  const m = b.mkt;

  const head = document.getElementById('brief-head-extra');
  if (head) head.innerHTML = `
    <span class="bf-badge" style="background:${m.color}1f;color:${m.color};border-color:${m.color}66">${m.verdict}</span>
    <span class="bf-size">tamaño sugerido <b style="color:${m.color}">${m.sizePct}%</b></span>
    <button class="chart-tf-btn${briefOnlyLongs ? ' active' : ''}" onclick="toggleBriefLongs()" title="Ocultar las tesis cortas">solo longs</button>`;

  const ctx = `<div class="bf-ctx">
    <div class="bf-ctx-mode" style="border-color:${m.color}44">
      <span style="color:${m.color};font-weight:800">${m.verdict}</span> — ${m.mode}
    </div>
    <div class="bf-quads">
      ${[['LONG', m.longQ, '#2fe08a', 'OI↑ + precio↑ · compra real'],
         ['SQUEEZE', m.squeeze, '#4aa8d8', 'OI↓ + precio↑ · cierre de cortos, no compra'],
         ['SHORT', m.shortQ, '#ff5555', 'OI↑ + precio↓ · venta real'],
         ['LIQ', m.liq, '#aa6060', 'OI↓ + precio↓ · desapalancamiento']]
        .map(([k, v, c, tip]) => `<div class="bf-quad" title="${tip}">
          <div class="bf-quad-v" style="color:${c}">${v}</div><div class="bf-quad-k">${k}</div>
        </div>`).join('')}
      <div class="bf-quad" title="Semáforo de riesgo de mercado (0-100)">
        <div class="bf-quad-v" style="color:${m.color}">${m.risk ? m.risk.risk : '—'}</div><div class="bf-quad-k">RIESGO</div>
      </div>
      <div class="bf-quad" title="Régimen del mercado completo">
        <div class="bf-quad-v" style="font-size:12px;color:#8fa8c8">${m.regime}</div><div class="bf-quad-k">RÉGIMEN</div>
      </div>
    </div>
    <div class="bf-notes">${m.notes.map(nt => `<div class="bf-note${nt.bad ? ' bad' : ''}"><span>${nt.icon}</span>${nt.txt}</div>`).join('')}</div>
  </div>`;

  const top = b.top ? briefTopCard(b.top)
    : `<div class="cc-note">Ninguna moneda pasa el filtro de fiabilidad ahora mismo. En mercado lateral es el resultado normal — no forzar entradas.</div>`;

  const rest = b.list.slice(1);
  const grid = rest.length ? `<div class="bf-sub">Resto del ranking — clic en cualquiera para ver su desglose completo</div>
    <div class="bf-grid">${rest.map(briefCard).join('')}</div>` : '';

  const watch = b.watch.length ? `<div class="bf-sub">👁 A menos de un 3% del gatillo — el mejor R:R del tablero: el stop está definido antes de entrar</div>
    <div class="bf-chips">${b.watch.map(w => `<span class="pat-chip" onclick="openInRadar('${w.symbol}')"
      title="Doble ${w.type === 'W' ? 'suelo' : 'techo'} en ${w.tf} · cuello ${fmtPrice(w.neckline)} · objetivo ${fmtPrice(w.target)} · stop ${fmtPrice(w.stop)} · calidad ${w.quality}/10">
      <b style="color:${w.type === 'W' ? '#2fe08a' : '#ff5555'}">${w.symbol}</b>
      <span style="color:#5a6a85">${w.type}${w.tf}</span>
      <b style="color:#e0a830">+${w.dist.toFixed(2)}%</b>
      ${w.state === 'confirming' ? '<span style="color:#e0a830">⏳</span>' : ''}
    </span>`).join('')}</div>` : '';

  const avoid = b.avoid.length ? `<div class="bf-sub">⛔ Se mueven pero NO se compran — aquí es donde se pierde dinero</div>
    <div class="bf-chips">${b.avoid.map(a => {
      const f = a.hard[0];
      const why = (f?.txt || a.cons[0] || 'sin confluencia').replace(/"/g, '&quot;');
      return `<span class="pat-chip bf-avoid" onclick="openInRadar('${a.symbol}')" title="${why}">
        <b style="color:#ff8888">${a.symbol}</b>
        <span style="color:#7a8090">${BRIEF_FLAG_LABEL[f?.id] || 'sin confluencia'}</span>
      </span>`;
    }).join('')}</div>` : '';

  el.innerHTML = ctx + top + grid + watch + avoid;
}
