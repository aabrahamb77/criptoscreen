// Familias de estrategias candidatas para BTC (long + short).
// Todas leen unicamente datos de la vela i ya cerrada -> sin look-ahead.
const E = require('./engine');

// ── util: maximos/minimos deslizantes O(n) con deque monotona ───────────────
function rollMax(src, len) {
  const n = src.length, out = new Float64Array(n).fill(NaN), dq = [];
  for (let i = 0; i < n; i++) {
    while (dq.length && src[dq[dq.length - 1]] <= src[i]) dq.pop();
    dq.push(i);
    if (dq[0] <= i - len) dq.shift();
    if (i >= len - 1) out[i] = src[dq[0]];
  }
  return out;
}
function rollMin(src, len) {
  const n = src.length, out = new Float64Array(n).fill(NaN), dq = [];
  for (let i = 0; i < n; i++) {
    while (dq.length && src[dq[dq.length - 1]] >= src[i]) dq.pop();
    dq.push(i);
    if (dq[0] <= i - len) dq.shift();
    if (i >= len - 1) out[i] = src[dq[0]];
  }
  return out;
}

// ── cache de indicadores (evita recalcular en el barrido) ───────────────────
function crearCache(d) {
  const m = new Map();
  const get = (clave, fn) => { if (!m.has(clave)) m.set(clave, fn()); return m.get(clave); };
  return {
    ema:  l => get('ema' + l,  () => E.ema(d.close, l)),
    sma:  l => get('sma' + l,  () => E.sma(d.close, l)),
    atr:  l => get('atr' + l,  () => E.atr(d, l)),
    rsi:  l => get('rsi' + l,  () => E.rsi(d.close, l)),
    adx:  l => get('adx' + l,  () => E.adx(d, l)),
    std:  l => get('std' + l,  () => E.stdev(d.close, l)),
    maxH: l => get('maxH' + l, () => rollMax(d.high, l)),
    minL: l => get('minL' + l, () => rollMin(d.low, l)),
    maxC: l => get('maxC' + l, () => rollMax(d.close, l)),
    minC: l => get('minC' + l, () => rollMin(d.close, l)),
    st:   (l, mult) => get(`st${l}_${mult}`, () => supertrend(d, l, mult))
  };
}

function supertrend(d, len, mult) {
  const n = d.n, a = E.atr(d, len);
  const dir = new Float64Array(n).fill(NaN), linea = new Float64Array(n).fill(NaN);
  let arribaPrev = NaN, abajoPrev = NaN, dirPrev = 1;
  for (let i = 0; i < n; i++) {
    if (!isFinite(a[i])) continue;
    const medio = (d.high[i] + d.low[i]) / 2;
    let arriba = medio + mult * a[i], abajo = medio - mult * a[i];
    if (isFinite(abajoPrev))  abajo  = (abajo  > abajoPrev  || d.close[i - 1] < abajoPrev)  ? abajo  : abajoPrev;
    if (isFinite(arribaPrev)) arriba = (arriba < arribaPrev || d.close[i - 1] > arribaPrev) ? arriba : arribaPrev;
    let dd;
    if (!isFinite(arribaPrev)) dd = 1;
    else if (d.close[i] > arribaPrev) dd = 1;
    else if (d.close[i] < abajoPrev)  dd = -1;
    else dd = dirPrev;
    dir[i] = dd; linea[i] = dd === 1 ? abajo : arriba;
    arribaPrev = arriba; abajoPrev = abajo; dirPrev = dd;
  }
  return { dir, linea };
}

