import { Router } from 'express';
import { z } from 'zod';
import { LANGUAGES, Shopkeeper, type ShopkeeperDoc } from '../models/Shopkeeper.js';
import { shopId } from '../middleware/auth.js';
import { HttpError } from '../lib/errors.js';

const router = Router();

async function loadShop(id: string): Promise<ShopkeeperDoc> {
  const shop = await Shopkeeper.findById(id);
  if (!shop) {
    throw new HttpError(401, 'Account not found');
  }
  return shop;
}

// Profile plus today's / weekly / dues totals (stale day/week totals show as 0).
router.get('/me', async (req, res) => {
  const shop = await loadShop(shopId(req));
  res.json({ shopkeeper: shop.rollStats() });
});

const patchBody = z.object({
  shopName: z.string().trim().min(1).max(100).optional(),
  shopkeeperName: z.string().trim().min(1).max(100).optional(),
  upiId: z.string().trim().max(100).optional(),
  language: z.enum(LANGUAGES).optional(),
});

router.patch('/me', async (req, res) => {
  const patch = patchBody.parse(req.body);
  const shop = await loadShop(shopId(req));
  shop.set(patch);
  await shop.save();
  res.json({ shopkeeper: shop.rollStats() });
});

export default router;
