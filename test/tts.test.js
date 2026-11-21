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
  const pieces = splitForSpeech(text, 280);
  assert.ok(pieces.length > 3);
  for (const p of pieces) assert.ok(p.length <= 281, p.length);
  assert.equal(pieces.join(' ').replace(/\s+/g, ' '), text.replace(/\s+/g, ' '));
});

test('short text stays one piece', () => {
  assert.deepEqual(splitForSpeech('Oke, saya kerjakan.'), ['Oke, saya kerjakan.']);
  assert.deepEqual(splitForSpeech(''), []);
});
