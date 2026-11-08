import { Router, type Request } from 'express';
import mongoose, { type ClientSession, type FilterQuery } from 'mongoose';
import { z } from 'zod';
import { Customer, type CustomerDoc, type ICustomer } from '../models/Customer.js';
import { Shopkeeper } from '../models/Shopkeeper.js';
import { shopId } from '../middleware/auth.js';
import { HttpError } from '../lib/errors.js';
import { mobileNumber } from './auth.js';

const router = Router();

async function findOwn(req: Request<{ id: string }>, session?: ClientSession): Promise<CustomerDoc> {
  const customer = await Customer.findOne({ _id: req.params.id, shopkeeperId: shopId(req) }).session(session ?? null);
  if (!customer) {
    throw new HttpError(404, 'Customer not found');
  }
  return customer;
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// GET /api/customers?search=ram  → highest dues first
router.get('/', async (req, res) => {
  const filter: FilterQuery<ICustomer> = { shopkeeperId: shopId(req) };
  const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
  if (search) {
    const rx = new RegExp(escapeRegex(search), 'i');
    filter.$or = [{ customerName: rx }, { phoneNumber: rx }];
  }
  const customers = await Customer.find(filter).sort({ pastDues: -1, customerName: 1 }).limit(500);
  res.json({ customers });
});

const createBody = z.object({
  customerName: z.string().trim().min(1).max(100),
  phoneNumber: mobileNumber.optional(),
  openingDue: z.number().int().min(0).default(0), // paise already owed before using the app
});

router.post('/', async (req, res) => {
  const { openingDue, ...data } = createBody.parse(req.body);
  const owner = shopId(req);
  const customer = await mongoose.connection.transaction(async session => {
    const [created] = await Customer.create(
      [{ ...data, shopkeeperId: owner, pastDues: openingDue, dueSince: openingDue ? new Date() : undefined }],
      { session },
    );
    if (openingDue) {
      await Shopkeeper.updateOne({ _id: owner }, { $inc: { duesTotal: openingDue } }, { session });
    }
    return created;
  });
  res.status(201).json({ customer });
});

router.get('/:id', async (req, res) => {
  res.json({ customer: await findOwn(req) });
});

const patchBody = z.object({
  customerName: z.string().trim().min(1).max(100).optional(),
  phoneNumber: mobileNumber.nullable().optional(), // null removes it
});

router.patch('/:id', async (req, res) => {
  const { phoneNumber, ...rest } = patchBody.parse(req.body);
  const customer = await findOwn(req);
  customer.set(rest);
  if (phoneNumber === null) {
    customer.phoneNumber = undefined;
  } else if (phoneNumber) {
    customer.phoneNumber = phoneNumber;
  }
  await customer.save();
  res.json({ customer });
});

// Only customers with nothing due can be deleted, so duesTotal never goes wrong.
router.delete('/:id', async (req, res) => {
  const customer = await findOwn(req);
  if (customer.isWalkinCustomer) {
    throw new HttpError(400, 'The walk-in customer cannot be deleted');
  }
  if (customer.pastDues > 0) {
    throw new HttpError(400, 'Collect the pending dues before deleting this customer');
  }
  await customer.deleteOne();
  res.status(204).end();
});

export default router;
