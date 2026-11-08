// "Code counts the money": all amounts are integer paise (₹1 = 100), and every
// total is computed here, never taken from the client or from an LLM.

export type Paise = number;

export type PricedItem = { qty: number; rate: Paise };

export const lineTotal = (item: PricedItem): Paise => Math.round(item.qty * item.rate);

export function billTotal(items: PricedItem[], discount: Paise = 0): { subtotal: Paise; total: Paise } {
  const subtotal = items.reduce((sum, item) => sum + lineTotal(item), 0);
  return { subtotal, total: Math.max(0, subtotal - discount) };
}
