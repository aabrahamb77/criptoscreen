# Scalping en BTC — qué funciona y qué no

Estudio sobre **492.286 velas de 5m** (2022-01 → 2026-09) y **226.165 velas de
15m** (2020-03 → 2026-09) de Bybit. Seis familias, ~7.000 combinaciones.

## El hallazgo que ordena todo lo demás

Antes de probar estrategias, medí el mercado. Para cada hora UTC calculé la
**continuación**: la probabilidad de que una vela siga la dirección de la
anterior.

```
continuación global: 47,37%
por debajo del 50% en las 24 horas del día, sin una sola excepción
```

**BTC en temporalidad baja es reversivo a todas horas.** No hay ninguna franja
horaria con momentum. De ahí se sigue, y los backtests lo confirman, que:

- las estrategias de **ruptura y de momentum en 5-15m están condenadas**
  (`sc3_ruptura` PF 0,85 · `sc5_pullback` PF 0,89 con 3.761 operaciones y −98%);
- la única dirección con edge es la **reversión a la media**.

## Lo segundo que decide: la comisión

Barrido idéntico de la estrategia de reversión en 15m, cambiando solo el coste:

| Coste | Comisión | Combinaciones aptas |
|---|---|---|
| Taker (orden a mercado) | 0,055%/lado | **0 de 1.728** |
| Maker (orden límite) | 0,020%/lado | **44 de 1.728** |

En scalping la comisión no es un detalle de ajuste: es la variable que decide si
hay estrategia o no. `sc5_pullback` pasa de PF 0,89 a 0,99 solo con bajar la
comisión — la señal tiene un edge bruto que la fricción se come exactamente.

## La estrategia que sí supera las pruebas

**BTC 5m · reversión por z-score a favor de la tendencia.**
Fichero: [`pine/btc-scalp-5m-zscore.pine`](../pine/btc-scalp-5m-zscore.pine)

| | |
|---|---|
| Entrada larga | z ≤ −2,5 **y** cierre > EMA 200 |
| Entrada corta | z ≥ +2,5 **y** cierre < EMA 200 |
| z | (cierre − SMA 100) / desviación típica 100 |
| Salida | el precio vuelve a la media (z cruza 0) |
| Stop | 3 × ATR(14) |

### Resultados con orden límite (maker 0,02% + 0,005% deslizamiento)

```
Retorno        +21,1%   (sin apalancar)
CAGR            +4,2%
Profit Factor    1,75
Max Drawdown     3,0%
Operaciones       114   (24 al año)
Aciertos        62,3%
Largos PF 1,81  ·  Cortos PF 1,66
Fuera de muestra MEJOR que dentro: 1,70 -> 1,89
Walk-forward: 5 de 5 ventanas positivas
Monte Carlo: p5 +7,5%, probabilidad de pérdida 0,4%
```

Año a año: 2022 +8,4% · 2023 +5,9% · **2024 −0,6%** · 2025 +5,3% · 2026 +0,7%

### Con apalancamiento

El drawdown del 3% deja margen real. Sobre el mismo backtest:

| Apalancamiento | CAGR | Max DD | DD esperable (MC p95) | Peor operación |
|---|---|---|---|---|
| x1 | +4,2% | 3,0% | 6,5% | −1,34% |
| x3 | +12,6% | 9,0% | 18,6% | −4,02% |
| **x4** | **+16,9%** | **12,0%** | **23,9%** | **−5,36%** |
| x5 | +21,2% | 14,9% | 29,8% | −6,70% |
| x8 | +34,2% | 23,4% | 43,6% | −10,71% |

x4 es el punto razonable: CAGR 16,9% con un DD esperable del 24%.

### Con orden a mercado (taker) se degrada pero no muere

PF 1,26 · CAGR 1,7% · walk-forward 4/5 · Monte Carlo p5 −4,7% y 15,4% de
probabilidad de acabar en pérdidas. **No la recomiendo así.**

## Por qué el supuesto maker es defendible aquí

La estrategia compra una caída a −2,5σ. Poner una orden límite en ese nivel y
esperar a que el precio llegue es exactamente la forma natural de ejecutarla, no
un truco de backtest. En una estrategia de ruptura el límite nunca se llenaría;
aquí sí. Aun así es un supuesto: **si la orden no entra, la operación no existe**,
y el backtest asume que entra siempre.

## Lo que descarté por el camino

| Familia | Veredicto |
|---|---|
| Reversión z-score 5m | **elegida** — PF 1,75, WF 5/5 |
| Reversión z-score 15m | PF 1,22 pero **walk-forward 3/8**. Frágil, descartada |
| Reversión z-score 30m | 1 apta de 432, PF 1,08 |
| Reversión Bollinger+RSI 15m | +9% en 6 años. Irrelevante |
| Barrido de liquidez | PF 0,66 taker / 0,91 maker. Nunca rentable |
| Ruptura de rango comprimido | PF 0,85. Apuesta contra la reversión del activo |
| Reversión a VWAP | PF 0,65, −82% con 1.294 operaciones |
| Retroceso a EMA (momentum) | PF 0,89, −98% con 3.761 operaciones |

### El caso del 15m, para no repetirlo

Su ficha parecía buena: PF 1,22, 7/7 años positivos. Pero el **walk-forward daba
5 de 8 ventanas negativas**: todo el resultado venía de 2021. Es el ejemplo de
por qué el "año a año" puede engañar y el walk-forward no.

## Comparación honesta con la estrategia de 4H

| | 4H tendencia | 5m scalp (x4) |
|---|---|---|
| CAGR | **25,4%** | 16,9% |
| Profit Factor | **1,90** | 1,75 |
| Max DD | 16,2% | **12,0%** |
| DD esperable (MC p95) | 40,9% | **23,9%** |
| Walk-forward | 7/8 | **5/5** |
| Aguanta comisión taker | **sí, hasta ×4** | no, necesita maker |
| Histórico | 6,4 años | 4,7 años |
| Meseta de parámetros | **574/900** | 15/720 |

La de 4H gana en rentabilidad y en robustez de parámetros; la de 5m gana en
control del riesgo. **La de 4H sigue siendo la más sólida de las dos**, y su
mayor virtud es que no depende de conseguir ejecución maker.

## Reproducir

```bash
node backtest/fetch-bybit.js BTCUSDT 5 2022-01-01
node backtest/run-scalp.js sc6_zscore 5 4 maker
node backtest/run-scalp.js sc6_zscore 5 4 taker
```
