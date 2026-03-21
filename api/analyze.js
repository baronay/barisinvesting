export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { ticker, prompt } = req.body;

  if (!ticker) {
    return res.status(400).json({ error: 'Ticker gerekli' });
  }

  if (!prompt) {
    return res.status(400).json({ error: 'Prompt gerekli' });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1200,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await response.json();

    if (data.error) {
      return res.status(500).json({ error: data.error.message });
    }

    const text = data.content?.[0]?.text || '';
    res.status(200).json({ result: text });

  } catch (err) {
    res.status(500).json({ error: 'API hatası: ' + err.message });
  }
}
