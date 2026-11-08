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
};

export type TurnQuestion = { itemId: string; field: 'qty' | 'rate' };

export type TurnState = {
  items: TurnItem[];
  customerId: string | null;
  method: PaymentMethod | null;
  discount: Paise;
  question: TurnQuestion | null;
};

export const emptyState = (): TurnState => ({ items: [], customerId: null, method: null, discount: 0, question: null });

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

export function applyEdits(prev: TurnState, edits: TurnEdits, knownCustomerIds: Set<string>): TurnState {
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
        localName: (op.localName ?? name).trim(),
        qty: op.qtySpoken ? positive(op.qty) : null,
        unit: op.unit ?? 'pc',
        rate: op.ratePerUnit != null && op.ratePerUnit >= 0 ? toPaise(op.ratePerUnit) : null,
        lineAmount: op.lineAmount != null && op.lineAmount >= 0 ? toPaise(op.lineAmount) : null,
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
        item.localName = op.localName.trim();
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
      if (op.ratePerUnit != null && op.ratePerUnit >= 0) {
        item.rate = toPaise(op.ratePerUnit);
        item.lineAmount = null;
      } else if (op.lineAmount != null && op.lineAmount >= 0) {
        item.lineAmount = toPaise(op.lineAmount);
        item.rate = null;
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
  const state: TurnState = {
    items,
    customerId,
    method: edits.paymentMethod ?? prev.method,
    discount: edits.discount != null && edits.discount >= 0 ? toPaise(edits.discount) : prev.discount,
    question: null,
  };
  state.question = nextQuestion(state);
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
  },
} as const;

/** 12000 paise → "120", 4550 → "45.50" */
const money = (p: Paise) => (p % 100 === 0 ? String(p / 100) : (p / 100).toFixed(2));

export type ReplyKind = 'confirm' | 'question' | 'retry';

export function buildReply(
  state: TurnState,
  lang: AppLanguage,
  customer: { name: string; pastDues: Paise } | null,
): { kind: ReplyKind; text: string } {
  const w = WORDS[lang];
  if (!state.items.length) {
    return { kind: 'retry', text: w.retry };
  }
  if (state.question) {
    const item = state.items.find(i => i.id === state.question!.itemId)!;
    return { kind: 'question', text: state.question.field === 'qty' ? w.askQty(item.localName) : w.askRate(item.localName) };
  }
  const units = UNIT_WORDS[lang];
  const lines = state.items.map(i => {
    const unit = units[i.unit] ?? i.unit;
    const amount = money(lineTotal({ qty: i.qty!, rate: i.rate! }));
    return `${i.qty}${unit ? ` ${unit}` : ''} ${i.localName}, ${amount} ${w.rupees}`;
  });
  const { total } = totals(state);
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
