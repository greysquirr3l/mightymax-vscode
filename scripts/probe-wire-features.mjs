// Probe three open questions about MiniMax's platform API with a BYOK key.
//
//   MINIMAX_API_KEY=... node scripts/probe-wire-features.mjs [baseUrl]
//
//   A. /v1/models — does the response carry pricing (or any fields beyond
//      `id`) that a catalog could use?                             (§2.9)
//   B. cache_control — is `{ type: 'ephemeral', ttl: '1h' }` accepted on the
//      Anthropic route, or rejected?                                (§4.5)
//   C. reasoning summary — does a request with thinking enabled return a
//      `summary` on the thinking block, with and without the
//      `reasoningSummary` option?                                   (§2.5)
//
// Each probe makes one small request (max_tokens 256 or less). The key is
// read from the environment and never printed. Output is trimmed.

const apiKey = process.env.MINIMAX_API_KEY;
if (!apiKey) {
  console.error('Set MINIMAX_API_KEY first.');
  process.exit(1);
}
const baseUrl = (process.argv[2] ?? 'https://api.minimax.io').replace(/\/+$/, '');
const auth = { Authorization: `Bearer ${apiKey}` };

async function post(path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    // leave undefined
  }
  return { status: res.status, text, json };
}

function section(title) {
  console.log(`\n=== ${title} ===`);
}

// A ---------------------------------------------------------------------
section('A. /v1/models fields');
{
  const res = await fetch(`${baseUrl}/v1/models`, { headers: auth });
  const text = await res.text();
  console.log(`HTTP ${res.status}`);
  try {
    const json = JSON.parse(text);
    const list = Array.isArray(json) ? json : (json.data ?? json.models ?? []);
    console.log(`${list.length} entries; top-level keys: ${Object.keys(json).join(', ')}`);
    const keys = new Set(list.flatMap((m) => Object.keys(m)));
    console.log(`per-model keys seen: ${[...keys].join(', ')}`);
    console.log('first entry:', JSON.stringify(list[0], null, 2));
    const priced = [...keys].filter((k) => /pric|cost|rate/i.test(k));
    console.log(priced.length ? `pricing-like keys: ${priced.join(', ')}` : 'no pricing-like keys');
  } catch {
    console.log(text.slice(0, 400));
  }
}

const userMsg = [{ role: 'user', content: [{ type: 'text', text: 'Reply with the word: ok' }] }];

// B ---------------------------------------------------------------------
section('B. cache_control ttl');
for (const ttl of [undefined, '5m', '1h']) {
  const r = await post('/anthropic/v1/messages', {
    model: 'MiniMax-M3',
    max_tokens: 64,
    system: [
      {
        type: 'text',
        text: 'You are terse.',
        cache_control: { type: 'ephemeral', ...(ttl ? { ttl } : {}) },
      },
    ],
    messages: userMsg,
  });
  console.log(`ttl=${ttl ?? '(none)'} -> HTTP ${r.status}${r.status === 200 ? ' accepted' : ': ' + r.text.slice(0, 200)}`);
}

// C ---------------------------------------------------------------------
section('C. reasoning summary');
const variants = [
  ['thinking adaptive', { thinking: { type: 'adaptive' } }],
  [
    'thinking adaptive + reasoningSummary:auto (top level)',
    { thinking: { type: 'adaptive' }, reasoningSummary: 'auto' },
  ],
  [
    'thinking adaptive + thinking.summary:auto',
    { thinking: { type: 'adaptive', summary: 'auto' } },
  ],
];
for (const [label, extra] of variants) {
  const r = await post('/anthropic/v1/messages', {
    model: 'MiniMax-M3',
    max_tokens: 256,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'What is 17 * 23? Think it through.' }] },
    ],
    ...extra,
  });
  if (r.status !== 200) {
    console.log(`${label} -> HTTP ${r.status}: ${r.text.slice(0, 200)}`);
    continue;
  }
  const blocks = r.json?.content ?? [];
  const thinking = blocks.filter((b) => b.type === 'thinking');
  console.log(
    `${label} -> HTTP 200; blocks: ${blocks.map((b) => b.type).join(', ')}; ` +
      `thinking block keys: ${thinking.map((b) => Object.keys(b).join('/')).join(' | ') || '(none)'}`,
  );
  const withSummary = thinking.find((b) => 'summary' in b);
  if (withSummary) console.log('  summary:', JSON.stringify(withSummary.summary).slice(0, 200));
}
console.log('\nDone. Paste the output back; nothing above contains the key.');
