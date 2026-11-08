// Entry point. On Vercel the exported app is the serverless handler;
// locally (npm run dev) it also starts a normal HTTP server.
import app from './app.js';

if (!process.env.VERCEL) {
  const port = Number(process.env.PORT) || 4000;
  app.listen(port, () => console.log(`vanni-backend listening on http://localhost:${port}`));
}

export default app;
