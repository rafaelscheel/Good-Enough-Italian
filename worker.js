/**
 * Cloudflare Worker — DeepL translation proxy + KV list storage
 *
 * Required secrets (set via `wrangler secret put` or the Cloudflare dashboard):
 *   DEEPL_API_KEY   — your DeepL API key (free keys end in :fx)
 *   AUTH_PASSWORD   — a password you choose; the app sends it with every request
 *
 * Required KV namespace (add to wrangler.toml after running
 * `wrangler kv namespace create LISTS_KV`):
 *   LISTS_KV
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {
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

    // Shared password check
    if (!env.AUTH_PASSWORD || body.password !== env.AUTH_PASSWORD) {
      return json({ error: 'Invalid password' }, 401);
    }

    // Treat missing action as "translate" for backward compatibility
    const action = body.action ?? 'translate';

    if (action === 'translate') return handleTranslate(body, env);
    if (action === 'load')      return handleLoad(env);
    if (action === 'save')      return handleSave(body, env);

    return json({ error: `Unknown action: ${action}` }, 400);
  },
};

async function handleTranslate(body, env) {
  const { text } = body;

  if (!text || typeof text !== 'string') {
    return json({ error: 'Missing or invalid "text" field' }, 400);
  }

  if (!env.DEEPL_API_KEY) {
    return json({ error: 'Server misconfiguration: DEEPL_API_KEY not set' }, 500);
  }

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
}

async function handleLoad(env) {
  if (!env.LISTS_KV) {
    return json({ error: 'Server misconfiguration: LISTS_KV not bound' }, 500);
  }
  const raw = await env.LISTS_KV.get('lists');
  return json({ lists: raw ? JSON.parse(raw) : {} });
}

async function handleSave(body, env) {
  if (!env.LISTS_KV) {
    return json({ error: 'Server misconfiguration: LISTS_KV not bound' }, 500);
  }
  if (!body.lists || typeof body.lists !== 'object') {
    return json({ error: 'Missing or invalid "lists" field' }, 400);
  }
  await env.LISTS_KV.put('lists', JSON.stringify(body.lists));
  return json({ ok: true });
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}
