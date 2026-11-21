import { test } from 'node:test';
import assert from 'node:assert/strict';
import prism from 'prism-media';
import { pcmDurationSeconds, rms, toMono16k } from '../src/audio.js';

function sineStereo48k(seconds, freq = 440, amp = 0.3) {
  const frames = Math.round(48000 * seconds);
  const buf = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i++) {
    const s = Math.round(Math.sin((2 * Math.PI * freq * i) / 48000) * amp * 32767);
    buf.writeInt16LE(s, i * 4);
    buf.writeInt16LE(s, i * 4 + 2);
  }
  return buf;
}

test('PCM conversion produces 16 kHz mono audio', () => {
  const pcm = sineStereo48k(1);
  assert.equal(pcmDurationSeconds(pcm), 1);
  const mono = toMono16k(pcm);
  assert.equal(mono.length, 16000 * 2);
  assert.ok(rms(mono) > 0.15 && rms(mono) < 0.25);
});

test('silence has near-zero loudness', () => {
  assert.equal(rms(toMono16k(Buffer.alloc(48000 * 4))), 0);
});

test('opus decoder used for Discord audio round-trips', async () => {
  const encoder = new prism.opus.Encoder({ rate: 48000, channels: 2, frameSize: 960 });
  const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
  const out = [];
  decoder.on('data', (c) => out.push(c));
  const done = new Promise((r) => decoder.on('end', r));
  encoder.pipe(decoder);
  encoder.end(sineStereo48k(0.5));
  await done;
  const pcm = Buffer.concat(out);
  assert.ok(pcmDurationSeconds(pcm) > 0.4);
  assert.ok(rms(toMono16k(pcm)) > 0.1);
});

test('int16ToFloat32 scales samples to -1..1', async () => {
  process.env.DISCORD_TOKEN ||= 'x';
  process.env.OWNER_USER_ID ||= '1';
  process.env.GUILD_ID ||= '1';
  const { int16ToFloat32 } = await import('../src/stt.js');
  const buf = Buffer.alloc(6);
  buf.writeInt16LE(-32768, 0);
  buf.writeInt16LE(0, 2);
  buf.writeInt16LE(16384, 4);
  assert.deepEqual(Array.from(int16ToFloat32(buf)), [-1, 0, 0.5]);
});
