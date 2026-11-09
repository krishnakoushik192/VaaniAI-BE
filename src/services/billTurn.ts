// One turn of the voice-bill conversation: the AI reads what the shopkeeper just said and
// returns EDITS to the bill on screen (add / update / remove), never totals.
// lib/billState.ts applies the edits and does all the money maths.
import { z } from 'zod';
import { geminiJson, knownCustomersText, UNITS, type KnownCustomer } from './extract.js';
import { missingFields, type TurnState } from '../lib/billState.js';

const LANGUAGE_NAMES = { te: 'Telugu', hi: 'Hindi', en: 'English' } as const;
export type AppLanguage = keyof typeof LANGUAGE_NAMES;

export const turnSchema = z.object({
  customerName: z.string().nullable(),
  matchedCustomerId: z.string().nullable(),
  similarCustomerId: z.string().nullable(),
  paymentMethod: z.enum(['cash', 'upi', 'khata']).nullable(),
  discount: z.number().nullable(),
  confirmed: z.boolean(),
  operations: z.array(
    z.object({
      op: z.enum(['add', 'update', 'remove']),
      itemId: z.string().nullable(),
      name: z.string().nullable(),
      localName: z.string().nullable(),
      qtySpoken: z.boolean(),
      qty: z.number().nullable(),
      unit: z.enum(UNITS).nullable(),
      ratePerUnit: z.number().nullable(),
      lineAmount: z.number().nullable(),
      usualRate: z.number().nullable(),
    }),
  ),
});
export type TurnEdits = z.infer<typeof turnSchema>;

const SCRIPT_NAMES = { te: 'Telugu script (తెలుగు)', hi: 'Hindi in Devanagari script (हिन्दी)', en: 'English in Latin letters' } as const;

const systemPrompt = (lang: AppLanguage) => `You are the helper at an Indian kirana (grocery) shop counter, writing down the bill
the shopkeeper speaks. The speech can be Telugu, Hindi, English or a mix, in any script.
You get the CURRENT BILL (may be empty), maybe a QUESTION you just asked, and what the shopkeeper SAID now.
Return the EDITS that make the bill match what the shopkeeper wants. Never calculate totals.

Operations:
- "add": a new item. itemId null. name = short common English name with a capital letter (Rice, Sugar,
  Sunflower Oil). localName = that item's everyday name in ${LANGUAGE_NAMES[lang]}, written ONLY in ${SCRIPT_NAMES[lang]} (e.g. ${
  lang === 'te' ? 'బియ్యం, చక్కెర, నూనె, కందిపప్పు' : lang === 'hi' ? 'चावल, चीनी, तेल, अरहर दाल' : 'Rice, Sugar, Oil, Toor Dal'
}). Never write it in any other script, even when the shopkeeper spoke another language.
- "update": change an item already on the bill: itemId from CURRENT BILL; fill ONLY the fields that change,
  leave the others null. Use this for corrections ("not 3 kg, 2 kg rice", "sugar is 45 rupees") and for
  answers to your QUESTION (the question may ask about several items at once; "oil 145, sugar 45" answers
  both, each to its own item).
- "remove": take an item off the bill (itemId from CURRENT BILL), e.g. "remove the soap", "no oil".
- If the shopkeeper lists items again that are already on the bill, update them; do not add duplicates.
- Extra items ("also 2 packets milk", "inka...", "aur...") are "add".

Numbers: copy only numbers that were said; convert number words in any language to digits
("అరవై"/"साठ"/"sixty" = 60). half/aadha/ara/అర = 0.5, paav/quarter = 0.25, dedh = 1.5, dhai = 2.5.
- qty is in the same unit as the price. "250 grams sugar, 48 per kilo" → qty 0.25, unit "kg", ratePerUnit 48.
  No unit said → "pc". "dozen eggs 60" → qty 1, unit "dozen".
- ratePerUnit = rupees for ONE unit ("60 a kilo", "40 each"). lineAmount = rupees for the whole line
  ("oil 145", "2 kilo rice 120"). Leave null when not said.
- usualRate (for "add", and for "update" when the item changes): what ONE unit of this item normally
  costs at an Indian kirana shop today, in rupees, as a plain estimate (rice ~60/kg, sugar ~45/kg,
  sunflower oil ~145/L, soap ~40 each). null if you have no idea. It is never put on the bill.
- qtySpoken = true ONLY if the shopkeeper said how many / how much of this item ("3 kg", "two packets",
  "oka sabbu", "ek"). A price per unit ("kg 40", "కేజీ నలభై", "किलो चालीस", "40 per kilo") is a RATE,
  not a quantity: if no separate quantity was said, qtySpoken = false and qty = null. Never guess 1.
  You will be asked to get the missing quantity.

Customer: customerName = the customer's name if said now, else null. matchedCustomerId = the id from
KNOWN CUSTOMERS that is the same person (match across scripts/spellings: "రమేష్" = "Ramesh"), else null.
similarCustomerId: when you matched a customer, the id of ANOTHER known customer whose name sounds almost
the same when spoken (Ramesh / Rajesh, Suresh / Naresh), so either could have been meant; else null.
paymentMethod: "khata" for credit / udhaar / write in book / ఖాతా / खाते में; "upi" for UPI / PhonePe /
GPay / online; "cash" for cash / నగదు / नकद; null if not said now.
discount: rupees off the whole bill if said now, else null.
confirmed: true ONLY when you asked "Save?" (QUESTION is "SAVE?") and the shopkeeper agrees the bill is right
with no change: yes / ok / correct / save / haan / ha / theek hai / sari / avunu / సరే / అవును / హా / हाँ / ठीक है.
Anything else (a change, a new item, "no", "wait") → false. When confirmed is true, return no operations.
If QUESTION is "DID YOU MEAN", the shopkeeper is picking one of the two values or names: set that
value with an "update" (or matchedCustomerId for a name), even if it is the one already on the bill.
If nothing about the bill was said, return no operations.`;

