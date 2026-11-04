// Probe: does a BYOK platform key work with MiniMax's Files API?
//
//   MINIMAX_API_KEY=... node scripts/probe-files-api.mjs [baseUrl]
//
// Step 1 uploads a 1x1 PNG to {baseUrl}/v1/files/upload (multipart,
// purpose=image_understanding — the shape MiniMax Code.app uses).
// Step 2, if step 1 returns a file_id, sends a tiny Messages request to
// {baseUrl}/anthropic/v1/messages referencing it as
// source: { type: 'url', url: 'mm_file://<id>' }.
// The key is read from the environment and never printed.

const apiKey = process.env.MINIMAX_API_KEY;
if (!apiKey) {
  console.error('Set MINIMAX_API_KEY first.');
  process.exit(1);
}
const baseUrl = (process.argv[2] ?? 'https://api.minimax.io').replace(/\/+$/, '');

const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function show(label, res) {
  const text = await res.text();
  console.log(`${label}: HTTP ${res.status}`);
  console.log(text.slice(0, 600));
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const form = new FormData();
form.append('purpose', 'image_understanding');
form.append('file', new Blob([Buffer.from(PNG_1X1, 'base64')], { type: 'image/png' }), 'probe.png');

const upload = await fetch(`${baseUrl}/v1/files/upload`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${apiKey}` },
  body: form,
});
const uploadBody = await show('1. upload', upload);

const fileId = uploadBody?.base_resp?.status_code === 0 ? uploadBody?.file?.file_id : undefined;
if (fileId === undefined) {
  console.log('\nResult: upload did not return a file_id — a BYOK key is NOT accepted (or the shape differs).');
  process.exit(0);
}

const msg = await fetch(`${baseUrl}/anthropic/v1/messages`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${apiKey}`,
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
  },
  body: JSON.stringify({
    model: 'MiniMax-M3',
    max_tokens: 64,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'url', url: `mm_file://${fileId}` } },
          { type: 'text', text: 'Reply with the single word: ok' },
        ],
      },
    ],
  }),
});
await show('2. messages with mm_file:// reference', msg);
console.log(
  msg.ok
    ? '\nResult: upload AND reference both work with a BYOK key.'
    : '\nResult: upload worked but the reference was rejected — see body above.',
);
