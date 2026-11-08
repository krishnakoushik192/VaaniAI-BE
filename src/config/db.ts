import dns from 'node:dns';
import mongoose from 'mongoose';

// Some Indian ISPs' DNS servers fail the SRV lookup that "mongodb+srv://" needs,
// so local runs use Google DNS. Vercel's DNS works fine, so it's left alone there.
if (!process.env.VERCEL) {
  dns.setServers(['8.8.8.8', '8.8.4.4']);
}

type MongoCache = { conn: typeof mongoose | null; promise: Promise<typeof mongoose> | null };

declare global {
  // eslint-disable-next-line no-var
  var __vanniMongo: MongoCache | undefined;
}

// On Vercel each function instance is reused between requests, so the
// connection is cached on globalThis instead of reconnecting every time.
const cached: MongoCache = globalThis.__vanniMongo ?? (globalThis.__vanniMongo = { conn: null, promise: null });

export async function connectDB(): Promise<typeof mongoose> {
  if (cached.conn) {
    return cached.conn;
  }
  if (!cached.promise) {
    const uri = process.env.MONGODB_URI;
    if (!uri) {
      throw new Error('MONGODB_URI is not set');
    }
    cached.promise = mongoose
      .connect(uri, {
        dbName: process.env.MONGODB_DB || 'vanni',
        serverSelectionTimeoutMS: 10_000,
        maxPoolSize: 10,
      })
      .catch(err => {
        cached.promise = null; // let the next request retry
        throw err;
      });
  }
  cached.conn = await cached.promise;
  return cached.conn;
}
