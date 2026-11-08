// Live test of the voice-bill conversation (POST /api/voice/turn) with the REAL Gemini key,
// against a throwaway in-memory MongoDB. Run: npm run conversation-test
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

const mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
process.env.MONGODB_URI = mongo.getUri();
process.env.JWT_SECRET ||= 'conversation-test-secret';
process.env.VERCEL = '1';

const { default: app } = await import('../src/index.ts');
const server = app.listen(0);
const base = `http://localhost:${(server.address() as AddressInfo).port}/api`;
let token = '';

const post = async (path: string, body: unknown) => {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
};

let state: unknown = null;
const show = (r: any) => {
  const items = r.state.items.map((i: any) => `${i.localName}(${i.name}) ${i.qty ?? '?'} ${i.unit} × ${i.rate == null ? '?' : i.rate / 100}`).join(' | ');
  console.log(`   items: ${items}`);
  console.log(`   total ₹${r.totals.total / 100}   customer ${r.customer?.name ?? '-'}   method ${r.state.method ?? '-'}`);
  console.log(`   🔊 [${r.reply.kind}] ${r.reply.text}\n`);
};
async function say(text: string, language: 'te' | 'hi' | 'en' = 'te') {
  console.log(`🗣  ${text}`);
  const r = await post('/voice/turn', { text, state, language });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  state = r.body.state;
  show(r.body);
  return r.body;
}
const item = (r: any, name: string) => r.state.items.find((i: any) => i.name.toLowerCase().includes(name));

try {
  token = (await post('/auth/register', { shopName: 'Test', shopkeeperName: 'T', mobileNumber: '9000000001', passcode: '1234', language: 'te' })).body.token;
  await post('/customers', { customerName: 'Ramesh', openingDue: 351600 });

  // 1. First bill, sugar quantity missing → question
  let r = await say('రమేష్ గారు, మూడు కేజీల బియ్యం కేజీ డెబ్బై రూపాయలు, చక్కెర కేజీ నలభై రూపాయలు, one litre oil నూట నలభై ఐదు, ఖాతాలో రాయండి');
  assert.equal(r.customer?.name, 'Ramesh');
  assert.equal(r.state.method, 'khata');
  assert.equal(r.reply.kind, 'question');
  assert.equal(r.state.question.field, 'qty');
  assert.equal(item(r, 'sugar').qty, null);

  // 2. Answer the question
  r = await say('ఐదు కేజీలు');
  assert.equal(item(r, 'sugar').qty, 5);
  assert.equal(r.reply.kind, 'confirm');
  assert.equal(r.totals.total, 21000 + 20000 + 14500);
  assert.match(r.reply.text, /3,?516|3516/);

  // 3. "No" → extra items
  r = await say('ఇంకా రెండు ప్యాకెట్ల పాలు ఒక్కొక్కటి ఇరవై ఏడు రూపాయలు');
  assert.equal(item(r, 'milk').qty, 2);
  assert.equal(item(r, 'milk').rate, 2700);
  assert.equal(r.state.items.length, 4);

  // 4. Price correction
  r = await say('బియ్యం డెబ్బై కాదు, అరవై ఐదు');
  assert.equal(item(r, 'rice').rate, 6500);
  assert.equal(item(r, 'rice').qty, 3);

  // 5. Remove an item
  r = await say('oil వద్దు, తీసేయండి');
  assert.equal(item(r, 'oil'), undefined);

  // 6. Quantity correction in English
  r = await say('sugar only 3 kg');
  assert.equal(item(r, 'sugar').qty, 3);
  assert.equal(r.totals.total, 3 * 6500 + 3 * 4000 + 2 * 2700);
  console.log(`✔ Telugu conversation: final total ₹${r.totals.total / 100}\n`);

  // 7. Hindi app, price missing → asks the price
  state = null;
  r = await say('दो किलो प्याज़ और एक साबुन चालीस रुपये', 'hi');
  assert.equal(r.reply.kind, 'question');
  assert.equal(r.state.question.field, 'rate');
  r = await say('प्याज़ तीस रुपये किलो', 'hi');
  assert.equal(r.reply.kind, 'confirm');
  assert.equal(r.totals.total, 2 * 3000 + 4000);
  console.log('✔ Hindi: missing price asked and filled\n');

  // 8. English app with a real recording (audio upload path)
  state = null;
  const form = new FormData();
  form.append('audio', new Blob([await readFile('test-audio/te-mixed.wav')], { type: 'audio/wav' }), 'te-mixed.wav');
  form.append('language', 'en');
  const res = await fetch(`${base}/voice/turn`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form });
  const audioTurn: any = await res.json();
  console.log(`🎙  (audio) heard: ${audioTurn.transcript}`);
  show(audioTurn);
  assert.equal(res.status, 200);
  assert.equal(audioTurn.reply.kind, 'confirm');
  assert.equal(audioTurn.totals.total, 12000 + 14500);
  console.log('✔ audio turn with English reply\n');

  console.log('All conversation checks passed.');
} finally {
  server.close();
  const { default: mongoose } = await import('mongoose');
  await mongoose.disconnect();
  await mongo.stop();
}
