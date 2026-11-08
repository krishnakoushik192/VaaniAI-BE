import type { Request, RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import { HttpError } from '../lib/errors.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by requireAuth. */
      shopkeeperId?: string;
    }
  }
}

function secret(): string {
  const s = process.env.JWT_SECRET;
  if (!s || s === 'change-me') {
    throw new Error('JWT_SECRET is not set');
  }
  return s;
}

export const signToken = (shopkeeperId: string): string =>
  jwt.sign({ sub: shopkeeperId }, secret(), { expiresIn: '30d' });

/** Requires "Authorization: Bearer <token>" and sets req.shopkeeperId. */
export const requireAuth: RequestHandler = (req, _res, next) => {
  const [scheme, token] = (req.headers.authorization || '').split(' ');
  if (scheme !== 'Bearer' || !token) {
    throw new HttpError(401, 'Login required');
  }
  let payload: string | jwt.JwtPayload;
  try {
    payload = jwt.verify(token, secret());
  } catch {
    throw new HttpError(401, 'Session expired, please log in again');
  }
  if (typeof payload === 'string' || !payload.sub) {
    throw new HttpError(401, 'Invalid token');
  }
  req.shopkeeperId = payload.sub;
  next();
};

/** The logged-in shopkeeper's id, for routes behind requireAuth. */
export function shopId(req: Request): string {
  if (!req.shopkeeperId) {
    throw new HttpError(401, 'Login required');
  }
  return req.shopkeeperId;
}
