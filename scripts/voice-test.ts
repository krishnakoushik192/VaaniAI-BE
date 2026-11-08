// Live end-to-end voice test with your REAL Gnani + Gemini keys, against a
// throwaway in-memory MongoDB (nothing is written to Atlas).
// Run: npm run make-audio   (once, creates test-audio/*.wav)
//      npm run voice-test
import { readdir, readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

for (const k of ['GNANI_API_KEY', 'LLM_API_KEY']) {
  if (!process.env[k]) {
    console.error(`${k} is not set in .env`);
    process.exit(1);
  }
}

const mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
process.env.MONGODB_URI = mongo.getUri();
process.env.JWT_SECRET ||= 'voice-test-secret';
process.env.VERCEL = '1'; // don't auto-listen on PORT

const { default: app } = await import('../src/index.ts');
const server = app.listen(0);
const base = `http://localhost:${(server.address() as AddressInfo).port}/api`;
let token = '';

async function call(method: string, path: string, body?: unknown | FormData) {
  const isForm = body instanceof FormData;
  const res = await fetch(base + path, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(!isForm && body !== undefined && { 'content-type': 'application/json' }) },
    body: isForm ? body : body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

const rupees = (p: number | null) => (p == null ? '  ?   ' : `₹${(p / 100).toFixed(2)}`);

try {
  let r = await call('POST', '/auth/register', {
    shopName: 'Test Kirana',
    shopkeeperName: 'Tester',
    mobileNumber: '9000000001',
    passcode: '1234',
    language: 'te',
  });
  token = r.body.token;
  r = await call('POST', '/customers', { customerName: 'Ramesh', phoneNumber: '9000000011', openingDue: 50000 });
  const ramesh = r.body.customer;
  await call('POST', '/customers', { customerName: 'Lakshmi Devi' });
  console.log('Shop + customers (Ramesh, Lakshmi Devi) created in the in-memory DB\n');

  const files = (await readdir('test-audio').catch(() => [])).filter(f => /\.(wav|mp3|m4a|ogg|flac|aac)$/i.test(f));
  if (!files.length) {
    console.error('No clips in test-audio/. Run "npm run make-audio" first.');
  }

  let firstDraft: any = null;
  for (const file of files) {
    const form = new FormData();
    form.append('audio', new Blob([await readFile(`test-audio/${file}`)], { type: 'audio/wav' }), file);
    const t = Date.now();
    r = await call('POST', '/voice/bill', form);
    console.log(`━━ ${file}  HTTP ${r.status}  ${Date.now() - t} ms`);
    if (r.status !== 200) {
      console.log('  ', r.body);
      continue;
    }
    const { transcript, detectedLanguage, draft, timings } = r.body;
    console.log(`  heard (${detectedLanguage}): ${transcript}`);
    console.log(`  customer: ${draft.customer?.customerName ?? '-'} (spoken: ${draft.spokenCustomerName ?? '-'})   method: ${draft.method ?? '-'}`);
    for (const i of draft.items) {
      console.log(`   ${i.needsCheck ? '⚠' : '•'} ${i.name.padEnd(16)} ${String(i.qty).padStart(5)} ${i.unit.padEnd(6)} × ${rupees(i.rate).padStart(9)} = ${rupees(i.lineTotal).padStart(9)}  ${i.notes.join('; ')}`);
    }
    console.log(`  total ${rupees(draft.total)}   needsCheck ${draft.needsCheck}   stt ${timings.sttMs} ms, llm ${timings.llmMs} ms`);
    if (draft.warnings.length) {
      console.log(`  warnings: ${draft.warnings.join(' | ')}`);
    }
    console.log();
    if (!firstDraft && draft.customer && draft.method === 'khata' && !draft.needsCheck) {
      firstDraft = draft;
    }
  }

  r = await call('POST', '/voice/extract', { transcript: 'Lakshmi ki do dozen ande, 84 rupaye dozen, aur ek Surf packet 120, UPI se diya' });
  console.log(`━━ /voice/extract (text)  HTTP ${r.status}`);
  for (const i of r.body.draft?.items ?? []) {
    console.log(`   • ${i.name} ${i.qty} ${i.unit} × ${rupees(i.rate)} = ${rupees(i.lineTotal)}`);
  }
  console.log(`  customer: ${r.body.draft?.customer?.customerName ?? '-'}  method: ${r.body.draft?.method}  total ${rupees(r.body.draft?.total)}\n`);

  if (firstDraft) {
    r = await call('POST', '/transactions', {
      kind: 'bill',
      txnId: `voice_${Date.now()}`,
      customerId: firstDraft.customer.id,
      method: 'khata',
      items: firstDraft.items.map((i: any) => ({ name: i.name, qty: i.qty, unit: i.unit, rate: i.rate })),
      discount: firstDraft.discount,
    });
    console.log(`━━ saved the first khata draft as a bill: HTTP ${r.status}, Ramesh now owes ${rupees(r.body.customer?.pastDues)} (was ${rupees(ramesh.pastDues)})`);
  }
} finally {
  server.close();
  const { default: mongoose } = await import('mongoose');
  await mongoose.disconnect();
  await mongo.stop();
}
