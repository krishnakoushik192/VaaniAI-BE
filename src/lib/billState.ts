// The bill being built in the voice conversation, plus the spoken replies.
// The AI only proposes edits (services/billTurn.ts); this file applies them and does all the
// money maths in integer paise, so totals and dues are always exact.
import type { TurnEdits, AppLanguage } from '../services/billTurn.js';
import { lineTotal, type Paise } from './money.js';

export type PaymentMethod = 'cash' | 'upi' | 'khata';

export type TurnItem = {
  id: string;
  name: string; // English, saved on the bill
  localName: string; // shown and spoken in the app's language
  qty: number | null; // null = not said yet → we ask
  unit: string;
  rate: Paise | null; // per unit; null = not said yet → we ask
  lineAmount?: Paise | null; // a spoken line price waiting for the quantity
  usualRate?: Paise | null; // the AI's idea of a normal kirana price per unit (used when the shop has none)
  checked?: boolean; // the shopkeeper already picked this price in a "did you mean" question
};

export type TurnQuestion = { itemId: string; field: 'qty' | 'rate' };

/**
 * "Did you mean?": a number or name that was probably misheard. Gnani gives no confidence
 * scores, so this comes from sound-alike numbers (16/60, सात/साठ …) that are far from the
 * item's usual price, and from customers whose names sound almost the same.
 */
export type TurnCheck =
  | { kind: 'amount'; itemId: string; field: 'rate' | 'line'; options: [Paise, Paise] } // [heard, couldBe]
  | { kind: 'customer'; options: [string, string] }; // [matched customer id, sound-alike customer id]

export type TurnState = {
  items: TurnItem[];
  customerId: string | null;
  method: PaymentMethod | null;
  discount: Paise;
  question: TurnQuestion | null;
  check?: TurnCheck | null;
  customerChecked?: boolean;
};

export const emptyState = (): TurnState => ({ items: [], customerId: null, method: null, discount: 0, question: null, check: null });

const toPaise = (rupees: number) => Math.round(rupees * 100);
const positive = (n: number | null | undefined) => (n != null && Number.isFinite(n) && n > 0 ? n : null);

/** Recompute the per-unit rate when only a line price was said. */
function settleRate(i: TurnItem) {
  if (i.rate == null && i.lineAmount != null && i.qty != null) {
    i.rate = Math.round(i.lineAmount / i.qty);
  }
}

function nextId(items: TurnItem[]) {
  let n = items.length + 1;
  while (items.some(i => i.id === `i${n}`)) {
    n++;
  }
  return `i${n}`;
}

const INDIC = /[\u0900-\u0DFF]/g; // Devanagari … Sinhala
const OWN_SCRIPT: Record<AppLanguage, RegExp | null> = { te: /[\u0C00-\u0C7F]/, hi: /[\u0900-\u097F]/, en: null };

/** True when the name has no letters from another Indian script than the language's own. */
export function inScript(text: string, lang: AppLanguage): boolean {
  const own = OWN_SCRIPT[lang];
  return (text.match(INDIC) ?? []).every(ch => own?.test(ch) ?? false);
}

/** The AI's local name, unless it came back in the wrong script (then the English name). */
const localNameFor = (localName: string | null | undefined, english: string, lang?: AppLanguage) => {
  const n = (localName ?? '').trim();
  return n && (!lang || inScript(n, lang)) ? n : english;
};

