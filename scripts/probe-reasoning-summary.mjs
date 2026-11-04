// Follow-up probe for §2.5 (reasoning summary).
//
//   MINIMAX_API_KEY=... node scripts/probe-reasoning-summary.mjs [baseUrl]
//
// The first probe used a trivial prompt, so adaptive thinking skipped
// reasoning entirely and there was no thinking block to inspect. This one
// asks a multi-step question and tries several ways of requesting thinking
// (adaptive, enabled with a budget) with and without summary options, then
// reports which block keys come back — in particular whether any `summary`
// field appears. Non-streaming; max_tokens 2048 each; 5 requests.
// The key is read from the environment and never printed.

const apiKey = process.env.MINIMAX_API_KEY;
if (!apiKey) {
  console.error('Set MINIMAX_API_KEY first.');
  process.exit(1);
}
const baseUrl = (process.argv[2] ?? 'https://api.minimax.io').replace(/\/+$/, '');

const PROMPT =
  'Three people (A, B, C) each own a different pet (cat, dog, fish). A does not own the dog. ' +
  'The fish owner is not B. C does not own the cat. Work out who owns which pet, ' +
  'checking each constraint step by step before answering.';

const variants = [
  ['model: M3, thinking adaptive', 'MiniMax-M3', { thinking: { type: 'adaptive' } }],
  [
    'model: M3, thinking enabled (budget 1024)',
    'MiniMax-M3',
    { thinking: { type: 'enabled', budget_tokens: 1024 } },
  ],
  [
    'model: M3, adaptive + thinking.summary:auto',
    'MiniMax-M3',
    { thinking: { type: 'adaptive', summary: 'auto' } },
  ],
  [
    'model: M3, adaptive + reasoningSummary:auto (top level)',
    'MiniMax-M3',
    { thinking: { type: 'adaptive' }, reasoningSummary: 'auto' },
  ],
  [
    'model: M3.1-Flash, adaptive (always thinks)',
    'MiniMax-M3.1-Flash',
    { thinking: { type: 'adaptive' } },
  ],
];

for (const [label, model, extra] of variants) {
  const res = await fetch(`${baseUrl}/anthropic/v1/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 2048,
      messages: [{ role: 'user', content: [{ type: 'text', text: PROMPT }] }],
      ...extra,
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    console.log(`${label} -> HTTP ${res.status}: ${text.slice(0, 200)}`);
    continue;
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    console.log(`${label} -> HTTP 200 but not JSON: ${text.slice(0, 120)}`);
    continue;
  }
  const blocks = json.content ?? [];
  const thinking = blocks.filter((b) => b.type === 'thinking');
  console.log(`${label}`);
  console.log(`  blocks: ${blocks.map((b) => b.type).join(', ')}`);
  for (const b of thinking) {
    console.log(`  thinking block keys: ${Object.keys(b).join(', ')}; chars: ${String(b.thinking ?? '').length}`);
    if ('summary' in b) console.log('  summary:', JSON.stringify(b.summary).slice(0, 300));
  }
  const unknown = Object.keys(json).filter(
    (k) => !['id', 'type', 'role', 'model', 'content', 'usage', 'stop_reason', 'stop_sequence', 'base_resp'].includes(k),
  );
  if (unknown.length) console.log(`  extra top-level keys: ${unknown.join(', ')}`);
}
console.log('\nDone. Nothing above contains the key.');
