// Voice → bill draft. Nothing here saves a bill: the app shows the draft on the
// Bill Review screen, the shopkeeper fixes anything flagged, then the app
// saves it with POST /api/transactions.
import { Router, type Request } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { Customer } from '../models/Customer.js';
import { Shopkeeper, type Language } from '../models/Shopkeeper.js';
import { shopId } from '../middleware/auth.js';
import { HttpError } from '../lib/errors.js';
import { buildDraft, type DraftCustomer } from '../lib/billDraft.js';
import { speak, STT_LANGUAGES, transcribe, TTS_MAX_CHARS } from '../services/gnani.js';
import { extractBill } from '../services/extract.js';

const router = Router();

// Vercel rejects request bodies over ~4.5 MB. A 90 s phone recording (AAC, 32 kbps) is ~360 KB.
const MAX_AUDIO_BYTES = 4 * 1024 * 1024;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_AUDIO_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ok = file.mimetype.startsWith('audio/') || ['application/octet-stream', 'video/mp4', 'video/webm'].includes(file.mimetype);
    if (ok) {
      cb(null, true);
    } else {
      cb(new HttpError(400, `Unsupported file type ${file.mimetype}; send WAV, MP3, M4A, AAC, OGG or FLAC`));
    }
  },
});

const LANGUAGE_HINTS: Record<Language, string[]> = {
  te: ['te-IN', 'en-IN', 'hi-IN'],
  hi: ['hi-IN', 'en-IN'],
  en: ['en-IN', 'hi-IN', 'te-IN'],
};

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid customer id');
const languagesField = z
  .string()
  .transform(s => s.split(',').map(x => x.trim()).filter(Boolean))
  .pipe(z.array(z.enum(STT_LANGUAGES)).min(1).max(4));

/** The shop's language setting and its named customers (for name matching). */
async function loadContext(req: Request) {
  const owner = shopId(req);
  const [shop, docs] = await Promise.all([
    Shopkeeper.findById(owner).select('language'),
    Customer.find({ shopkeeperId: owner, isWalkinCustomer: false })
      .select('customerName phoneNumber pastDues')
      .sort({ updatedAt: -1 })
      .limit(300),
  ]);
  if (!shop) {
    throw new HttpError(401, 'Account not found');
  }
  const customers: DraftCustomer[] = docs.map(c => ({
    id: c.id as string,
    customerName: c.customerName,
    pastDues: c.pastDues,
    phoneNumber: c.phoneNumber,
  }));
  return { language: shop.language, customers };
}

async function runStt(req: Request, language: Language, customers: DraftCustomer[]) {
  if (!req.file) {
    throw new HttpError(400, 'Attach the recording as form-data field "audio"');
  }
  const languages =
    typeof req.body?.languages === 'string' && req.body.languages
      ? languagesField.parse(req.body.languages)
      : LANGUAGE_HINTS[language];
  return transcribe(req.file.buffer, {
    filename: req.file.originalname || 'recording.wav',
    mimeType: req.file.mimetype,
    languages,
    keyterms: customers.map(c => c.customerName),
  });
}

async function draftFromTranscript(transcript: string, customers: DraftCustomer[], customerId?: string) {
  if (customerId && !customers.some(c => c.id === customerId)) {
    throw new HttpError(404, 'Customer not found');
  }
  const { extraction, model, ms } = await extractBill(
    transcript,
    customers.map(c => ({ id: c.id, name: c.customerName })),
  );
  return { draft: buildDraft(extraction, customers, customerId), extraction, model, ms };
}

/** POST /api/voice/transcribe  (form-data: audio, languages?) → speech-to-text only */
router.post('/transcribe', upload.single('audio'), async (req, res) => {
  const { language, customers } = await loadContext(req);
  const stt = await runStt(req, language, customers);
  res.json(stt);
});

const extractBody = z.object({
  transcript: z.string().trim().min(1).max(5000),
  customerId: objectId.optional(),
});

/** POST /api/voice/extract  { transcript, customerId? } → bill draft from text (no audio) */
router.post('/extract', async (req, res) => {
  const { transcript, customerId } = extractBody.parse(req.body);
  const { customers } = await loadContext(req);
  const { draft, extraction, model, ms } = await draftFromTranscript(transcript, customers, customerId);
  res.json({ transcript, draft, extraction, timings: { llmMs: ms }, model });
});

/** POST /api/voice/bill  (form-data: audio, customerId?, languages?) → transcript + bill draft */
router.post('/bill', upload.single('audio'), async (req, res) => {
  const customerId = req.body?.customerId ? objectId.parse(req.body.customerId) : undefined;
  const { language, customers } = await loadContext(req);
  const stt = await runStt(req, language, customers);
  if (!stt.transcript) {
    throw new HttpError(422, 'No speech heard in the recording, please try again');
  }
  const { draft, extraction, model, ms } = await draftFromTranscript(stt.transcript, customers, customerId);
  res.json({
    transcript: stt.transcript,
    detectedLanguage: stt.detectedLanguage,
    truncated: stt.truncated,
    seconds: stt.seconds,
    draft,
    extraction,
    timings: { sttMs: stt.ms, llmMs: ms, pieces: stt.pieces },
    model,
  });
});

const speakQuery = z.object({
  // UTF-8 text as base64url, so Telugu/Hindi stay short in the URL
  t: z.string().min(1).max(4 * TTS_MAX_CHARS),
  lang: z.string().max(10).optional(),
});

/**
 * GET /api/voice/speak?t=<base64url text>&lang=te-IN → audio/mpeg
 * Reads text aloud (the app plays the transcript back after a voice bill). A GET so the
 * phone's media player can stream it directly with the login header.
 */
router.get('/speak', async (req, res) => {
  const { t, lang } = speakQuery.parse(req.query);
  const text = Buffer.from(t, 'base64url').toString('utf8').trim();
  if (!text) {
    throw new HttpError(400, 'Nothing to read');
  }
  if (text.length > TTS_MAX_CHARS) {
    throw new HttpError(400, `Text is too long to read in one go (max ${TTS_MAX_CHARS} characters)`);
  }
  const audio = await speak(text, lang);
  res.set('Cache-Control', 'private, max-age=600');
  res.type('audio/mpeg').send(audio);
});

export default router;