/** `nameLang`: the language item names must be written in; a name in another script is replaced by the English one. */
export function applyEdits(prev: TurnState, edits: TurnEdits, knownCustomerIds: Set<string>, nameLang?: AppLanguage): TurnState {
  const items = prev.items.map(i => ({ ...i }));
  for (const op of edits.operations) {
    if (op.op === 'add') {
      const name = (op.name ?? op.localName ?? '').trim();
      if (!name) {
        continue;
      }
      const item: TurnItem = {
        id: nextId(items),
        name,
        localName: localNameFor(op.localName, name, nameLang),
        qty: op.qtySpoken ? positive(op.qty) : null,
        unit: op.unit ?? 'pc',
        rate: op.ratePerUnit != null && op.ratePerUnit >= 0 ? toPaise(op.ratePerUnit) : null,
        // a spoken per-unit price wins; a line total is only kept when no unit price was said
        lineAmount: op.ratePerUnit == null && op.lineAmount != null && op.lineAmount >= 0 ? toPaise(op.lineAmount) : null,
        usualRate: op.usualRate != null && op.usualRate > 0 ? toPaise(op.usualRate) : null,
      };
      settleRate(item);
      items.push(item);
    } else if (op.op === 'update') {
      const item = items.find(i => i.id === op.itemId);
      if (!item) {
        continue;
      }
      if (op.name) {
        item.name = op.name.trim();
      }
      if (op.localName) {
        item.localName = localNameFor(op.localName, item.name, nameLang);
      }
      if (op.unit) {
        item.unit = op.unit;
      }
      if (op.qtySpoken && positive(op.qty)) {
        item.qty = op.qty;
        if (item.lineAmount != null && op.ratePerUnit == null) {
          item.rate = null; // a line price was said: recompute the rate for the new quantity
        }
      }
      const priceSaid = (op.ratePerUnit != null && op.ratePerUnit >= 0) || (op.lineAmount != null && op.lineAmount >= 0);
      if (op.ratePerUnit != null && op.ratePerUnit >= 0) {
        item.rate = toPaise(op.ratePerUnit);
        item.lineAmount = null;
      } else if (op.lineAmount != null && op.lineAmount >= 0) {
        item.lineAmount = toPaise(op.lineAmount);
        item.rate = null;
      }
      if (priceSaid) {
        // an answer to "60 or 16?" settles this price; any other new price is checked again
        item.checked = prev.check?.kind === 'amount' && prev.check.itemId === item.id;
      }
      if (op.usualRate != null && op.usualRate > 0) {
        item.usualRate = toPaise(op.usualRate);
      }
      settleRate(item);
    } else {
      const at = items.findIndex(i => i.id === op.itemId);
      if (at !== -1) {
        items.splice(at, 1);
      }
    }
  }

  const customerId = edits.matchedCustomerId && knownCustomerIds.has(edits.matchedCustomerId) ? edits.matchedCustomerId : prev.customerId;
  // Answering "Ramesh or Rajesh?" settles the customer; a newly matched customer is checked again.
  const answeredCustomer = prev.check?.kind === 'customer' && !!customerId && prev.check.options.includes(customerId);
  const state: TurnState = {
    items,
    customerId,
    method: edits.paymentMethod ?? prev.method,
    discount: edits.discount != null && edits.discount >= 0 ? toPaise(edits.discount) : prev.discount,
    question: null,
    check: null,
    customerChecked: answeredCustomer || (customerId === prev.customerId && !!prev.customerChecked),
  };
  state.question = nextQuestion(state);
  return state;
}

// ---------- "did you mean?" ----------

/** Rupee amounts that are easy to mishear as each other (English, Hindi, Telugu number words). */
const SOUND_ALIKE: [number, number][] = [
  [13, 30], [14, 40], [15, 50], [16, 60], [17, 70], [18, 80], [19, 90], // fifteen / fifty …
  [7, 60], [7, 70], // सात / साठ, ఏడు / డెబ్బై
  [6, 60], [5, 50], [4, 40], [8, 80], [9, 90], // ఆరు / అరవై, ఐదు / యాభై, chaar / chaalis …
  [25, 50], [35, 50], // पच्चीस / पचास, पैंतीस / पचास
];

function soundAlikes(paise: Paise): Paise[] {
  if (paise % 100 !== 0) {
    return [];
  }
  const r = paise / 100;
  return SOUND_ALIKE.flatMap(([a, b]) => (a === r ? [b] : b === r ? [a] : [])).map(x => x * 100);
}

/** How far apart two prices are, as a ratio of at least 1 (60 vs 16 → 3.75). */
const ratio = (a: number, b: number) => Math.max(a, b) / Math.max(1, Math.min(a, b));

export type CheckContext = {
  /** Last saved price per unit: "<priceKey(name)>|<unit>" → paise. */
  prices: Map<string, Paise>;
  /** A known customer whose name sounds almost like the matched one (from the AI), if any. */
  similarCustomerId?: string | null;
  priceKey: (name: string) => string;
};

