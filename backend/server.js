const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const PORT = process.env.PORT || 3000;

const client = new Anthropic();
const SYSTEM_PROMPT = fs.readFileSync(
  path.resolve(__dirname, '..', 'prompts', 'system-prompt.md'),
  'utf8'
);
const MENU_DATA = fs.readFileSync(
  path.resolve(__dirname, '..', 'data', 'menu.json'),
  'utf8'
);
const FULL_SYSTEM_PROMPT = `${SYSTEM_PROMPT}

## Menu & Hours Data (JSON)

Use only the items, prices, sizes, options, and hours below. Never invent menu items, prices, or hours not present in this data.

${MENU_DATA}`;

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'frontend')));

app.post('/api/chat', async (req, res) => {
  const { message, conversationHistory } = req.body;

  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'message is required' });
  }

  const history = Array.isArray(conversationHistory) ? conversationHistory : [];

  try {
    const response = await client.messages.create({
      model: 'claude-opus-5',
      max_tokens: 1024,
      system: FULL_SYSTEM_PROMPT,
      messages: [...history, { role: 'user', content: message }],
    });

    const textBlock = response.content.find((block) => block.type === 'text');

    res.json({
      reply: textBlock ? textBlock.text : '',
      conversationHistory: [...history, { role: 'user', content: message }, { role: 'assistant', content: response.content }],
    });
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) {
      console.error('Claude API authentication error:', error.message);
    } else if (error instanceof Anthropic.RateLimitError) {
      console.error('Claude API rate limited:', error.message);
    } else if (error instanceof Anthropic.APIError) {
      console.error(`Claude API error ${error.status}:`, error.message);
    } else {
      console.error('Unexpected error calling Claude API:', error);
    }

    res.status(502).json({
      reply: "Sorry, I'm having trouble responding right now. Please try again in a moment.",
      conversationHistory: history,
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
