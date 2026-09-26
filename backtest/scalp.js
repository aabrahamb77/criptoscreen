// Familias de SCALPING para BTC en temporalidades bajas (5m / 15m).
// Todas usan objetivo fijo (take profit) porque en scalping la salida tiene que
// ser mecanica: el trailing largo no funciona cuando el ruido domina.
const E = require('./engine');
const S = require('./strategies');

// ── VWAP de sesion diaria (UTC) con desviacion tipica ───────────────────────
function vwapDiario(d) {
  const n = d.n;
  const vw = new Float64Array(n).fill(NaN), sd = new Float64Array(n).fill(NaN);
  let dia = -1, sumPV = 0, sumV = 0, sumPPV = 0;
  for (let i = 0; i < n; i++) {
    const diaActual = Math.floor(d.ts[i] / 864e5);
    if (diaActual !== dia) { dia = diaActual; sumPV = 0; sumV = 0; sumPPV = 0; }
    const tipico = (d.high[i] + d.low[i] + d.close[i]) / 3;
    const v = d.volume[i] || 1;
    sumPV += tipico * v; sumV += v; sumPPV += tipico * tipico * v;
    const m = sumPV / sumV;
    vw[i] = m;
    const varianza = Math.max(0, sumPPV / sumV - m * m);
    sd[i] = Math.sqrt(varianza);
  }
  return { vwap: vw, sd };
}

function crearCacheScalp(d) {
  const base = S.crearCache(d);
  let vw = null;
  return Object.assign(base, { vwap: () => (vw ||= vwapDiario(d)) });
}