/**
 * The first thing worth a "did you mean?" question, or null. An amount is doubted only when it
 * has a sound-alike AND the sound-alike is much closer to the usual price (the shop's own last
 * price, else the AI's estimate): rice at ₹16/kg when it is always ₹60 → "60 or 16?".
 */
export function findCheck(state: TurnState, ctx: CheckContext): TurnCheck | null {
  for (const i of state.items) {
    if (i.checked || i.qty == null || i.rate == null) {
      continue;
    }
    const field: 'rate' | 'line' = i.lineAmount != null ? 'line' : 'rate';
    const heard = field === 'line' ? i.lineAmount! : i.rate;
    const saved = ctx.prices.get(ctx.priceKey(i.localName) + '|' + i.unit) ?? ctx.prices.get(ctx.priceKey(i.name) + '|' + i.unit);
    const usualRate = saved ?? i.usualRate ?? null;
    if (!usualRate) {
      continue;
    }
    const usual = field === 'line' ? usualRate * i.qty : usualRate;
    const best = soundAlikes(heard).sort((a, b) => ratio(a, usual) - ratio(b, usual))[0];
    if (best != null && ratio(heard, usual) >= 1.8 && ratio(best, usual) <= 1.5) {
      return { kind: 'amount', itemId: i.id, field, options: [heard, best] };
    }
  }
  const similar = ctx.similarCustomerId;
  // Only for khata: there the wrong name puts the dues on the wrong person. A cash bill just goes on.
  if (state.method === 'khata' && state.customerId && !state.customerChecked && similar && similar !== state.customerId) {
    return { kind: 'customer', options: [state.customerId, similar] };
  }
  return null;
}

/** A tapped answer to the "did you mean?" question (0 = what was heard, 1 = the other one). */
export function applyChoice(prev: TurnState, choice: 0 | 1): TurnState {
  const check = prev.check;
  if (!check) {
    return prev;
  }
  const state: TurnState = { ...prev, items: prev.items.map(i => ({ ...i })), check: null };
  if (check.kind === 'customer') {
    state.customerId = check.options[choice];
    state.customerChecked = true;
    return state;
  }
  const item = state.items.find(i => i.id === check.itemId);
  if (item) {
    const value = check.options[choice];
    if (check.field === 'line') {
      item.lineAmount = value;
      item.rate = item.qty ? Math.round(value / item.qty) : item.rate;
    } else {
      item.rate = value;
    }
    item.checked = true;
  }
  return state;
}

/** The first thing still missing: a quantity, then a price. */
export function nextQuestion(state: TurnState): TurnQuestion | null {
  const noQty = state.items.find(i => i.qty == null);
  if (noQty) {
    return { itemId: noQty.id, field: 'qty' };
  }
  const noRate = state.items.find(i => i.rate == null);
  return noRate ? { itemId: noRate.id, field: 'rate' } : null;
}

export function totals(state: TurnState) {
  const subtotal = state.items.reduce((s, i) => s + (i.qty != null && i.rate != null ? lineTotal({ qty: i.qty, rate: i.rate }) : 0), 0);
  return { subtotal, total: Math.max(0, subtotal - state.discount) };
}

// ---------- spoken replies (always in the app's language) ----------

const UNIT_WORDS: Record<AppLanguage, Record<string, string>> = {
  en: { kg: 'kg', g: 'grams', L: 'litre', ml: 'ml', pc: '', packet: 'packet', dozen: 'dozen', box: 'box', bottle: 'bottle', bag: 'bag' },
  te: { kg: 'కిలో', g: 'గ్రాములు', L: 'లీటర్', ml: 'మి.లీ', pc: '', packet: 'ప్యాకెట్లు', dozen: 'డజన్లు', box: 'డబ్బాలు', bottle: 'సీసాలు', bag: 'సంచులు' },
  hi: { kg: 'किलो', g: 'ग्राम', L: 'लीटर', ml: 'मि.ली', pc: '', packet: 'पैकेट', dozen: 'दर्जन', box: 'डिब्बे', bottle: 'बोतल', bag: 'थैले' },
};

