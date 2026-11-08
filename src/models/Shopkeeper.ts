import mongoose, { Schema, type HydratedDocument, type Model } from 'mongoose';
import { istDayKey, istWeekKey } from '../lib/dates.js';
import type { Paise } from '../lib/money.js';
import { cleanJSON } from '../lib/toJSON.js';

export const LANGUAGES = ['te', 'hi', 'en'] as const;
export type Language = (typeof LANGUAGES)[number];

export interface IShopkeeper {
  shopName: string;
  shopkeeperName: string;
  mobileNumber: string;
  passcodeHash: string;
  upiId?: string;
  language: Language;
  weeklyBill: Paise;
  todaysBill: Paise;
  duesTotal: Paise;
  todaysDues: Paise;
  statsDay: string;
  statsWeek: string;
  failedLogins: number;
  lockedUntil?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

interface ShopkeeperMethods {
  rollStats(now?: Date): ShopkeeperDoc;
}

type ShopkeeperModel = Model<IShopkeeper, object, ShopkeeperMethods>;
export type ShopkeeperDoc = HydratedDocument<IShopkeeper, ShopkeeperMethods>;

const paise = { type: Number, default: 0, validate: Number.isInteger };

const shopkeeperSchema = new Schema<IShopkeeper, ShopkeeperModel, ShopkeeperMethods>(
  {
    shopName: { type: String, required: true, trim: true, maxlength: 100 },
    shopkeeperName: { type: String, required: true, trim: true, maxlength: 100 },
    mobileNumber: { type: String, required: true, unique: true, match: /^[6-9]\d{9}$/ },
    // Only a bcrypt hash is stored, never the passcode itself.
    passcodeHash: { type: String, required: true, select: false },
    upiId: { type: String, trim: true, maxlength: 100 },
    language: { type: String, enum: LANGUAGES, default: 'en' },

    // Running totals, all in paise. today's/weekly reset when the IST day/week changes.
    weeklyBill: paise, // all bills this week (Mon–Sun)
    todaysBill: paise, // all bills today
    duesTotal: paise, // what all customers owe right now
    todaysDues: paise, // new credit (khata) given today
    statsDay: { type: String, default: () => istDayKey() },
    statsWeek: { type: String, default: () => istWeekKey() },

    // Passcodes are short, so repeated wrong guesses lock the account for a while.
    failedLogins: { type: Number, default: 0, select: false },
    lockedUntil: { type: Date, select: false },
  },
  {
    timestamps: true,
    toJSON: {
      transform: cleanJSON('passcodeHash', 'failedLogins', 'lockedUntil', 'statsDay', 'statsWeek'),
    },
  },
);

/** Zero today's/weekly totals if the stored ones belong to an earlier day/week. */
shopkeeperSchema.method('rollStats', function rollStats(this: ShopkeeperDoc, now: Date = new Date()) {
  const day = istDayKey(now);
  const week = istWeekKey(now);
  if (this.statsDay !== day) {
    this.statsDay = day;
    this.todaysBill = 0;
    this.todaysDues = 0;
  }
  if (this.statsWeek !== week) {
    this.statsWeek = week;
    this.weeklyBill = 0;
  }
  return this;
});

export const Shopkeeper = mongoose.model<IShopkeeper, ShopkeeperModel>('Shopkeeper', shopkeeperSchema);