// ═══════════════════════════════════════════════════════════════════════════
// S1 · Ruptura Donchian con tendencia + salida chandelier (trend following)
// ═══════════════════════════════════════════════════════════════════════════
function s1_donchian(d, c, p) {
  const maxH = c.maxH(p.entrada), minL = c.minL(p.entrada);
  const a = c.atr(p.atrLen), tend = c.ema(p.tendLen);
  let picoAlto = -Infinity, picoBajo = Infinity;

  return (i, pos) => {
    if (i < Math.max(p.entrada, p.tendLen, p.atrLen) + 2) return null;
    const px = d.close[i], A = a[i];
    if (!isFinite(A) || !isFinite(tend[i])) return null;

    if (pos !== 0) {
      if (pos === 1)  picoAlto = Math.max(picoAlto, d.high[i]);
      else            picoBajo = Math.min(picoBajo, d.low[i]);
      const trail = pos === 1 ? picoAlto - p.trailMult * A : picoBajo + p.trailMult * A;
      return { dir: 0, stop: trail, salir: false };
    }

    picoAlto = -Infinity; picoBajo = Infinity;
    const rupAlza = px > maxH[i - 1];
    const rupBaja = px < minL[i - 1];
    const alcista = px > tend[i], bajista = px < tend[i];

    if (rupAlza && alcista && !p.soloCortos) {
      picoAlto = d.high[i];
      return { dir: 1, stopIni: px - p.stopMult * A };
    }
    if (rupBaja && bajista && !p.soloLargos) {
      picoBajo = d.low[i];
      return { dir: -1, stopIni: px + p.stopMult * A };
    }
    return null;
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// S2 · Cruce de EMAs con filtro ADX + stop/trailing ATR
// ═══════════════════════════════════════════════════════════════════════════
function s2_emaCross(d, c, p) {
  const rap = c.ema(p.rapida), len = c.ema(p.lenta), A = c.atr(p.atrLen);
  const ad = c.adx(p.adxLen).adx, tend = c.ema(p.tendLen);
  let picoAlto = -Infinity, picoBajo = Infinity;

  return (i, pos) => {
    if (i < Math.max(p.lenta, p.tendLen, p.adxLen) + 3) return null;
    if (!isFinite(len[i]) || !isFinite(A[i]) || !isFinite(ad[i]) || !isFinite(tend[i])) return null;

    if (pos !== 0) {
      if (pos === 1)  picoAlto = Math.max(picoAlto, d.high[i]);
      else            picoBajo = Math.min(picoBajo, d.low[i]);
      const trail = pos === 1 ? picoAlto - p.trailMult * A[i] : picoBajo + p.trailMult * A[i];
      const cruzaContra = pos === 1 ? rap[i] < len[i] : rap[i] > len[i];
      if (cruzaContra) return { dir: 0, stop: trail, salir: true };
      return { dir: 0, stop: trail, salir: false };
    }

    picoAlto = -Infinity; picoBajo = Infinity;
    const cruceArriba = rap[i] > len[i] && rap[i - 1] <= len[i - 1];
    const cruceAbajo  = rap[i] < len[i] && rap[i - 1] >= len[i - 1];
    const fuerza = ad[i] >= p.adxMin;

    if (cruceArriba && fuerza && d.close[i] > tend[i] && !p.soloCortos) {
      picoAlto = d.high[i];
      return { dir: 1, stopIni: d.close[i] - p.stopMult * A[i] };
    }
    if (cruceAbajo && fuerza && d.close[i] < tend[i] && !p.soloLargos) {
      picoBajo = d.low[i];
      return { dir: -1, stopIni: d.close[i] + p.stopMult * A[i] };
    }
    return null;
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// S3 · Supertrend con filtro de tendencia mayor
// ═══════════════════════════════════════════════════════════════════════════
function s3_supertrend(d, c, p) {
  const st = c.st(p.stLen, p.stMult), A = c.atr(p.atrLen), tend = c.ema(p.tendLen);
  return (i, pos) => {
    if (i < Math.max(p.stLen, p.tendLen) + 3) return null;
    if (!isFinite(st.dir[i]) || !isFinite(tend[i]) || !isFinite(A[i])) return null;

    if (pos !== 0) {
      const contra = pos === 1 ? st.dir[i] === -1 : st.dir[i] === 1;
      if (contra) return { dir: 0, salir: true };
      return { dir: 0, stop: st.linea[i], salir: false };
    }
    const flipAlza = st.dir[i] === 1 && st.dir[i - 1] === -1;
    const flipBaja = st.dir[i] === -1 && st.dir[i - 1] === 1;
    if (flipAlza && d.close[i] > tend[i] && !p.soloCortos)
      return { dir: 1, stopIni: Math.min(st.linea[i], d.close[i] - p.stopMult * A[i]) };
    if (flipBaja && d.close[i] < tend[i] && !p.soloLargos)
      return { dir: -1, stopIni: Math.max(st.linea[i], d.close[i] + p.stopMult * A[i]) };
    return null;
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// S4 · Reversion a la media (Bollinger + RSI) en regimen lateral
// ═══════════════════════════════════════════════════════════════════════════
function s4_reversion(d, c, p) {
  const base = c.sma(p.bbLen), sd = c.std(p.bbLen), A = c.atr(p.atrLen);
  const r = c.rsi(p.rsiLen), ad = c.adx(p.adxLen).adx;
  return (i, pos) => {
    if (i < Math.max(p.bbLen, p.adxLen, p.rsiLen) + 3) return null;
    if (!isFinite(base[i]) || !isFinite(sd[i]) || !isFinite(r[i]) || !isFinite(ad[i]) || !isFinite(A[i])) return null;

    const sup = base[i] + p.bbMult * sd[i], inf = base[i] - p.bbMult * sd[i];

    if (pos !== 0) {
      if (pos === 1 && d.close[i] >= base[i])  return { dir: 0, salir: true };
      if (pos === -1 && d.close[i] <= base[i]) return { dir: 0, salir: true };
      return null;
    }
    const lateral = ad[i] <= p.adxMax;
    if (!lateral) return null;
    if (d.close[i] < inf && r[i] < p.rsiBajo && !p.soloCortos)
      return { dir: 1, stopIni: d.close[i] - p.stopMult * A[i] };
    if (d.close[i] > sup && r[i] > p.rsiAlto && !p.soloLargos)
      return { dir: -1, stopIni: d.close[i] + p.stopMult * A[i] };
    return null;
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// S5 · Compresion de volatilidad (BB dentro de Keltner) + ruptura
// ═══════════════════════════════════════════════════════════════════════════
function s5_squeeze(d, c, p) {
  const base = c.sma(p.bbLen), sd = c.std(p.bbLen), A = c.atr(p.kcLen);
  const maxH = c.maxH(p.rupt), minL = c.minL(p.rupt), tend = c.ema(p.tendLen);
  let picoAlto = -Infinity, picoBajo = Infinity;

  return (i, pos) => {
    if (i < Math.max(p.bbLen, p.kcLen, p.tendLen, p.rupt) + 3) return null;
    if (!isFinite(base[i]) || !isFinite(sd[i]) || !isFinite(A[i]) || !isFinite(tend[i])) return null;

    if (pos !== 0) {
      if (pos === 1)  picoAlto = Math.max(picoAlto, d.high[i]);
      else            picoBajo = Math.min(picoBajo, d.low[i]);
      const trail = pos === 1 ? picoAlto - p.trailMult * A[i] : picoBajo + p.trailMult * A[i];
      return { dir: 0, stop: trail, salir: false };
    }

    picoAlto = -Infinity; picoBajo = Infinity;
    // squeeze: bandas de Bollinger dentro del canal de Keltner
    const bbSup = base[i] + p.bbMult * sd[i], bbInf = base[i] - p.bbMult * sd[i];
    const kcSup = base[i] + p.kcMult * A[i],  kcInf = base[i] - p.kcMult * A[i];
    const comprimidoAntes = (() => {
      for (let k = 1; k <= p.barrasSqz; k++) {
        const j = i - k;
        if (j < 0 || !isFinite(sd[j]) || !isFinite(A[j])) return false;
        const s = base[j] + p.bbMult * sd[j] < base[j] + p.kcMult * A[j]
               && base[j] - p.bbMult * sd[j] > base[j] - p.kcMult * A[j];
        if (!s) return false;
      }
      return true;
    })();
    const yaNoComprimido = !(bbSup < kcSup && bbInf > kcInf);
    if (!(comprimidoAntes && yaNoComprimido)) return null;

    if (d.close[i] > maxH[i - 1] && d.close[i] > tend[i] && !p.soloCortos) {
      picoAlto = d.high[i];
      return { dir: 1, stopIni: d.close[i] - p.stopMult * A[i] };
    }
    if (d.close[i] < minL[i - 1] && d.close[i] < tend[i] && !p.soloLargos) {
      picoBajo = d.low[i];
      return { dir: -1, stopIni: d.close[i] + p.stopMult * A[i] };
    }
    return null;
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// S6 · Momento relativo: ruptura de cierre + pendiente de tendencia + ADX
// ═══════════════════════════════════════════════════════════════════════════
function s6_momentum(d, c, p) {
  const maxC = c.maxC(p.lookback), minC = c.minC(p.lookback);
  const tend = c.ema(p.tendLen), A = c.atr(p.atrLen), ad = c.adx(p.adxLen).adx;
  let picoAlto = -Infinity, picoBajo = Infinity, barrasEnPos = 0;

  return (i, pos) => {
    if (i < Math.max(p.lookback, p.tendLen, p.adxLen) + 3) return null;
    if (!isFinite(tend[i]) || !isFinite(A[i]) || !isFinite(ad[i])) return null;

    if (pos !== 0) {
      barrasEnPos++;
      if (pos === 1)  picoAlto = Math.max(picoAlto, d.high[i]);
      else            picoBajo = Math.min(picoBajo, d.low[i]);
      const trail = pos === 1 ? picoAlto - p.trailMult * A[i] : picoBajo + p.trailMult * A[i];
      if (p.maxBarras && barrasEnPos >= p.maxBarras) return { dir: 0, salir: true };
      return { dir: 0, stop: trail, salir: false };
    }

    picoAlto = -Infinity; picoBajo = Infinity; barrasEnPos = 0;
    const pendiente = (tend[i] - tend[i - p.pendiente]) / tend[i - p.pendiente];
    const fuerza = ad[i] >= p.adxMin;

    if (d.close[i] > maxC[i - 1] && pendiente > p.pendMin && fuerza && !p.soloCortos) {
      picoAlto = d.high[i];
      return { dir: 1, stopIni: d.close[i] - p.stopMult * A[i] };
    }
    if (d.close[i] < minC[i - 1] && pendiente < -p.pendMin && fuerza && !p.soloLargos) {
      picoBajo = d.low[i];
      return { dir: -1, stopIni: d.close[i] + p.stopMult * A[i] };
    }
    return null;
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// S7 · s2 refinada: filtro de PENDIENTE de la tendencia + stop a break-even
//      El objetivo es curar el punto flojo de s2: los cortos entrando contra
//      una tendencia mayor que sigue subiendo, y las ganadoras que se dan la
//      vuelta antes de que el trailing las alcance.
// ═══════════════════════════════════════════════════════════════════════════
function s7_tendenciaPro(d, c, p) {
  const rap = c.ema(p.rapida), len = c.ema(p.lenta), A = c.atr(p.atrLen);
  const tend = c.ema(p.tendLen);
  let picoAlto = -Infinity, picoBajo = Infinity;

  return (i, pos, entrada) => {
    if (i < Math.max(p.lenta, p.tendLen + p.pendLen) + 3) return null;
    if (!isFinite(len[i]) || !isFinite(A[i]) || !isFinite(tend[i]) || !isFinite(tend[i - p.pendLen])) return null;

    if (pos !== 0) {
      if (pos === 1)  picoAlto = Math.max(picoAlto, d.high[i]);
      else            picoBajo = Math.min(picoBajo, d.low[i]);

      let stop = pos === 1 ? picoAlto - p.trailMult * A[i] : picoBajo + p.trailMult * A[i];

      // break-even: si el precio ya avanzo beMult x ATR a favor, el stop no
      // baja de la entrada (mas un colchon para cubrir comisiones)
      if (p.beMult > 0) {
        const avance = pos === 1 ? picoAlto - entrada : entrada - picoBajo;
        if (avance >= p.beMult * A[i]) {
          const be = pos === 1 ? entrada * 1.001 : entrada * 0.999;
          stop = pos === 1 ? Math.max(stop, be) : Math.min(stop, be);
        }
      }
      const cruzaContra = pos === 1 ? rap[i] < len[i] : rap[i] > len[i];
      return { dir: 0, stop, salir: cruzaContra };
    }

    picoAlto = -Infinity; picoBajo = Infinity;
    const cruceArriba = rap[i] > len[i] && rap[i - 1] <= len[i - 1];
    const cruceAbajo  = rap[i] < len[i] && rap[i - 1] >= len[i - 1];
    // pendiente de la tendencia mayor, en tanto por uno
    const pend = (tend[i] - tend[i - p.pendLen]) / tend[i - p.pendLen];

    if (cruceArriba && d.close[i] > tend[i] && pend >= p.pendMin && !p.soloCortos) {
      picoAlto = d.high[i];
      return { dir: 1, stopIni: d.close[i] - p.stopMult * A[i] };
    }
    if (cruceAbajo && d.close[i] < tend[i] && pend <= -p.pendMinCorto && !p.soloLargos) {
      picoBajo = d.low[i];
      return { dir: -1, stopIni: d.close[i] + p.stopMult * A[i] };
    }
    return null;
  };
}

module.exports = {
  crearCache, rollMax, rollMin, supertrend,
  familias: {
    s1_donchian, s2_emaCross, s3_supertrend, s4_reversion, s5_squeeze,
    s6_momentum, s7_tendenciaPro
  }
};
