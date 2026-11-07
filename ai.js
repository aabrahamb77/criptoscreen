// Capa de IA (opcional, requiere ANTHROPIC_API_KEY):
//  · explain(): interpreta en español el contexto YA CALCULADO en el frontend
//    (heat score, confluencia, régimen, alineación, playbook…) — el modelo no
//    recibe datos crudos del mercado y no debe inventar cifras.
//  · readLiquidityShot(): lee una captura del Liquidation Heatmap / Liquidation
//    Map de CoinGlass y devuelve sus niveles de liquidez en JSON (panel ₿ BTC).
const { default: Anthropic } = require('@anthropic-ai/sdk');

const apiKey = process.env.ANTHROPIC_API_KEY;
const client = apiKey ? new Anthropic({ apiKey }) : null;

if (!apiKey) {
  console.log('IA no configurada (falta ANTHROPIC_API_KEY) — "Explicar con IA" y lectura de capturas de CoinGlass desactivados.');
}

function enabled() {
  return !!client;
}

function buildPrompt(ctx) {
  const line = (label, val, suffix = '') => `${label}: ${val == null ? 'N/D' : val + suffix}`;
  return [
    'Eres un analista cuantitativo de cripto ayudando a un trader a interpretar datos YA CALCULADOS por su screener.',
    'No inventes cifras nuevas, no des consejos de inversión — solo interpreta lo que se te da, en español, en máximo 4 frases, mencionando también el riesgo o la incertidumbre relevante.',
    '',
    `Símbolo: ${ctx.symbol ?? 'N/D'}`,
    line('Heat score (0-10, qué tan "on fire" está)', ctx.heat),
    line('Lado dominante', ctx.side === 'l' ? 'LONG' : ctx.side === 's' ? 'SHORT' : null),
    line('Confluencia entre 4 estrategias', ctx.confluence, '/4'),
    line('Régimen de mercado', ctx.marketRegime),
    line('Régimen propio de la moneda', ctx.symbolRegime),
    line('Alineación multi-temporalidad (5m/1h/4h/24h)', ctx.alignment),
    line('Funding rate', ctx.fundingRate, '%'),
    line('OI 1h', ctx.oi1h, '%'),
    line('Acierto histórico a 1h', ctx.winRate1h, '%'),
    line('Movimiento promedio histórico a 1h', ctx.avgMove1h, '%'),
    line('Mejor día de la semana históricamente', ctx.bestDay),
    line('Peor día de la semana históricamente', ctx.worstDay),
  ].join('\n');
}

const textOf = msg => (msg.content || []).filter(b => b.type === 'text').map(b => b.text).join('');

async function explain(ctx) {
  if (!client) return null;
  const msg = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 350,
    messages: [{ role: 'user', content: buildPrompt(ctx) }],
  });
  return textOf(msg) || null;
}

// ── Captura de CoinGlass → niveles de liquidez ──────────────────────────────
const SHOT_SCHEMA = {
  type: 'object',
  properties: {
    is_liquidity_chart: { type: 'boolean' },
    chart_type: { type: 'string' },
    symbol: { type: 'string' },
    current_price: { type: 'number' },
    levels: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          price: { type: 'number' },
          intensity: { type: 'number' },
          side: { type: 'string', enum: ['above', 'below'] },
        },
        required: ['price', 'intensity', 'side'],
        additionalProperties: false,
      },
    },
    notes: { type: 'string' },
  },
  required: ['is_liquidity_chart', 'chart_type', 'symbol', 'current_price', 'levels', 'notes'],
  additionalProperties: false,
};

function shotPrompt(priceHint) {
  return [
    'This is a screenshot a crypto trader took from CoinGlass. It should be either a "Liquidation Heatmap"',
    '(time on the x axis, price on the right axis, pending liquidations drawn as horizontal bands: dark purple = little,',
    'teal/green = medium, bright yellow = a lot) or a "Liquidation Map" (bars of cumulative long/short liquidation',
    'leverage by price).',
    '',
    'Read it like this:',
    '1. Read the price-axis labels and convert vertical positions into prices by interpolating between the nearest labels.',
    '2. Find the 3 to 10 price levels holding the most liquidation liquidity that is still pending. On a heatmap that means',
    '   the brightest bands at the RIGHT edge (the most recent column) — bands that stop before the right edge were already',
    '   taken. On a map, the tallest bars or clusters. Merge bands closer than about 0.15% into one level.',
    '3. intensity: 0 to 1, relative to the brightest level in the image. side: "above" or "below" the current price.',
    '4. current_price: the latest price the chart shows (0 if not visible). symbol: the asset shown ("" if unknown).',
    '   chart_type: short name of the chart you see, e.g. "Liquidation Heatmap 24h".',
    'If the image is not a liquidation heatmap or liquidation map, set is_liquidity_chart to false and levels to [].',
    '',
    priceHint ? `For reference only: BTC trades near $${Math.round(priceHint)} right now; the screenshot may be a few minutes older.` : '',
    'Write "notes" in Spanish, at most two short sentences: where the main clusters are and how confident you are in the',
    'reading (for example if the axis labels are hard to read). No trading advice.',
  ].join('\n');
}

async function readLiquidityShot(imageB64, mediaType, priceHint) {
  if (!client) throw new Error('IA no configurada');
  let msg;
  try {
    msg = await client.beta.messages.create({
      model: 'claude-opus-5-5',
      max_tokens: 16000,
      // Si el modelo rechazara la petición, la API la reintenta con otro modelo
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: SHOT_SCHEMA } },
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageB64 } },
          { type: 'text', text: shotPrompt(priceHint) },
        ],
      }],
    });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw new Error('la ANTHROPIC_API_KEY del servidor no es válida');
    if (err instanceof Anthropic.RateLimitError) throw new Error('límite de uso de Claude alcanzado, prueba en un minuto');
    if (err instanceof Anthropic.BadRequestError) throw new Error('Claude rechazó la imagen: ' + String(err.message).slice(0, 160));
    if (err instanceof Anthropic.APIError) throw new Error(`error de la API de Claude (${err.status ?? 'red'})`);
    throw err;
  }
  if (msg.stop_reason === 'refusal') throw new Error('Claude no procesó la imagen');
  if (msg.stop_reason === 'max_tokens') throw new Error('respuesta incompleta de Claude');
  try {
    return JSON.parse(textOf(msg));
  } catch (_) {
    throw new Error('respuesta de Claude ilegible');
  }
}

module.exports = { enabled, explain, readLiquidityShot };
