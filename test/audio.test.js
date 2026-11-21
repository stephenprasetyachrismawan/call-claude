import { test } from 'node:test';
import assert from 'node:assert/strict';
import prism from 'prism-media';
import { pcmDurationSeconds, rms, toMono16k, wavFromPcm } from '../src/audio.js';

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

test('PCM conversion produces a valid 16 kHz mono WAV', () => {
  const pcm = sineStereo48k(1);
  assert.equal(pcmDurationSeconds(pcm), 1);
  const mono = toMono16k(pcm);
  assert.equal(mono.length, 16000 * 2);
  assert.ok(rms(mono) > 0.15 && rms(mono) < 0.25);
  const wav = wavFromPcm(mono);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wav.length, 44 + mono.length);
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
