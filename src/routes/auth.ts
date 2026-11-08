import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { LANGUAGES, Shopkeeper } from '../models/Shopkeeper.js';
import { signToken } from '../middleware/auth.js';
import { HttpError } from '../lib/errors.js';

const router = Router();

const MAX_FAILED = 5;
const LOCK_MS = 15 * 60 * 1000;

export const mobileNumber = z.string().trim().regex(/^[6-9]\d{9}$/, 'Enter a valid 10-digit mobile number');
const passcode = z.string().regex(/^\d{4,6}$/, 'Passcode must be 4 to 6 digits');

const registerBody = z.object({
  shopName: z.string().trim().min(1).max(100),
  shopkeeperName: z.string().trim().min(1).max(100),
  mobileNumber,
  passcode,
  upiId: z.string().trim().max(100).optional(),
  language: z.enum(LANGUAGES).optional(),
});

router.post('/register', async (req, res) => {
  const { passcode: pin, ...data } = registerBody.parse(req.body);
  const shopkeeper = await Shopkeeper.create({ ...data, passcodeHash: await bcrypt.hash(pin, 10) });
  res.status(201).json({ token: signToken(shopkeeper.id), shopkeeper });
});

const loginBody = z.object({ mobileNumber, passcode });

router.post('/login', async (req, res) => {
  const { mobileNumber: mobile, passcode: pin } = loginBody.parse(req.body);
  const shopkeeper = await Shopkeeper.findOne({ mobileNumber: mobile }).select('+passcodeHash +failedLogins +lockedUntil');
  if (!shopkeeper) {
    throw new HttpError(401, 'Wrong mobile number or passcode');
  }
  if (shopkeeper.lockedUntil && shopkeeper.lockedUntil > new Date()) {
    throw new HttpError(429, 'Too many wrong attempts. Try again in 15 minutes');
  }
  if (!(await bcrypt.compare(pin, shopkeeper.passcodeHash))) {
    const failed = shopkeeper.failedLogins + 1;
    await Shopkeeper.updateOne(
      { _id: shopkeeper._id },
      failed >= MAX_FAILED
        ? { failedLogins: 0, lockedUntil: new Date(Date.now() + LOCK_MS) }
        : { failedLogins: failed },
    );
    throw new HttpError(401, 'Wrong mobile number or passcode');
  }
  if (shopkeeper.failedLogins || shopkeeper.lockedUntil) {
    await Shopkeeper.updateOne({ _id: shopkeeper._id }, { failedLogins: 0, $unset: { lockedUntil: 1 } });
  }
  res.json({ token: signToken(shopkeeper.id), shopkeeper: shopkeeper.rollStats() });
});

export default router;