const WORDS = {
  en: {
    rupees: 'rupees',
    forCustomer: (n: string) => `Bill for ${n}.`,
    total: (t: string) => `Total ${t} rupees.`,
    oldDue: (d: string) => `Old due ${d} rupees.`,
    afterBill: (a: string) => `With this bill, ${a} rupees.`,
    confirm: 'Are these items correct?',
    askQty: (n: string) => `How much ${n}? Tell me the quantity.`,
    askRate: (n: string) => `What is the price of ${n}?`,
    retry: 'I could not catch the items. Please say them again.',
    // short read-back and one question for everything missing
    and: ' and ',
    askQtyMany: (list: string) => `How much ${list}?`,
    askRateMany: (list: string) => `Price of ${list}?`,
    items: (n: number) => (n === 1 ? '1 item' : `${n} items`),
    amount: (t: string) => `${t} rupees`,
    methods: { cash: 'cash', upi: 'UPI', khata: 'khata' },
    whichAmount: (item: string, a: string, b: string) => `${item}: ${a} or ${b} rupees?`,
    whichCustomer: (a: string, b: string) => `${a} or ${b}?`,
    dueTotal: (d: string, a: string) => `Old due ${d}, total ${a}.`,
    save: 'Save?',
  },
  te: {
    rupees: 'రూపాయలు',
    forCustomer: (n: string) => `${n} గారి బిల్లు.`,
    total: (t: string) => `మొత్తం ${t} రూపాయలు.`,
    oldDue: (d: string) => `పాత బాకీ ${d} రూపాయలు.`,
    afterBill: (a: string) => `ఈ బిల్లుతో కలిపి ${a} రూపాయలు.`,
    confirm: 'ఈ వస్తువులు సరైనవేనా?',
    askQty: (n: string) => `${n} ఎంత కావాలి? పరిమాణం చెప్పండి.`,
    askRate: (n: string) => `${n} ధర ఎంత?`,
    retry: 'వస్తువులు సరిగా వినిపించలేదు. దయచేసి మళ్ళీ చెప్పండి.',
    and: ', ',
    askQtyMany: (list: string) => `${list} ఎంత కావాలి?`,
    askRateMany: (list: string) => `${list} ధర ఎంత?`,
    items: (n: number) => `${n} వస్తువులు`,
    amount: (t: string) => `${t} రూపాయలు`,
    methods: { cash: 'నగదు', upi: 'యూపీఐ', khata: 'ఖాతా' },
    whichAmount: (item: string, a: string, b: string) => `${item}: ${a} రూపాయలా, ${b} రూపాయలా?`,
    whichCustomer: (a: string, b: string) => `${a} గారా, ${b} గారా?`,
    dueTotal: (d: string, a: string) => `పాత బాకీ ${d}, మొత్తం ${a}.`,
    save: 'సేవ్ చేయనా?',
  },
  hi: {
    rupees: 'रुपये',
    forCustomer: (n: string) => `${n} जी का बिल।`,
    total: (t: string) => `कुल ${t} रुपये।`,
    oldDue: (d: string) => `पुराना बकाया ${d} रुपये।`,
    afterBill: (a: string) => `इस बिल के साथ ${a} रुपये।`,
    confirm: 'क्या ये सामान सही हैं?',
    askQty: (n: string) => `${n} कितना चाहिए? मात्रा बताइए।`,
    askRate: (n: string) => `${n} का दाम क्या है?`,
    retry: 'सामान ठीक से सुनाई नहीं दिया। कृपया फिर से बोलिए।',
    and: ' और ',
    askQtyMany: (list: string) => `${list} कितना चाहिए?`,
    askRateMany: (list: string) => `${list} का दाम क्या है?`,
    items: (n: number) => `${n} सामान`,
    amount: (t: string) => `${t} रुपये`,
    methods: { cash: 'नकद', upi: 'यूपीआई', khata: 'खाता' },
    whichAmount: (item: string, a: string, b: string) => `${item}: ${a} रुपये या ${b} रुपये?`,
    whichCustomer: (a: string, b: string) => `${a} या ${b}?`,
    dueTotal: (d: string, a: string) => `पुराना बकाया ${d}, कुल ${a}।`,
    save: 'सेव करूँ?',
  },
} as const;

