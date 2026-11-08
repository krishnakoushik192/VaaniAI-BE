import { Router } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { Customer, RECENT_LIMIT, type IRecentTransaction } from '../models/Customer.js';
import { Shopkeeper } from '../models/Shopkeeper.js';
import { shopId } from '../middleware/auth.js';
import { HttpError } from '../lib/errors.js';
import { billTotal } from '../lib/money.js';

const router = Router();

const txnId = z.string().trim().min(1).max(100);
const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid customer id');

const item = z.object({
  name: z.string().trim().min(1).max(100),
  qty: z.number().positive(),
  unit: z.string().trim().max(20).optional(),
  rate: z.number().int().min(0), // paise per unit
});

const body = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('bill'),
    txnId,
    customerId: objectId.optional(), // omitted → walk-in sale
    method: z.enum(['cash', 'upi', 'khata']), // khata = on credit, adds to dues
    items: z.array(item).min(1).max(100),
    discount: z.number().int().min(0).default(0),
    billNo: z.string().trim().max(30).optional(),
  }),
  z.object({
    kind: z.literal('payment'),
    txnId,
    customerId: objectId,
    method: z.enum(['cash', 'upi']),
    amount: z.number().int().positive(), // paise
  }),
]);

/**
 * POST /api/transactions — record a bill or a dues payment.
 * Updates the customer (pastDues + last 3 transactions) and the shop totals
 * together in one MongoDB transaction, so they can never disagree.
 */
router.post('/', async (req, res) => {
  const input = body.parse(req.body);
  const owner = shopId(req);

  const result = await mongoose.connection.transaction(async session => {
    const now = new Date();
    const shop = await Shopkeeper.findById(owner).session(session);
    if (!shop) {
      throw new HttpError(401, 'Account not found');
    }

    const customer = input.customerId
      ? await Customer.findOne({ _id: input.customerId, shopkeeperId: shop._id }).session(session)
      : await Customer.findOneAndUpdate(
          { shopkeeperId: shop._id, isWalkinCustomer: true },
          { $setOnInsert: { customerName: 'Walk-in' } },
          { upsert: true, new: true, setDefaultsOnInsert: true, session },
        );
    if (!customer) {
      throw new HttpError(404, 'Customer not found');
    }

    // Same txnId again (e.g. the app retried after a network drop): return it, don't add it twice.
    const existing = customer.recentTransactions.find(t => t.txnId === input.txnId);
    if (existing) {
      return { status: 200, transaction: existing, customer, shopkeeper: shop.rollStats(now) };
    }

    let entry: IRecentTransaction;
    shop.rollStats(now);
    if (input.kind === 'bill') {
      if (input.method === 'khata' && customer.isWalkinCustomer) {
        throw new HttpError(400, 'Credit (khata) needs a named customer, not walk-in');
      }
      const { total } = billTotal(input.items, input.discount);
      entry = {
        txnId: input.txnId,
        kind: 'bill',
        method: input.method,
        amount: total,
        items: input.items,
        discount: input.discount,
        billNo: input.billNo,
        createdAt: now,
      };
      shop.todaysBill += total;
      shop.weeklyBill += total;
      if (input.method === 'khata' && total > 0) {
        customer.pastDues += total;
        customer.dueSince ??= now;
        shop.todaysDues += total;
        shop.duesTotal += total;
      }
    } else {
      if (input.amount > customer.pastDues) {
        throw new HttpError(400, `Payment is more than the pending dues (${customer.pastDues} paise)`);
      }
      entry = { txnId: input.txnId, kind: 'payment', method: input.method, amount: input.amount, createdAt: now };
      customer.pastDues -= input.amount;
      if (customer.pastDues === 0) {
        customer.dueSince = undefined;
      }
      shop.duesTotal = Math.max(0, shop.duesTotal - input.amount);
    }

    customer.recentTransactions.push(entry);
    while (customer.recentTransactions.length > RECENT_LIMIT) {
      customer.recentTransactions.shift();
    }

    await customer.save({ session });
    await shop.save({ session });
    return { status: 201, transaction: entry, customer, shopkeeper: shop };
  });

  const { status, ...payload } = result;
  res.status(status).json(payload);
});

export default router;
