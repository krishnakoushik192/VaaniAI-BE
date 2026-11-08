// "Code counts the money": all amounts are integer paise (₹1 = 100), and every
// total is computed here, never taken from the client or from an LLM.

export type Paise = number;

export type PricedItem = { qty: number; rate: Paise };

export const lineTotal = (item: PricedItem): Paise => Math.round(item.qty * item.rate);

/** ₹1,25,000.50 (Indian digit grouping), for human-readable messages. */
export function formatINR(p: Paise): string {
  const sign = p < 0 ? '-' : '';
  const abs = Math.abs(p);
  const whole = String(Math.floor(abs / 100));
  const frac = abs % 100;
  const grouped =
    whole.length > 3 ? `${whole.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${whole.slice(-3)}` : whole;
  return `${sign}₹${grouped}${frac ? `.${String(frac).padStart(2, '0')}` : ''}`;
}

export function billTotal(items: PricedItem[], discount: Paise = 0): { subtotal: Paise; total: Paise } {
  const subtotal = items.reduce((sum, item) => sum + lineTotal(item), 0);
  return { subtotal, total: Math.max(0, subtotal - discount) };
}
