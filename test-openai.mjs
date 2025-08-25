import 'dotenv/config';

// Use Node's built-in fetch (Node 18+)
const key = process.env.OPENAI_API_KEY;
if (!key) {
  console.error('❌ Missing OPENAI_API_KEY in .env');
  process.exit(1);
}

try {
  const resp = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'gpt-4.1-mini',
      input: 'Say "pong".'
    })
  });

  const data = await resp.json().catch(() => ({}));
  const text =
    data?.output?.[0]?.content?.[0]?.text ??
    data?.response?.content?.[0]?.text ??
    null;

  console.log('HTTP status:', resp.status);
  if (text) {
    console.log('Model reply:', text);
  } else {
    console.log('Full JSON:', JSON.stringify(data, null, 2));
  }
} catch (err) {
  console.error('Request error:', err?.message || err);
}
