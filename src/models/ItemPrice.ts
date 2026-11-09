import mongoose, { Schema } from 'mongoose';
import type { Paise } from '../lib/money.js';

// The last price each shop charged for an item, per unit. Filled in when a bill is saved and read
// by the voice bill to notice a price that was probably misheard ("16" when rice is always 60).

export interface IItemPrice {
  shopkeeperId: mongoose.Types.ObjectId;
  key: string; // item name as saved on the bill, lower-case and trimmed
  unit: string;
  rate: Paise;
  updatedAt: Date;
}

const itemPriceSchema = new Schema<IItemPrice>(
  {
    shopkeeperId: { type: Schema.Types.ObjectId, ref: 'Shopkeeper', required: true },
    key: { type: String, required: true, maxlength: 100 },
    unit: { type: String, required: true, maxlength: 20 },
    rate: { type: Number, required: true, min: 0 },
  },
  { timestamps: { createdAt: false, updatedAt: true } },
);
itemPriceSchema.index({ shopkeeperId: 1, key: 1, unit: 1 }, { unique: true });

export const ItemPrice = mongoose.model<IItemPrice>('ItemPrice', itemPriceSchema);

export const priceKey = (name: string) => name.trim().toLowerCase().replace(/\s+/g, ' ');

/** Remember this bill's prices (best effort: a failure here never fails the bill). */
export async function rememberPrices(shopkeeperId: string, items: { name: string; unit?: string; rate: Paise }[]) {
  const ops = items
    .filter(i => i.rate > 0)
    .map(i => ({
      updateOne: {
        filter: { shopkeeperId, key: priceKey(i.name), unit: i.unit || 'pc' },
        update: { $set: { rate: i.rate } },
        upsert: true,
      },
    }));
  if (ops.length) {
    await ItemPrice.bulkWrite(ops, { ordered: false }).catch(err => console.error('rememberPrices failed', err));
  }
}

/** Last known price per unit for each of these names: Map of `${key}|${unit}` → rate. */
export async function knownPrices(shopkeeperId: string, names: string[]) {
  const keys = [...new Set(names.map(priceKey).filter(Boolean))];
  const map = new Map<string, Paise>();
  if (!keys.length) {
    return map;
  }
  const docs = await ItemPrice.find({ shopkeeperId, key: { $in: keys } }).select('key unit rate').lean();
  for (const d of docs) {
    map.set(`${d.key}|${d.unit}`, d.rate);
  }
  return map;
}
