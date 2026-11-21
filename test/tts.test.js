import { test } from 'node:test';
import assert from 'node:assert/strict';

// tts.js imports config.js, which requires these.
process.env.DISCORD_TOKEN ||= 'test';
process.env.OWNER_USER_ID ||= '1';
process.env.GUILD_ID ||= '1';
const { splitForSpeech, toSpeakable } = await import('../src/tts.js');

test('long answers are not truncated', () => {
  const long = 'Ini kalimat yang cukup panjang untuk diuji. '.repeat(40);
  const spoken = toSpeakable(long);
  assert.equal(spoken.includes('Selengkapnya'), false);
  assert.equal(spoken.length, long.trim().length);
});

test('splitForSpeech keeps every word, in order, in short pieces', () => {
  const text = toSpeakable('Halo. ' + 'Ini kalimat yang cukup panjang, dengan koma, untuk diuji. '.repeat(15) + 'kata '.repeat(120));
  const pieces = splitForSpeech(text, 180);
  assert.ok(pieces.length > 3);
  for (const p of pieces) assert.ok(p.length <= 181, p.length);
  assert.equal(pieces.join(' ').replace(/\s+/g, ' '), text.replace(/\s+/g, ' '));
});

test('short text stays one piece', () => {
  assert.deepEqual(splitForSpeech('Oke, saya kerjakan.'), ['Oke, saya kerjakan.']);
  assert.deepEqual(splitForSpeech(''), []);
});

test('lastAnswer returns text after the latest prompt', async () => {
  const { lastAnswer } = await import('../src/watcher.js');
  const L = (o) => JSON.stringify(o);
  const lines = [
    L({ type: 'user', message: { content: 'tanya 1' } }),
    L({ type: 'assistant', message: { content: [{ type: 'text', text: 'jawab 1' }] } }),
    L({ type: 'user', message: { content: 'tanya 2' } }),
    L({ type: 'assistant', message: { content: [{ type: 'text', text: 'sebentar' }, { type: 'tool_use', name: 'Bash' }] } }),
    L({ type: 'user', message: { content: [{ type: 'tool_result', content: 'x' }] } }),
    L({ type: 'assistant', message: { content: [{ type: 'text', text: 'jawab 2' }] } }),
    'not json',
  ];
  assert.equal(lastAnswer(lines), 'jawab 2');
  assert.equal(lastAnswer(lines.slice(0, 3)), '');
});
