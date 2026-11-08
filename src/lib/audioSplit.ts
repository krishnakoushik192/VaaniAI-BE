// Gnani's REST speech-to-text accepts at most 30 s of audio per request.
// Longer recordings are cut into pieces of at most MAX_PIECE_SECONDS, each cut placed at
// the quietest moment near the end of the piece so a word is not split in half.
// Works without decoding for the two formats the app/tests produce:
//   - AAC in ADTS frames (what the phone records): cut between frames; small frames ≈ silence
//   - 16-bit PCM WAV (test clips): cut between samples; low energy = silence
// Any other format is passed through as one piece (Gnani rejects it if it is over 30 s).

export const MAX_PIECE_SECONDS = 25;
const SEARCH_FROM_SECONDS = 17; // look for a pause in [17 s, 25 s] of each piece

export type AudioPiece = { data: Buffer; seconds: number | null; filename: string; mimeType: string };
export type SplitResult = { pieces: AudioPiece[]; totalSeconds: number | null; format: 'adts' | 'wav' | 'other' };

/** Cut [0, n) into pieces of at most `max` units, preferring the lowest-cost unit in each search window. */
function cutPoints(n: number, max: number, from: number, cost: (i: number) => number): number[] {
  const cuts: number[] = [];
  let start = 0;
  while (n - start > max) {
    let best = start + max;
    let bestCost = Infinity;
    for (let i = start + from; i <= start + max; i++) {
      const c = cost(i);
      if (c < bestCost) {
        bestCost = c;
        best = i;
      }
    }
    cuts.push(best);
    start = best;
  }
  return cuts;
}

// ---------- AAC / ADTS ----------

const ADTS_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

type AdtsFrame = { offset: number; length: number };

function parseAdts(buf: Buffer): { frames: AdtsFrame[]; sampleRate: number } | null {
  if (buf.length < 7 || buf[0] !== 0xff || (buf[1]! & 0xf6) !== 0xf0) {
    return null;
  }
  const sampleRate = ADTS_RATES[(buf[2]! >> 2) & 0x0f];
  if (!sampleRate) {
    return null;
  }
  const frames: AdtsFrame[] = [];
  let pos = 0;
  while (pos + 7 <= buf.length) {
    if (buf[pos] !== 0xff || (buf[pos + 1]! & 0xf6) !== 0xf0) {
      break; // lost sync: stop at the last good frame
    }
    const length = ((buf[pos + 3]! & 0x03) << 11) | (buf[pos + 4]! << 3) | (buf[pos + 5]! >> 5);
    if (length < 7 || pos + length > buf.length) {
      break;
    }
    frames.push({ offset: pos, length });
    pos += length;
  }
  return frames.length ? { frames, sampleRate } : null;
}

function splitAdts(buf: Buffer, frames: AdtsFrame[], sampleRate: number): SplitResult {
  const frameSec = 1024 / sampleRate;
  const perPiece = Math.floor(MAX_PIECE_SECONDS / frameSec);
  const from = Math.floor(SEARCH_FROM_SECONDS / frameSec);
  const WIN = 8; // average frame size over ~0.5 s at 16 kHz: quiet speech gaps encode small
  const cost = (i: number) => {
    let sum = 0;
    for (let k = Math.max(0, i - WIN); k < Math.min(frames.length, i + WIN); k++) {
      sum += frames[k]!.length;
    }
    return sum;
  };
  const bounds = [0, ...cutPoints(frames.length, perPiece, from, cost), frames.length];
  const pieces: AudioPiece[] = [];
  for (let p = 0; p + 1 < bounds.length; p++) {
    const a = frames[bounds[p]!]!;
    const b = frames[bounds[p + 1]! - 1]!;
    pieces.push({
      data: buf.subarray(a.offset, b.offset + b.length),
      seconds: (bounds[p + 1]! - bounds[p]!) * frameSec,
      filename: `part${p + 1}.aac`,
      mimeType: 'audio/aac',
    });
  }
  return { pieces, totalSeconds: frames.length * frameSec, format: 'adts' };
}

// ---------- WAV (PCM 16-bit) ----------

function parseWav(buf: Buffer) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    return null;
  }
  let pos = 12;
  let fmt: { channels: number; sampleRate: number; bits: number; format: number } | null = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === 'fmt ') {
      fmt = { format: buf.readUInt16LE(pos + 8), channels: buf.readUInt16LE(pos + 10), sampleRate: buf.readUInt32LE(pos + 12), bits: buf.readUInt16LE(pos + 22) };
    } else if (id === 'data' && fmt) {
      const end = Math.min(buf.length, pos + 8 + size);
      return { fmt, data: buf.subarray(pos + 8, end) };
    }
    pos += 8 + size + (size % 2);
  }
  return null;
}

function wavFile(pcm: Buffer, channels: number, sampleRate: number, bits: number): Buffer {
  const h = Buffer.alloc(44);
  const blockAlign = (channels * bits) / 8;
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * blockAlign, 28);
  h.writeUInt16LE(blockAlign, 32);
  h.writeUInt16LE(bits, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

function splitWav(wav: NonNullable<ReturnType<typeof parseWav>>): SplitResult | null {
  const { fmt, data } = wav;
  if (fmt.format !== 1 || fmt.bits !== 16) {
    return null; // not plain 16-bit PCM: pass through
  }
  const blockAlign = fmt.channels * 2;
  const unitBlocks = Math.max(1, Math.round(fmt.sampleRate / 20)); // 50 ms units
  const unitBytes = unitBlocks * blockAlign;
  const units = Math.ceil(data.length / unitBytes);
  const unitSec = unitBlocks / fmt.sampleRate;
  const energy = (u: number) => {
    let sum = 0;
    const end = Math.min(data.length, (u + 1) * unitBytes);
    for (let o = u * unitBytes; o + 1 < end; o += blockAlign) {
      const s = data.readInt16LE(o);
      sum += s * s;
    }
    return sum;
  };
  const bounds = [0, ...cutPoints(units, Math.floor(MAX_PIECE_SECONDS / unitSec), Math.floor(SEARCH_FROM_SECONDS / unitSec), energy), units];
  const pieces: AudioPiece[] = [];
  for (let p = 0; p + 1 < bounds.length; p++) {
    const pcm = data.subarray(bounds[p]! * unitBytes, Math.min(data.length, bounds[p + 1]! * unitBytes));
    pieces.push({
      data: wavFile(pcm, fmt.channels, fmt.sampleRate, 16),
      seconds: pcm.length / (fmt.sampleRate * blockAlign),
      filename: `part${p + 1}.wav`,
      mimeType: 'audio/wav',
    });
  }
  return { pieces, totalSeconds: data.length / (fmt.sampleRate * blockAlign), format: 'wav' };
}

// ---------- entry ----------

export function splitAudio(buf: Buffer, file: { filename: string; mimeType: string }): SplitResult {
  const adts = parseAdts(buf);
  if (adts) {
    return splitAdts(buf, adts.frames, adts.sampleRate);
  }
  const wav = parseWav(buf);
  const split = wav ? splitWav(wav) : null;
  if (split) {
    return split;
  }
  return { pieces: [{ data: buf, seconds: null, filename: file.filename, mimeType: file.mimeType }], totalSeconds: null, format: 'other' };
}
