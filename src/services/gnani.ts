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

export async function transcribe(
  audio: Buffer,
  opts: {
    filename: string;
    mimeType: string;
    languages: string[]; // 1–4 hints, e.g. ["te-IN", "en-IN"]
    keyterms?: string[]; // customer names etc. that the model should spell correctly
  },
): Promise<Transcription> {
  const key = process.env.GNANI_API_KEY;
  if (!key) {
    throw new Error('GNANI_API_KEY is not set');
  }

  const started = Date.now();
  for (let attempt = 0; ; attempt++) {
    const form = new FormData();
    form.append('audio_file', new Blob([new Uint8Array(audio)], { type: opts.mimeType }), opts.filename);
    form.append('model', 'prisma-v3.0');
    form.append('language_code', opts.languages.slice(0, 4).join(','));
    form.append('topic', 'Indian kirana shop counter: item names, quantities, units, prices in rupees, customer names, cash / UPI / khata (credit).');
    if (opts.keyterms?.length) {
      form.append('keyterms', JSON.stringify(opts.keyterms.slice(0, 200)));
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
        transcript: (ok.transcript ?? '').trim(),
        detectedLanguage: ok.detected_language_code ?? null,
        requestId: ok.request_id ?? null,
        truncated: ok.truncated === true,
        ms: Date.now() - started,
      };
    }

    const retryable = [429, 500, 503, 504].includes(res.status);
    if (retryable && attempt < RETRY_DELAYS_MS.length) {
      await sleep(RETRY_DELAYS_MS[attempt]!);
      continue;
    }

    // Gnani can append a full ffmpeg log; keep only the first line for the app.
    const message = gnaniMessage(body).split('\n')[0]!.slice(0, 200);
    console.error(`Gnani STT HTTP ${res.status}: ${message}`);
    if (res.status === 400 || res.status === 422) {
      throw new HttpError(400, `Could not process the audio (${message})`); // too long, empty, bad format…
    }
    if (res.status === 401 || res.status === 402 || res.status === 403) {
      throw new HttpError(502, 'Speech service rejected our API key or has no credit left');
    }
    throw new HttpError(503, 'Speech service is busy, please try again');
  }
}
