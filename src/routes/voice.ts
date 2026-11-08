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
import { readTurn } from '../services/billTurn.js';
import { applyEdits, buildReply, emptyState, retryReply, totals, type TurnState } from '../lib/billState.js';

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


// ---------- conversation: one turn ----------

const turnItem = z.object({
  id: z.string().min(1).max(20),
  name: z.string().max(100),
  localName: z.string().max(100),
  qty: z.number().positive().nullable(),
  unit: z.string().max(20),
  rate: z.number().int().min(0).nullable(),
  lineAmount: z.number().int().min(0).nullable().optional(),
});
const turnStateSchema = z.object({
  items: z.array(turnItem).max(100),
  customerId: objectId.nullable(),
  method: z.enum(['cash', 'upi', 'khata']).nullable(),
  discount: z.number().int().min(0),
  question: z.object({ itemId: z.string().max(20), field: z.enum(['qty', 'rate']) }).nullable(),
});
const turnBody = z.object({
  state: z.union([z.string().max(50_000), z.record(z.string(), z.unknown())]).nullable().optional(), // null = new bill
  text: z.string().max(5000).optional(), // typed instead of spoken (also used by tests)
  language: z.enum(['te', 'hi', 'en']).optional(), // language the app speaks back in
});

function parseState(raw: unknown): TurnState {
  if (raw == null || raw === '') {
    return emptyState();
  }
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      throw new HttpError(400, 'state is not valid JSON');
    }
  }
  // Form-data can only carry text, so a new bill arrives as the string "null".
  if (value == null) {
    return emptyState();
  }
  return turnStateSchema.parse(value);
}

/**
 * POST /api/voice/turn  (form-data: audio, state, language)  or JSON { text, state, language }
 * One step of the voice-bill conversation: what the shopkeeper said is applied to the bill on
 * screen (new items, corrections, removals, answers to the last question). Returns the new bill
 * state, the totals (computed here) and what the app should say next. Saves nothing.
 */
router.post('/turn', upload.single('audio'), async (req, res) => {
  const body = turnBody.parse(req.body ?? {});
  const state = parseState(body.state);
  const { language: shopLanguage, customers } = await loadContext(req);
  const lang = body.language ?? shopLanguage;

  let said = body.text?.trim() ?? '';
  let stt: Awaited<ReturnType<typeof runStt>> | null = null;
  if (req.file) {
    stt = await runStt(req, shopLanguage, customers);
    said = stt.transcript;
  }

  const findCustomer = (id: string | null) => customers.find(c => c.id === id) ?? null;
  if (!said) {
    // Nothing heard: keep the bill as it is; the app asks again.
    const customer = findCustomer(state.customerId);
    res.json({
      heard: false,
      transcript: '',
      state,
      customer: customer && { id: customer.id, name: customer.customerName, pastDues: customer.pastDues },
      spokenCustomerName: null,
      totals: totals(state),
      reply: retryReply(lang),
      timings: { sttMs: stt?.ms ?? 0, llmMs: 0 },
    });
    return;
  }

  const { data: edits, ms } = await readTurn(
    said,
    state,
    customers.map(c => ({ id: c.id, name: c.customerName })),
    lang,
  );
  const next = applyEdits(state, edits, new Set(customers.map(c => c.id)));
  const customer = findCustomer(next.customerId);
  const reply = buildReply(next, lang, customer && { name: customer.customerName, pastDues: customer.pastDues });
  res.json({
    heard: true,
    transcript: said,
    detectedLanguage: stt?.detectedLanguage ?? null,
    state: next,
    customer: customer && { id: customer.id, name: customer.customerName, pastDues: customer.pastDues },
    spokenCustomerName: !customer && edits.customerName ? edits.customerName : null,
    totals: totals(next),
    reply,
    timings: { sttMs: stt?.ms ?? 0, llmMs: ms },
  });
});

export default router;
