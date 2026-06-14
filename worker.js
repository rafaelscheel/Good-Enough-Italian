/**
 * Cloudflare Worker — DeepL translation proxy for Good Enough Italian
 *
 * Required secrets (set via `wrangler secret put` or the Cloudflare dashboard):
 *   DEEPL_API_KEY   — your DeepL API key (free keys end in :fx)
 *   AUTH_PASSWORD   — a password you choose; the app sends it with every request
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method !== 'POST') {
      return json({ error: 'Method not allowed' }, 405);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }

    const { text, password } = body;

    if (!text || typeof text !== 'string') {
      return json({ error: 'Missing or invalid "text" field' }, 400);
    }

    // Password check
    if (!env.AUTH_PASSWORD || password !== env.AUTH_PASSWORD) {
      return json({ error: 'Invalid password' }, 401);
    }

    if (!env.DEEPL_API_KEY) {
      return json({ error: 'Server misconfiguration: DEEPL_API_KEY not set' }, 500);
    }

    // Forward to DeepL
    const isFree = env.DEEPL_API_KEY.endsWith(':fx');
    const endpoint = isFree
      ? 'https://api-free.deepl.com/v2/translate'
      : 'https://api.deepl.com/v2/translate';

    let deeplRes;
    try {
      deeplRes = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Authorization': `DeepL-Auth-Key ${env.DEEPL_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text: [text], source_lang: 'EN', target_lang: 'IT' }),
      });
    } catch (err) {
      return json({ error: 'Failed to reach DeepL: ' + err.message }, 502);
    }

    if (!deeplRes.ok) {
      const status = deeplRes.status;
      const messages = {
        403: 'DeepL rejected the API key (403).',
        456: 'DeepL quota exceeded (456).',
        429: 'DeepL rate limit hit (429) — please wait a moment.',
      };
      return json({ error: messages[status] ?? `DeepL error ${status}` }, status);
    }

    const data = await deeplRes.json();
    const translatedText = data.translations?.[0]?.text;

    if (!translatedText) {
      return json({ error: 'Unexpected DeepL response format' }, 502);
    }

    return json({ translatedText });
  },
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}