// ═══════════════════════════════════════════════════════════════════════════
// SC1 · Reversion a la media A FAVOR de la tendencia mayor
//   En tendencia alcista, comprar el retroceso profundo; nunca al reves.
// ═══════════════════════════════════════════════════════════════════════════
function sc1_reversion(d, c, p) {
  const tend = c.ema(p.tendLen), base = c.sma(p.bbLen), sd = c.std(p.bbLen);
  const A = c.atr(p.atrLen), r = c.rsi(p.rsiLen);
  return (i, pos) => {
    if (pos !== 0) return null;
    if (i < Math.max(p.tendLen, p.bbLen, p.rsiLen) + 3) return null;
    if (!isFinite(tend[i]) || !isFinite(sd[i]) || !isFinite(A[i]) || !isFinite(r[i])) return null;
    const px = d.close[i];
    const inf = base[i] - p.bbMult * sd[i], sup = base[i] + p.bbMult * sd[i];

    if (!p.soloCortos && px > tend[i] && px < inf && r[i] < p.rsiBajo)
      return { dir: 1, stopIni: px - p.stopMult * A[i], tpIni: px + p.tpMult * A[i] };
    if (!p.soloLargos && px < tend[i] && px > sup && r[i] > p.rsiAlto)
      return { dir: -1, stopIni: px + p.stopMult * A[i], tpIni: px - p.tpMult * A[i] };
    return null;
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// SC2 · Barrido de liquidez: la vela perfora el minimo de N velas y CIERRA
//   por encima. Es una cacería de stops fallida -> reversion.
// ═══════════════════════════════════════════════════════════════════════════
function sc2_barrido(d, c, p) {
  const minL = S.rollMin(d.low, p.lookback), maxH = S.rollMax(d.high, p.lookback);
  const A = c.atr(p.atrLen), tend = c.ema(p.tendLen);
  return (i, pos) => {
    if (pos !== 0) return null;
    if (i < Math.max(p.lookback, p.tendLen) + 3) return null;
    if (!isFinite(A[i]) || !isFinite(tend[i]) || !isFinite(minL[i - 1])) return null;
    const px = d.close[i];
    const conTendencia = !p.exigirTendencia;

    // barrido bajista fallido -> largo
    const barridoAbajo = d.low[i] < minL[i - 1] && px > minL[i - 1];
    if (!p.soloCortos && barridoAbajo && (conTendencia || px > tend[i])) {
      const stop = d.low[i] - p.colchon * A[i];
      const riesgo = px - stop;
      if (riesgo > 0) return { dir: 1, stopIni: stop, tpIni: px + p.rr * riesgo };
    }
    // barrido alcista fallido -> corto
    const barridoArriba = d.high[i] > maxH[i - 1] && px < maxH[i - 1];
    if (!p.soloLargos && barridoArriba && (conTendencia || px < tend[i])) {
      const stop = d.high[i] + p.colchon * A[i];
      const riesgo = stop - px;
      if (riesgo > 0) return { dir: -1, stopIni: stop, tpIni: px - p.rr * riesgo };
    }
    return null;
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// SC3 · Ruptura de rango comprimido (momentum scalp)
// ═══════════════════════════════════════════════════════════════════════════
function sc3_ruptura(d, c, p) {
  const maxH = S.rollMax(d.high, p.rango), minL = S.rollMin(d.low, p.rango);
  const A = c.atr(p.atrLen), tend = c.ema(p.tendLen);
  return (i, pos) => {
    if (pos !== 0) return null;
    if (i < Math.max(p.rango, p.tendLen) + 3) return null;
    if (!isFinite(A[i]) || !isFinite(tend[i]) || !isFinite(maxH[i - 1])) return null;
    const px = d.close[i];
    const amplitud = maxH[i - 1] - minL[i - 1];
    if (amplitud > p.compresion * A[i]) return null;      // el rango no esta comprimido

    if (!p.soloCortos && px > maxH[i - 1] && px > tend[i]) {
      const stop = minL[i - 1];
      const riesgo = px - stop;
      if (riesgo > 0) return { dir: 1, stopIni: stop, tpIni: px + p.rr * riesgo };
    }
    if (!p.soloLargos && px < minL[i - 1] && px < tend[i]) {
      const stop = maxH[i - 1];
      const riesgo = stop - px;
      if (riesgo > 0) return { dir: -1, stopIni: stop, tpIni: px - p.rr * riesgo };
    }
    return null;
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// SC4 · Reversion al VWAP de la sesion
// ═══════════════════════════════════════════════════════════════════════════
function sc4_vwap(d, c, p) {
  const { vwap, sd } = c.vwap();
  const A = c.atr(p.atrLen), tend = c.ema(p.tendLen);
  return (i, pos) => {
    if (pos !== 0) return null;
    if (i < Math.max(p.tendLen, p.atrLen) + 3) return null;
    if (!isFinite(vwap[i]) || !isFinite(sd[i]) || sd[i] <= 0 || !isFinite(A[i]) || !isFinite(tend[i])) return null;
    const px = d.close[i];
    const desv = (px - vwap[i]) / sd[i];

    if (!p.soloCortos && desv <= -p.bandas && (!p.exigirTendencia || px > tend[i]))
      return { dir: 1, stopIni: px - p.stopMult * A[i], tpIni: vwap[i] };
    if (!p.soloLargos && desv >= p.bandas && (!p.exigirTendencia || px < tend[i]))
      return { dir: -1, stopIni: px + p.stopMult * A[i], tpIni: vwap[i] };
    return null;
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// SC5 · Retroceso a la EMA en tendencia (continuacion)
// ═══════════════════════════════════════════════════════════════════════════
function sc5_pullback(d, c, p) {
  const rap = c.ema(p.rapida), len = c.ema(p.lenta), tend = c.ema(p.tendLen), A = c.atr(p.atrLen);
  return (i, pos) => {
    if (pos !== 0) return null;
    if (i < Math.max(p.tendLen, p.lenta) + 3) return null;
    if (!isFinite(tend[i]) || !isFinite(len[i]) || !isFinite(A[i])) return null;
    const px = d.close[i];
    const alcista = px > tend[i] && rap[i] > len[i];
    const bajista = px < tend[i] && rap[i] < len[i];

    // toca la EMA rapida por debajo y cierra por encima -> continuacion alcista
    const tocaAbajo = d.low[i] <= rap[i] && px > rap[i];
    const tocaArriba = d.high[i] >= rap[i] && px < rap[i];

    if (!p.soloCortos && alcista && tocaAbajo) {
      const stop = Math.min(d.low[i], px - p.stopMult * A[i]);
      const riesgo = px - stop;
      if (riesgo > 0) return { dir: 1, stopIni: stop, tpIni: px + p.rr * riesgo };
    }
    if (!p.soloLargos && bajista && tocaArriba) {
      const stop = Math.max(d.high[i], px + p.stopMult * A[i]);
      const riesgo = stop - px;
      if (riesgo > 0) return { dir: -1, stopIni: stop, tpIni: px - p.rr * riesgo };
    }
    return null;
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// SC6 · Reversion por z-score, diseñada a partir de la medicion del mercado:
//   BTC en 15m tiene una continuacion del 47,4% (por debajo del 50% las 24h),
//   es decir es REVERSIVO a todas horas. Esta estrategia explota justo eso.
//   Entra cuando el precio se aleja z desviaciones de su media y sale cuando
//   vuelve hacia ella. Sin objetivo fijo: la salida es la propia reversion.
// ═══════════════════════════════════════════════════════════════════════════
function sc6_zscore(d, c, p) {
  const base = c.sma(p.len), sd = c.std(p.len), A = c.atr(p.atrLen);
  const tend = p.tendLen ? c.ema(p.tendLen) : null;
  let barras = 0;

  return (i, pos) => {
    if (i < Math.max(p.len, p.tendLen || 0, p.atrLen) + 3) return null;
    if (!isFinite(base[i]) || !isFinite(sd[i]) || sd[i] <= 0 || !isFinite(A[i])) return null;
    const z = (d.close[i] - base[i]) / sd[i];

    if (pos !== 0) {
      barras++;
      // salida: el precio ha vuelto hacia la media, o se agoto el tiempo
      const vuelto = pos === 1 ? z >= -p.salida : z <= p.salida;
      if (vuelto || (p.maxBarras && barras >= p.maxBarras)) return { dir: 0, salir: true };
      return null;
    }

    barras = 0;
    const filtroLargo = !tend || d.close[i] > tend[i];
    const filtroCorto = !tend || d.close[i] < tend[i];

    if (!p.soloCortos && z <= -p.entrada && filtroLargo)
      return { dir: 1, stopIni: d.close[i] - p.stopMult * A[i] };
    if (!p.soloLargos && z >= p.entrada && filtroCorto)
      return { dir: -1, stopIni: d.close[i] + p.stopMult * A[i] };
    return null;
  };
}

const familias = { sc1_reversion, sc2_barrido, sc3_ruptura, sc4_vwap, sc5_pullback, sc6_zscore };

const REJILLAS = {
  sc1_reversion: {
    tendLen: [100, 200, 400], bbLen: [20, 30, 50], bbMult: [2, 2.5, 3],
    rsiLen: [14], rsiBajo: [25, 30], rsiAlto: [70, 75],
    atrLen: [14], stopMult: [1, 1.5, 2], tpMult: [1, 1.5, 2, 3]
  },
  sc2_barrido: {
    lookback: [10, 20, 30, 50], tendLen: [100, 200, 400],
    atrLen: [14], colchon: [0.1, 0.25, 0.5], rr: [1, 1.5, 2, 3],
    exigirTendencia: [true, false]
  },
  sc3_ruptura: {
    rango: [10, 20, 30], tendLen: [100, 200, 400], atrLen: [14],
    compresion: [1.5, 2, 3], rr: [1, 1.5, 2, 3]
  },
  sc4_vwap: {
    bandas: [1.5, 2, 2.5, 3], tendLen: [100, 200, 400], atrLen: [14],
    stopMult: [1, 1.5, 2, 3], exigirTendencia: [true, false]
  },
  sc5_pullback: {
    rapida: [9, 20], lenta: [21, 50], tendLen: [100, 200, 400], atrLen: [14],
    stopMult: [0.5, 1, 1.5], rr: [1, 1.5, 2, 3]
  },
  sc6_zscore: {
    len: [20, 40, 60, 100], entrada: [1.5, 2, 2.5, 3], salida: [0, 0.5, 1],
    atrLen: [14], stopMult: [2, 3, 4, 6], maxBarras: [0, 20, 50],
    tendLen: [0, 200, 400]
  }
};

module.exports = { familias, REJILLAS, crearCacheScalp, vwapDiario };