const billText = (state: TurnState) =>
  state.items.length
    ? state.items
        .map(i => `${i.id}\t${i.name}\tqty=${i.qty ?? '?'} ${i.unit}\trate=${i.rate == null ? '?' : i.rate / 100}${i.lineAmount != null && i.rate == null ? `\tlineAmount=${i.lineAmount / 100}` : ''}`)
        .join('\n')
    : '(empty)';

/** `lang` = the language item names are written in (what the shopkeeper spoke, else the app's). */
export async function readTurn(said: string, state: TurnState, customers: KnownCustomer[], lang: AppLanguage) {
  const missing = missingFields(state);
  const asks = [
    ...missing.qty.map(i => `the QUANTITY of ${i.id} (${i.name})`),
    ...missing.rate.map(i => `the PRICE of ${i.id} (${i.name})`),
  ];
  const check = state.check;
  const checkItem = check?.kind === 'amount' ? state.items.find(i => i.id === check.itemId) : undefined;
  const didYouMean =
    check?.kind === 'amount' && checkItem
      ? `DID YOU MEAN: is the ${check.field === 'line' ? 'line price' : 'price per unit'} of ${checkItem.id} (${checkItem.name}) ${check.options[1] / 100} or ${check.options[0] / 100} rupees?`
      : check?.kind === 'customer'
      ? `DID YOU MEAN: is the customer ${check.options[0]} or ${check.options[1]}? (ids from KNOWN CUSTOMERS)`
      : null;
  // No question and a complete bill = the read-back just asked "Save?".
  const question =
    state.question && asks.length ? `You asked for ${asks.join(', ')}.` : didYouMean ?? (state.items.length ? 'SAVE?' : '(none)');
  const input = [
    `KNOWN CUSTOMERS (id<TAB>name):\n${knownCustomersText(customers)}`,
    `CURRENT BILL (id<TAB>name<TAB>qty<TAB>rate in rupees):\n${billText(state)}`,
    `QUESTION YOU ASKED:\n${question}`,
    `SHOPKEEPER SAID:\n${said}`,
  ].join('\n\n');
  return geminiJson(systemPrompt(lang), input, turnSchema);
}
