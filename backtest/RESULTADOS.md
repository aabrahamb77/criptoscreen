# Estrategia BTC 4H — tendencia con cruce EMA y trailing ATR

Resultado de la búsqueda: **6 familias de estrategias, ~4.700 combinaciones probadas**
sobre 14.135 velas de 4h de Bybit (2020-03-25 → 2026-09-06, 6,4 años).

## La estrategia

| | |
|---|---|
| Activo | `BYBIT:BTCUSDT.P` |
| Temporalidad | **4 horas** |
| Lados | Largo y corto |
| Señal larga | EMA 12 cruza **arriba** de EMA 90, **y** cierre > EMA 250 |
| Señal corta | EMA 12 cruza **abajo** de EMA 90, **y** cierre < EMA 250 |
| Stop inicial | 1,5 × ATR(14) desde el cierre de la vela de señal |
| Trailing | máximo alcanzado − 4 × ATR(14) (solo avanza, nunca retrocede) |
| Salida extra | cruce de EMAs en contra |
| Entrada | apertura de la vela siguiente a la señal |
| Tamaño | 100% del equity, sin apalancamiento |

Fichero Pine: [`pine/btc-tendencia-4h.pine`](../pine/btc-tendencia-4h.pine)

## Resultados (2020-03 → 2026-09, comisión 0,055%/lado + 0,02% deslizamiento)

```
Retorno        +330,3%       10.000 -> 43.034
CAGR            +25,4%
Profit Factor     1,90
Max Drawdown     16,2%
Sharpe            0,89
Operaciones        126       (19,5 al año, ~1 cada 19 días)
Aciertos          38,9%
Ratio gan/per     2,99       media +1.421 / media -475
Racha perdedora      6
LARGOS   61 ops   PF 2,43    aciertos 37,7%
CORTOS   65 ops   PF 1,47    aciertos 40,0%
```

### Año a año — 7 de 7 en positivo

| Año | Retorno | Ops | Aciertos |
|---|---|---|---|
| 2020 | +27,0% | 17 | 29% |
| 2021 | +41,4% | 20 | 45% |
| 2022 | +25,8% | 22 | 41% |
| 2023 | +8,8% | 18 | 33% |
| 2024 | +48,1% | 16 | 38% |
| 2025 | +12,1% | 21 | 52% |
| 2026 | +5,5% | 12 | 25% |

2022 fue un mercado bajista brutal y la estrategia ganó un 25,8%: ese es el
argumento a favor de operar los dos lados.

## Por qué creo que el edge es real y no sobreajuste

1. **Fuera de muestra mejora.** Calibrado hasta 2023 (PF 1,73), de 2024 en
   adelante da PF 2,12. Un sobreajuste se degrada; esto no.
2. **Meseta amplia, no un pico.** De 900 combinaciones vecinas, **574 son
   rentables**. No depende de parámetros mágicos.
3. **Aguanta costes ×4.** Con comisiones cuádruples sigue en PF 1,43. El edge
   no vive de la fricción baja.
4. **Walk-forward 7 de 8 ventanas positivas**, sin reoptimizar. La mala es −2,0%.
5. **La familia funciona en otros activos.** Con su propia calibración:
   445/900 combinaciones rentables en ETH, 327/900 en SOL. El principio es
   general; solo cambia el ajuste fino.

## Lo que hay que aceptar

- **El drawdown real esperable es mayor que el histórico.** Monte Carlo con
  5.000 historias alternativas (remuestreo con reemplazo): DD mediano 24,2%,
  **percentil 95 → 40,9%**. El 16,2% del backtest fue suerte de secuencia.
  Retorno mediano +325%, percentil 5 +40,7%, probabilidad de acabar en
  pérdidas 1,5%.
- **Se acierta el 39% de las veces.** Habrá rachas de 6 pérdidas seguidas.
  Quien no las aguante, romperá la estrategia justo antes de la ganadora.
- **Solo 19,5 operaciones al año.** Es aburrida a propósito; en 1H y 30m la
  misma lógica pierde dinero porque la comisión se come el edge (596 y 1.239
  operaciones).
- **Los mismos parámetros no valen para ETH ni SOL.** Hay que recalibrar.

## Perfil de operación

```
peor operación     -6,62%      duración mediana    3,2 días
percentil 5        -4,00%      percentil 95       12,0 días
mediana            -1,23%      más larga          19,8 días
percentil 95      +14,95%
mejor             +36,10%      salidas: 121 por stop, 5 por señal
pérdida media      -2,09%
```

Las últimas 5 operaciones resumen el carácter de la estrategia:
`-1,60%  -1,45%  -0,65%  -1,25%  +19,92%`

## Lo que se probó y se descartó

| Familia | Veredicto en 4H |
|---|---|
| Cruce EMA + tendencia + trailing ATR | **elegida** — PF 1,90, 7/7 años |
| Compresión de volatilidad (squeeze) | PF 1,81 pero 2022 negativo y cortos PF 0,74 |
| Ruptura Donchian | PF 1,51, DD 21%, 2025 en negativo |
| Momento con pendiente + ADX | PF 1,36, cortos perdedores (PF 0,90) |
| Supertrend | PF 1,21, OOS se derrumba a 1,02 |
| Reversión a la media (Bollinger+RSI) | rentable pero irrelevante: +3,7% anual |

Refinamientos probados sobre la ganadora y **descartados**:

- **Filtro de pendiente de la tendencia**: sube el PF a 2,04 y baja el DD a
  12,2%, pero hunde el retorno a +67% y la consistencia a 3/7 años. Filtra
  demasiado.
- **Stop a break-even**: destruye el resultado (PF 1,17 con BE a 1×ATR). En
  seguimiento de tendencia saca de las operaciones que necesitan respirar,
  y son las pocas ganadoras grandes las que pagan todo lo demás.

## Cómo reproducirlo

```bash
node backtest/fetch-bybit.js BTCUSDT 240 2019-01-01   # descargar velas
node backtest/run.js s2_emaCross 240 10               # barrido de parámetros
node backtest/validar.js                              # batería de estrés
```

- `engine.js` — indicadores y motor bar-a-bar. Señal al cierre, ejecución en la
  apertura siguiente, stop intrabar con el peor caso asumido.
- `strategies.js` — las 7 familias.
- `run.js` — barrido, partición dentro/fuera de muestra, puntuación.
- `validar.js` — año a año, estrés de costes, walk-forward, Monte Carlo.
