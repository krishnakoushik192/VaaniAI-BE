// Turns the LLM's reading of a transcript into a bill draft with exact paise
// amounts. All the money maths happens here, in code.
import type { Extraction } from '../services/extract.js';
import type { PaymentMethod } from '../models/Customer.js';
import { formatINR, lineTotal, type Paise } from './money.js';

export type DraftItem = {
  name: string;
  spokenName: string;
  qty: number;
  unit: string;
  rate: Paise | null; // per unit; null = price not heard, the shopkeeper must type it
  lineTotal: Paise | null;
  needsCheck: boolean;
  notes: string[];
};

export type DraftCustomer = { id: string; customerName: string; pastDues: Paise; phoneNumber?: string };

export type BillDraft = {
  spokenCustomerName: string | null;
  customer: DraftCustomer | null; // matched existing customer, if any
  method: PaymentMethod | null;
  items: DraftItem[];
  discount: Paise;
  subtotal: Paise; // sum of the lines that have a price
  total: Paise;
  needsCheck: number; // how many lines must be confirmed before saving
  warnings: string[];
};

const toPaise = (rupees: number): Paise => Math.round(rupees * 100);

export function buildDraft(x: Extraction, customers: DraftCustomer[], forcedCustomerId?: string): BillDraft {
  const warnings: string[] = [];

  const items: DraftItem[] = x.items.map(i => {
    const notes: string[] = [];
    const qty = i.qty > 0 ? i.qty : 1;
    if (!(i.qty > 0)) {
      notes.push('Quantity not clear, assumed 1');
    }
    if (i.unsure) {
      notes.push(i.unsureReason || 'Not sure this was heard right');
    }

    let rate: Paise | null = null;
    if (i.ratePerUnit != null && i.ratePerUnit >= 0) {
      rate = toPaise(i.ratePerUnit);
      if (i.lineAmount != null) {
        const spoken = toPaise(i.lineAmount);
        const computed = lineTotal({ qty, rate });
        if (Math.abs(spoken - computed) > 100) {
          notes.push(`Said ${formatINR(spoken)} but ${qty} × ${formatINR(rate)} = ${formatINR(computed)}`);
        }
      }
    } else if (i.lineAmount != null && i.lineAmount >= 0) {
      rate = Math.round(toPaise(i.lineAmount) / qty); // per-unit rate from the line price
    } else {
      notes.push('Price not heard');
    }

    return {
      name: i.name.trim() || i.spokenName,
      spokenName: i.spokenName,
      qty,
      unit: i.unit,
      rate,
      lineTotal: rate == null ? null : lineTotal({ qty, rate }),
      needsCheck: notes.length > 0,
      notes,
    };
  });

  if (!items.length) {
    warnings.push('No items found in what was said');
  }

  const matchId = forcedCustomerId ?? x.matchedCustomerId;
  const customer = (matchId && customers.find(c => c.id === matchId)) || null;
  if (x.customerName && !customer) {
    warnings.push(`"${x.customerName}" is not in your customer list`);
  }

  let method = x.paymentMethod;
  if (method === 'khata' && !customer) {
    warnings.push('Credit (khata) needs a customer: pick or add one before saving');
  }
  if (!method) {
    method = null;
  }

  const subtotal = items.reduce((s, i) => s + (i.lineTotal ?? 0), 0);
  const discount = x.discount != null && x.discount > 0 ? toPaise(x.discount) : 0;
  if (discount > subtotal) {
    warnings.push('Discount is more than the bill');
  }

  return {
    spokenCustomerName: x.customerName,
    customer,
    method,
    items,
    discount,
    subtotal,
    total: Math.max(0, subtotal - discount),
    needsCheck: items.filter(i => i.needsCheck).length,
    warnings,
  };
}
