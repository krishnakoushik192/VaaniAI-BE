// Transcript → structured bill, using Google Gemini (Interactions API) with a
// JSON schema. The model only READS the transcript; it never adds up money.
// Totals are computed in code (lib/billDraft.ts).
import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import { HttpError } from '../lib/errors.js';

export const DEFAULT_MODEL = 'gemini-3.5-flash-lite';

export const UNITS = ['kg', 'g', 'L', 'ml', 'pc', 'packet', 'dozen', 'box', 'bottle', 'bag'] as const;

/** What the LLM must return. Validated again with zod before use. */
export const extractionSchema = z.object({
  customerName: z.string().nullable(),
  matchedCustomerId: z.string().nullable(),
  paymentMethod: z.enum(['cash', 'upi', 'khata']).nullable(),
  items: z.array(
    z.object({
      name: z.string(),
      spokenName: z.string(),
      qty: z.number(),
      unit: z.enum(UNITS),
      ratePerUnit: z.number().nullable(),
      lineAmount: z.number().nullable(),
      unsure: z.boolean(),
      unsureReason: z.string().nullable(),
    }),
  ),
  discount: z.number().nullable(),
});
export type Extraction = z.infer<typeof extractionSchema>;

// The same shape as plain JSON Schema, which is what Gemini's response_format takes.
const jsonSchema = z.toJSONSchema(extractionSchema);

const SYSTEM_PROMPT = `You read transcripts of a shopkeeper at an Indian kirana (grocery) shop speaking a bill aloud.
The speech can be Telugu, Hindi, English or a mix, in any script. Extract the bill exactly as spoken.

Rules:
- NEVER calculate totals, never invent prices or quantities. Copy only numbers that were said.
- Convert number words in any language to digits: "అరవై"/"साठ"/"sixty" = 60, "నూట నలభై ఐదు"/"एक सौ पैंतालीस" = 145.
  Fractions: half/aadha/ara/అర = 0.5, paav/pav/quarter = 0.25, dedh = 1.5, dhai = 2.5.
- qty is in the SAME unit the price refers to. "250 grams sugar, 48 per kilo" → qty 0.25, unit "kg", ratePerUnit 48.
  "dozen bananas 60" → qty 1, unit "dozen". No unit spoken → "pc".
- ratePerUnit = rupees for ONE unit, when a per-unit price was said ("60 a kilo", "40 each", "40 rupees wale").
- lineAmount = rupees for the whole line, when a line price was said ("oil 145", "2 kilo rice 120").
  If only one price is said and it is ambiguous, put it in lineAmount for qty 1, otherwise ratePerUnit.
  Leave a field null when it was not said.
- name: short common English name with a capital letter (Rice, Sunflower Oil, Sugar, Soap). spokenName: the words as spoken.
- unsure = true (with a short unsureReason) when a quantity, unit or price is unclear, garbled or possibly misheard.
- customerName: the customer's name as spoken, or null. matchedCustomerId: the id from the KNOWN CUSTOMERS list
  whose name is the same person (match across scripts/spellings: "రమేష్" = "Ramesh"), or null if none clearly matches.
- paymentMethod: "khata" for credit / udhaar / write in book / ఖాతా / खाते में; "upi" for UPI / PhonePe / GPay / Paytm / online;
  "cash" for cash / నగదు / नकद; null if not said.
- discount: rupees off the whole bill if said, else null.`;

let client: GoogleGenAI | null = null;
function gemini(): GoogleGenAI {
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey) {
    throw new Error('LLM_API_KEY is not set');
  }
  return (client ??= new GoogleGenAI({ apiKey }));
}

export type KnownCustomer = { id: string; name: string };

export async function extractBill(
  transcript: string,
  customers: KnownCustomer[],
): Promise<{ extraction: Extraction; model: string; ms: number }> {
  const model = process.env.GEMINI_MODEL || DEFAULT_MODEL;
  const known = customers.length
    ? customers.map(c => `${c.id}\t${c.name}`).join('\n')
    : '(none)';
  const input = `KNOWN CUSTOMERS (id<TAB>name):\n${known}\n\nTRANSCRIPT:\n${transcript}`;

  const started = Date.now();
  let text: string | undefined;
  try {
    const interaction = await gemini().interactions.create({
      model,
      store: false, // don't keep the conversation on Google's side
      system_instruction: SYSTEM_PROMPT,
      input,
      response_format: { type: 'text', mime_type: 'application/json', schema: jsonSchema },
      generation_config: { temperature: 0, thinking_level: 'low' },
    });
    text = interaction.output_text;
  } catch (err) {
    const e = err as { status?: number; message?: string };
    console.error(`Gemini error ${e.status ?? ''}: ${e.message ?? err}`);
    if (e.status === 429) {
      throw new HttpError(503, 'AI limit reached for now, please try again in a minute');
    }
    if (e.status === 400 || e.status === 401 || e.status === 403) {
      throw new HttpError(502, 'AI service rejected the request (check LLM_API_KEY / GEMINI_MODEL)');
    }
    throw new HttpError(503, 'AI service is unavailable, please try again');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text ?? '');
  } catch {
    console.error('Gemini returned non-JSON:', text);
    throw new HttpError(502, 'AI returned an unreadable answer, please try again');
  }
  const result = extractionSchema.safeParse(parsed);
  if (!result.success) {
    console.error('Gemini JSON failed validation:', result.error.issues, text);
    throw new HttpError(502, 'AI returned an unexpected answer, please try again');
  }
  return { extraction: result.data, model, ms: Date.now() - started };
}
