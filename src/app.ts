import express, { type ErrorRequestHandler } from 'express';
import cors from 'cors';
import mongoose from 'mongoose';
import { ZodError } from 'zod';
import { connectDB } from './config/db.js';
import { requireAuth } from './middleware/auth.js';
import { HttpError } from './lib/errors.js';
import authRoutes from './routes/auth.js';
import shopkeeperRoutes from './routes/shopkeeper.js';
import customerRoutes from './routes/customers.js';
import transactionRoutes from './routes/transactions.js';
import voiceRoutes from './routes/voice.js';
import multer from 'multer';

const app = express();
app.disable('x-powered-by');

const origins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
app.use(cors(origins.length ? { origin: origins } : undefined));
app.use(express.json({ limit: '200kb' }));

app.get('/', (_req, res) => {
  res.json({ name: 'vanni-backend', status: 'ok' });
});
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', db: mongoose.connection.readyState === 1 });
});

// Every /api route below needs the database.
app.use('/api', async (_req, _res, next) => {
  await connectDB();
  next();
});

app.use('/api/auth', authRoutes);
app.use('/api/shopkeeper', requireAuth, shopkeeperRoutes);
app.use('/api/customers', requireAuth, customerRoutes);
app.use('/api/transactions', requireAuth, transactionRoutes);
app.use('/api/voice', requireAuth, voiceRoutes);

app.use(() => {
  throw new HttpError(404, 'Route not found');
});

const DUPLICATE_MESSAGES: Record<string, string> = {
  mobileNumber: 'This mobile number is already registered',
  phoneNumber: 'A customer with this phone number already exists',
};

const errorHandler: ErrorRequestHandler = (err: unknown, _req, res, _next) => {
  if (err instanceof ZodError) {
    const issue = err.issues[0];
    res.status(400).json({
      error: issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'Invalid request',
      issues: err.issues,
    });
    return;
  }
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  if (err instanceof mongoose.mongo.MongoServerError && err.code === 11000) {
    const field = Object.keys(err.keyPattern ?? {}).find(k => k in DUPLICATE_MESSAGES);
    res.status(409).json({ error: (field && DUPLICATE_MESSAGES[field]) || 'Already exists' });
    return;
  }
  if (err instanceof multer.MulterError) {
    const tooBig = err.code === 'LIMIT_FILE_SIZE';
    res.status(tooBig ? 413 : 400).json({ error: tooBig ? 'Recording is too large (max 4 MB / 90 seconds)' : err.message });
    return;
  }
  if (err instanceof mongoose.Error.CastError) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  if (err instanceof mongoose.Error.ValidationError) {
    res.status(400).json({ error: Object.values(err.errors)[0]?.message || 'Invalid data' });
    return;
  }
  if (err instanceof SyntaxError && (err as { type?: string }).type === 'entity.parse.failed') {
    res.status(400).json({ error: 'Request body is not valid JSON' });
    return;
  }
  console.error(err);
  res.status(500).json({ error: 'Something went wrong' });
};
app.use(errorHandler);

export default app;