/** 12000 paise → "120", 4550 → "45.50" */
const money = (p: Paise) => (p % 100 === 0 ? String(p / 100) : (p / 100).toFixed(2));

/** 'confirmed' = the shopkeeper said yes to the read-back: the app saves the bill. */
export type ReplyKind = 'confirm' | 'question' | 'retry' | 'confirmed';

/** Everything still missing, so it can be asked in one question. */
export function missingFields(state: TurnState) {
  return {
    qty: state.items.filter(i => i.qty == null),
    // an item with a line price only needs its quantity; the rate follows from it
    rate: state.items.filter(i => i.rate == null && i.lineAmount == null),
  };
}

const joinList = (names: string[], and: string) =>
  names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')}${and}${names[names.length - 1]}`;

export function buildReply(
  state: TurnState,
  lang: AppLanguage,
  customer: { name: string; pastDues: Paise } | null,
  opts: { readAll?: boolean; customerName?: (id: string) => string | undefined } = {},
): { kind: ReplyKind; text: string } {
  const w = WORDS[lang];
  if (!state.items.length) {
    return { kind: 'retry', text: w.retry };
  }
  if (state.question) {
    const missing = missingFields(state);
    if (missing.qty.length + missing.rate.length <= 1) {
      const item = state.items.find(i => i.id === state.question!.itemId)!;
      return { kind: 'question', text: state.question.field === 'qty' ? w.askQty(item.localName) : w.askRate(item.localName) };
    }
    const asks = [
      missing.qty.length ? w.askQtyMany(joinList(missing.qty.map(i => i.localName), w.and)) : '',
      missing.rate.length ? w.askRateMany(joinList(missing.rate.map(i => i.localName), w.and)) : '',
    ];
    return { kind: 'question', text: asks.filter(Boolean).join(' ') };
  }
  const check = state.check;
  if (check?.kind === 'amount') {
    const item = state.items.find(i => i.id === check.itemId);
    if (item) {
      // the likely one first: "Rice: 60 or 16 rupees?"
      return { kind: 'question', text: w.whichAmount(item.localName, money(check.options[1]), money(check.options[0])) };
    }
  } else if (check?.kind === 'customer') {
    const [a, b] = check.options.map(id => opts.customerName?.(id) ?? '');
    if (a && b) {
      return { kind: 'question', text: w.whichCustomer(a, b) };
    }
  }
  const { total } = totals(state);
  if (!opts.readAll) {
    // Short read-back: the items are on screen, so only the count, total and method are spoken.
    const head = [customer?.name, w.items(state.items.length), w.amount(money(total)), state.method ? w.methods[state.method] : '']
      .filter(Boolean)
      .join(', ');
    const due = customer && customer.pastDues > 0 && state.method === 'khata' ? ` ${w.dueTotal(money(customer.pastDues), money(customer.pastDues + total))}` : '';
    return { kind: 'confirm', text: `${head}.${due} ${w.save}` };
  }
  const units = UNIT_WORDS[lang];
  const lines = state.items.map(i => {
    const unit = units[i.unit] ?? i.unit;
    const amount = money(lineTotal({ qty: i.qty!, rate: i.rate! }));
    return `${i.qty}${unit ? ` ${unit}` : ''} ${i.localName}, ${amount} ${w.rupees}`;
  });
  const parts = [customer ? w.forCustomer(customer.name) : '', `${lines.join('. ')}.`, w.total(money(total))];
  if (customer && customer.pastDues > 0) {
    parts.push(w.oldDue(money(customer.pastDues)));
    if (state.method === 'khata') {
      parts.push(w.afterBill(money(customer.pastDues + total)));
    }
  }
  parts.push(w.confirm);
  return { kind: 'confirm', text: parts.filter(Boolean).join(' ') };
}

/** Nothing was heard: ask to say it again. */
export const retryReply = (lang: AppLanguage): { kind: ReplyKind; text: string } => ({ kind: 'retry', text: WORDS[lang].retry });
