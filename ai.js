// Capa de IA narrativa (opcional): interpreta en español el contexto YA
// CALCULADO en el frontend (heat score, confluencia, régimen, alineación,
// playbook, etc.) — el modelo no recibe datos crudos del mercado y no debe
// inventar cifras, solo explicar lo que ya tenemos.
const apiKey = process.env.ANTHROPIC_API_KEY;

if (!apiKey) {
  console.log('IA no configurada (falta ANTHROPIC_API_KEY) — "Explicar con IA" desactivado.');
}

function enabled() {
  return !!apiKey;
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

async function explain(ctx) {
  if (!apiKey) return null;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 350,
      messages: [{ role: 'user', content: buildPrompt(ctx) }],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Anthropic API ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.content?.[0]?.text ?? null;
}

module.exports = { enabled, explain };
