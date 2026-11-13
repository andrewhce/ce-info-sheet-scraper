'use strict';
// Test helper (used by agent.test.js): starts the real dashboard server, but with a scripted stand-in for the AI service,
// so the Ask page can be exercised end to end without any account or key.
const agent = require('../src/agent');

const reply = (content, stop_reason) => ({ content, stop_reason, model: 'claude-opus-5-5', usage: { input_tokens: 1200, output_tokens: 80 } });
const create = async (params) => {
  const last = params.messages[params.messages.length - 1];
  if (Array.isArray(last.content) && last.content[0] && last.content[0].type === 'tool_result') {
    return reply([{ type: 'text', text: 'Alpha Academy: tuition **differs** from the sheet. [Alpha Academy](#/school/alpha-academy)' }], 'end_turn');
  }
  return reply([{ type: 'tool_use', id: 'toolu_1', name: 'search_schools', input: { query: 'alpha' } }], 'tool_use');
};
agent.clientFactory = () => ({
  beta: { messages: { create } }, messages: { create },
  models: { retrieve: async (id) => ({ id, display_name: 'Stand-in model' }) },
});
require('../src/server.js');
