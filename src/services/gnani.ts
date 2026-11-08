// Gnani speech-to-text (REST, Prisma v3.0). Docs: https://docs.gnani.ai/api/STT/speech-to-text
import { HttpError } from '../lib/errors.js';

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
async function sttRequest(key: string, audio: Buffer, opts: { filename: string; mimeType: string; keyterms?: string[] }, fields: SttFields, started: number): Promise<SttResult> {
  for (let attempt = 0; ; attempt++) {
    const form = new FormData();
    form.append('audio_file', new Blob([new Uint8Array(audio)], { type: opts.mimeType }), opts.filename);
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

/**
 * Speech → text. The shopkeeper may speak Telugu, Hindi, English or a mix in one sentence,
 * whatever language the app is set to, so the first try auto-detects the language and uses
 * "codemix" (English words stay in English letters, which the AI reads best). If that hears
 * nothing or rejects the settings, a second try uses plain language hints without extras.
 */
export async function transcribe(
  audio: Buffer,
  opts: {
    filename: string;
    mimeType: string;
    languages: string[]; // 1–4 hints for the fallback, e.g. ["te-IN", "en-IN", "hi-IN"]
    keyterms?: string[]; // customer names etc. that the model should spell correctly
  },
): Promise<Transcription> {
  const key = process.env.GNANI_API_KEY;
  if (!key) {
    throw new Error('GNANI_API_KEY is not set');
  }
  const started = Date.now();
  const plans: SttFields[] = [
    { language_code: 'indic-auto', format: 'codemix', context: true },
    { language_code: opts.languages.slice(0, 4).join(','), context: false },
  ];

  let last: SttResult | null = null;
  for (const [i, fields] of plans.entries()) {
    const r = await sttRequest(key, audio, opts, fields, started);
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
