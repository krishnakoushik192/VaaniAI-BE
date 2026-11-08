// Gnani speech-to-text (REST, Prisma v3.0). Docs: https://docs.gnani.ai/api/STT/speech-to-text
import { HttpError } from '../lib/errors.js';
import { splitAudio, type AudioPiece } from '../lib/audioSplit.js';

const STT_URL = 'https://api.vachana.ai/stt/v3';
const RETRY_DELAYS_MS = [500, 1000, 2000]; // Gnani's advice for 429/5xx; it allows 1 active request at a time
const TIMEOUT_MS = 20_000;

export const STT_LANGUAGES = ['te-IN', 'hi-IN', 'en-IN', 'ta-IN', 'kn-IN', 'ml-IN', 'mr-IN', 'bn-IN', 'gu-IN', 'pa-IN'] as const;

export type Transcription = {
  transcript: string;
  detectedLanguage: string | null;
  requestId: string | null;
  truncated: boolean;
  ms: number;
};

type GnaniSuccess = {
  success: true;
  request_id?: string;
  transcript?: string;
  detected_language_code?: string;
  truncated?: boolean;
};

/** Pulls the human-readable message out of any of Gnani's error body shapes. */
function gnaniMessage(body: unknown): string {
  const b = body as {
    error?: { type?: string; message?: string } | string;
    detail?: { message?: string; error_code?: string } | Array<{ msg?: string; loc?: unknown[] }>;
    message?: string;
  } | null;
  if (b?.error && typeof b.error === 'object') {
    return `${b.error.type ?? 'ERROR'}: ${b.error.message ?? ''}`;
  }
  if (Array.isArray(b?.detail)) {
    return b.detail.map(d => `${(d.loc ?? []).join('.')}: ${d.msg}`).join('; ');
  }
  if (b?.detail && typeof b.detail === 'object') {
    return `${b.detail.error_code ?? 'ERROR'}: ${b.detail.message ?? ''}`;
  }
  return b?.message ?? (typeof b?.error === 'string' ? b.error : 'Unknown error');
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

type SttFields = { language_code: string; format?: string; context: boolean };
type SttResult =
  | { ok: true; value: Transcription }
  | { ok: false; status: number; type: string; message: string };

const TOPIC = 'Indian kirana shop counter: item names, quantities, units, prices in rupees, customer names, cash / UPI / khata (credit).';

/** Gnani errors where the same audio may still work with simpler settings. */
const SETTINGS_ERRORS = ['INVALID_CONTEXT', 'MODEL_UNSUPPORTED_LANGUAGE', 'INVALID_LANGUAGE_CODE', 'INVALID_FORMAT'];

/** One Gnani request, retried on network errors / 429 / 5xx. */
async function sttRequest(
  key: string,
  piece: AudioPiece,
  opts: { keyterms?: string[]; previousText?: string },
  fields: SttFields,
  started: number,
): Promise<SttResult> {
  for (let attempt = 0; ; attempt++) {
    const form = new FormData();
    form.append('audio_file', new Blob([new Uint8Array(piece.data)], { type: piece.mimeType }), piece.filename);
    form.append('model', 'prisma-v3.0');
    form.append('language_code', fields.language_code);
    if (fields.format) {
      form.append('format', fields.format);
    }
    if (fields.context) {
      form.append('topic', TOPIC);
      if (opts.keyterms?.length) {
        form.append('keyterms', JSON.stringify(opts.keyterms.slice(0, 200)));
      }
      if (opts.previousText) {
        form.append('previous_text', opts.previousText.slice(-600)); // what was said just before this piece
      }
    }

    let res: Response;
    try {
      res = await fetch(STT_URL, {
        method: 'POST',
        headers: { 'X-API-Key-ID': key },
        body: form,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      if (attempt < RETRY_DELAYS_MS.length) {
        await sleep(RETRY_DELAYS_MS[attempt]!);
        continue;
      }
      throw new HttpError(503, `Speech service unreachable: ${(err as Error).message}`);
    }

    const body: unknown = await res.json().catch(() => null);
    if (res.ok && (body as GnaniSuccess | null)?.success) {
      const ok = body as GnaniSuccess;
      return {
        ok: true,
        value: {
          transcript: (ok.transcript ?? '').trim(),
          detectedLanguage: ok.detected_language_code ?? null,
          requestId: ok.request_id ?? null,
          truncated: ok.truncated === true,
          ms: Date.now() - started,
        },
      };
    }
    if ([429, 500, 503, 504].includes(res.status) && attempt < RETRY_DELAYS_MS.length) {
      await sleep(RETRY_DELAYS_MS[attempt]!);
      continue;
    }
    // Gnani can append a full ffmpeg log; keep only the first line.
    const message = gnaniMessage(body).split('\n')[0]!.slice(0, 200);
    return { ok: false, status: res.status, type: message.split(':')[0]!.trim(), message };
  }
}

/** The longest recording accepted (the app stops at 90 s; a little slack for timing). */
export const MAX_RECORDING_SECONDS = 95;

type TranscribeOpts = {
  filename: string;
  mimeType: string;
  languages: string[]; // 1–4 hints for the fallback, e.g. ["te-IN", "en-IN", "hi-IN"]
  keyterms?: string[]; // customer names etc. that the model should spell correctly
};

/**
 * Speech → text, for recordings up to 90 s. Gnani takes at most 30 s per request, so longer
 * audio is cut at pauses into pieces (lib/audioSplit.ts) that are transcribed in order, each
 * with the text heard so far as context, and joined.
 */
export async function transcribe(audio: Buffer, opts: TranscribeOpts): Promise<Transcription & { pieces: number; seconds: number | null }> {
  const key = process.env.GNANI_API_KEY;
  if (!key) {
    throw new Error('GNANI_API_KEY is not set');
  }
  const started = Date.now();
  const { pieces, totalSeconds } = splitAudio(audio, { filename: opts.filename, mimeType: opts.mimeType });
  if (totalSeconds != null && totalSeconds > MAX_RECORDING_SECONDS) {
    throw new HttpError(413, `Recording is too long (${Math.round(totalSeconds)} s, max 90 s)`);
  }

  const texts: string[] = [];
  let detectedLanguage: string | null = null;
  let requestId: string | null = null;
  let truncated = false;
  // Gnani allows one active request per account, so pieces go one after another.
  for (const piece of pieces) {
    const r = await transcribePiece(key, piece, { ...opts, previousText: texts.join(' ') }, started);
    if (r.transcript) {
      texts.push(r.transcript);
      detectedLanguage ??= r.detectedLanguage;
    }
    requestId ??= r.requestId;
    truncated ||= r.truncated;
  }
  return {
    transcript: texts.join(' ').trim(),
    detectedLanguage,
    requestId,
    truncated,
    ms: Date.now() - started,
    pieces: pieces.length,
    seconds: totalSeconds,
  };
}

/**
 * One piece (≤ 30 s). The shopkeeper may speak Telugu, Hindi, English or a mix in one sentence,
 * whatever language the app is set to, so the first try auto-detects the language and uses
 * "codemix" (English words stay in English letters, which the AI reads best). If that hears
 * nothing or rejects the settings, a second try uses plain language hints without extras.
 */
async function transcribePiece(key: string, piece: AudioPiece, opts: TranscribeOpts & { previousText?: string }, started: number): Promise<Transcription> {
  const plans: SttFields[] = [
    { language_code: 'indic-auto', format: 'codemix', context: true },
    { language_code: opts.languages.slice(0, 4).join(','), context: false },
  ];

  let last: SttResult | null = null;
  for (const [i, fields] of plans.entries()) {
    const r = await sttRequest(key, piece, opts, fields, started);
    last = r;
    if (r.ok && r.value.transcript) {
      return r.value;
    }
    const moreToTry = i < plans.length - 1;
    if (r.ok) {
      console.warn(`Gnani STT heard nothing (${fields.language_code}, request ${r.value.requestId})${moreToTry ? ', retrying with language hints' : ''}`);
      continue;
    }
    console.error(`Gnani STT HTTP ${r.status} (${fields.language_code}): ${r.message}`);
    if (!(r.status === 400 && SETTINGS_ERRORS.includes(r.type))) {
      break; // audio / key / service problem: another setting won't help
    }
  }

  if (last?.ok) {
    return last.value; // nothing heard by any setting: the route answers 422
  }
  const status = last?.status ?? 503;
  if (status === 400 || status === 422) {
    throw new HttpError(400, `Could not process the audio (${last && !last.ok ? last.message : ''})`); // too long, empty, bad format…
  }
  if (status === 401 || status === 402 || status === 403) {
    throw new HttpError(502, 'Speech service rejected our API key or has no credit left');
  }
  throw new HttpError(503, 'Speech service is busy, please try again');
}

// ---------- text → speech (read the transcript back to the shopkeeper) ----------

const TTS_URL = 'https://api.vachana.ai/api/v1/tts/inference';
export const TTS_MAX_CHARS = 600;
const TTS_LANGUAGES = ['te-IN', 'hi-IN', 'en-IN', 'ta-IN', 'kn-IN', 'ml-IN', 'mr-IN', 'pa-IN', 'bn-IN', 'gu-IN'];

/**
 * Speaks `text` with Gnani's multilingual voice (Timbre v3.0 "Lakshmi"), which reads Telugu,
 * Hindi, English and sentences that mix them. Returns MP3 bytes (~8 KB per second).
 */
export async function speak(text: string, language?: string): Promise<Buffer> {
  const key = process.env.GNANI_API_KEY;
  if (!key) {
    throw new Error('GNANI_API_KEY is not set');
  }
  const body = JSON.stringify({
    text: text.slice(0, TTS_MAX_CHARS),
    voice: 'Lakshmi',
    model: 'timbre-v3.0',
    language: language && TTS_LANGUAGES.includes(language) ? language : 'auto',
    speed: 1.0,
    audio_config: { sample_rate: 24000, num_channels: 1, sample_width: 2, encoding: 'linear_pcm', container: 'mp3', bitrate: '64k' },
  });
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(TTS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key-ID': key },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      if (attempt < RETRY_DELAYS_MS.length) {
        await sleep(RETRY_DELAYS_MS[attempt]!);
        continue;
      }
      throw new HttpError(503, `Speech service unreachable: ${(err as Error).message}`);
    }
    if (res.ok) {
      return Buffer.from(await res.arrayBuffer());
    }
    if ([429, 500, 503, 504].includes(res.status) && attempt < RETRY_DELAYS_MS.length) {
      await sleep(RETRY_DELAYS_MS[attempt]!);
      continue;
    }
    const message = gnaniMessage(await res.json().catch(() => null)).split('\n')[0]!.slice(0, 200);
    console.error(`Gnani TTS HTTP ${res.status}: ${message}`);
    if (res.status === 401 || res.status === 402 || res.status === 403) {
      throw new HttpError(502, 'Speech service rejected our API key or has no credit left');
    }
    throw new HttpError(res.status === 400 ? 400 : 503, res.status === 400 ? 'Could not read this text aloud' : 'Speech service is busy, please try again');
  }
}
