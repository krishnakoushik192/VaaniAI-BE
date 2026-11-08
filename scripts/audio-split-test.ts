// Unit check for lib/audioSplit.ts with synthetic AAC (ADTS) frames — no network.
// Run: npx tsx scripts/audio-split-test.ts
import assert from 'node:assert/strict';
import { MAX_PIECE_SECONDS, splitAudio } from '../src/lib/audioSplit.ts';

// ADTS header for 16 kHz mono AAC-LC; payload bytes are dummy (size = loudness proxy).
function frame(len: number): Buffer {
  const b = Buffer.alloc(len);
  b[0] = 0xff; b[1] = 0xf1; // sync, MPEG-4, no CRC
  b[2] = (1 << 6) | (8 << 2); // AAC-LC, sample rate index 8 = 16 kHz
  b[3] = (1 << 6) | ((len >> 11) & 0x03); // 1 channel + length high bits
  b[4] = (len >> 3) & 0xff;
  b[5] = ((len & 0x07) << 5) | 0x1f;
  b[6] = 0xfc;
  return b;
}
const frameSec = 1024 / 16000; // 64 ms
const seconds = 80;
const n = Math.round(seconds / frameSec);
// "speech" = 120-byte frames, with quiet 1 s gaps (20-byte frames) every 7 s
const isQuiet = (i: number) => (i * frameSec) % 7 > 6;
const buf = Buffer.concat(Array.from({ length: n }, (_, i) => frame(isQuiet(i) ? 20 : 120)));

const r = splitAudio(buf, { filename: 'r.aac', mimeType: 'audio/aac' });
assert.equal(r.format, 'adts');
assert.ok(Math.abs((r.totalSeconds ?? 0) - seconds) < 0.1, 'total duration');
assert.equal(Buffer.concat(r.pieces.map(p => p.data)).length, buf.length, 'pieces add up to the whole file');
let at = 0;
for (const p of r.pieces) {
  assert.ok((p.seconds ?? 99) <= MAX_PIECE_SECONDS + 0.01, 'each piece is within the limit');
  assert.equal(p.data[0], 0xff, 'each piece starts on a frame');
  at += p.seconds!;
  if (p !== r.pieces.at(-1)) {
    assert.ok(isQuiet(Math.round(at / frameSec)) || isQuiet(Math.round(at / frameSec) - 1), `cut at ${at.toFixed(2)} s is in a quiet gap`);
  }
}
console.log(`✔ ${seconds} s AAC → ${r.pieces.length} pieces: ${r.pieces.map(p => p.seconds!.toFixed(1)).join(' + ')} s, all cuts in pauses`);

const short = splitAudio(Buffer.concat(Array.from({ length: 200 }, () => frame(100))), { filename: 's.aac', mimeType: 'audio/aac' });
assert.equal(short.pieces.length, 1);
console.log('✔ short AAC stays one piece');
const other = splitAudio(Buffer.from('not audio at all'), { filename: 'x.m4a', mimeType: 'audio/mp4' });
assert.equal(other.format, 'other');
assert.equal(other.pieces.length, 1);
console.log('✔ unknown formats pass through unchanged');
