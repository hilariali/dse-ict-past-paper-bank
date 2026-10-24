const DEFAULT_TIMEOUT_MS = 30000;

function getConfig() {
  const baseUrl = (process.env.AI_BASE_URL || '').trim().replace(/\/+$/, '');
  const model = (process.env.AI_MODEL || '').trim();
  const apiKey = (process.env.AI_API_KEY || '').trim();
  return { baseUrl, model, apiKey };
}

function json(res, status, body) {
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8');
  res.send(JSON.stringify(body));
}

async function forwardToProvider({ baseUrl, model, apiKey, messages, temperature }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const payload = {
      messages,
      temperature: typeof temperature === 'number' ? temperature : 0.3,
    };
    if (model) payload.model = model;

    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) {
      const upstreamText = await response.text().catch(() => '');
      const upstreamSummary = upstreamText.slice(0, 240) || `HTTP ${response.status}`;
      throw new Error(`Upstream error: ${upstreamSummary}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

module.exports = async function handler(req, res) {
  const { baseUrl, model, apiKey } = getConfig();
  const configured = !!baseUrl;

  if (req.method === 'GET') {
    if (!configured) return json(res, 503, { ok: false, error: 'AI endpoint is not configured' });
    return json(res, 200, { ok: true, configured: true, model: model || null, hasApiKey: !!apiKey });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return json(res, 405, { ok: false, error: 'Method not allowed' });
  }

  if (!configured) return json(res, 503, { ok: false, error: 'AI endpoint is not configured' });

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const messages = Array.isArray(body.messages) ? body.messages : null;
  if (!messages || !messages.length) return json(res, 400, { ok: false, error: 'messages is required' });

  try {
    const upstream = await forwardToProvider({
      baseUrl,
      model,
      apiKey,
      messages,
      temperature: body.temperature,
    });
    const content = upstream && upstream.choices && upstream.choices[0] && upstream.choices[0].message && upstream.choices[0].message.content;
    if (typeof content !== 'string' || !content.trim()) {
      return json(res, 502, { ok: false, error: 'Provider returned empty content' });
    }
    return json(res, 200, { ok: true, content });
  } catch (error) {
    return json(res, 502, { ok: false, error: error && error.message ? error.message : 'AI request failed' });
  }
};
