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

  // 6b. Saying "yes" to the short read-back saves (the bill is unchanged)
  assert.equal(r.reply.kind, 'confirm');
  const before = r.totals.total;
  r = await say('అవును, సరే');
  assert.equal(r.reply.kind, 'confirmed');
  assert.equal(r.totals.total, before);
  console.log('✔ spoken "yes" confirms the bill\n');

  // 7. Hindi app, price missing → asks the price
  state = null;
  r = await say('दो किलो प्याज़ और एक साबुन चालीस रुपये', 'hi');
  assert.equal(r.reply.kind, 'question');
  assert.equal(r.state.question.field, 'rate');
  r = await say('प्याज़ तीस रुपये किलो', 'hi');
  assert.equal(r.reply.kind, 'confirm');
  assert.equal(r.totals.total, 2 * 3000 + 4000);
  console.log('✔ Hindi: missing price asked and filled\n');

  // 7b. Several prices missing → asked in one question, answered in one go
  state = null;
  r = await say('2 kg rice, 1 litre oil, 1 kg sugar, cash', 'en');
  assert.equal(r.reply.kind, 'question');
  assert.match(r.reply.text, /^Price of .+, .+ and .+\?$/);
  r = await say('rice 60 a kilo, oil 145, sugar 45', 'en');
  assert.equal(r.reply.kind, 'confirm');
  assert.equal(r.totals.total, 12000 + 14500 + 4500);
  console.log('✔ one question for three missing prices\n');

  // 7c. "Did you mean?": rice at ₹16/kg (no saved price yet, so the AI's usual price is used)
  state = null;
  r = await say('2 kg rice 16 rupees a kilo, 1 soap 40, cash', 'en');
  assert.equal(r.state.check?.kind, 'amount', JSON.stringify(r.state));
  assert.match(r.reply.text, /Rice: 60 or 16 rupees\?/i);
  r = await say('yes', 'en'); // "yes" is not an answer to "60 or 16?": nothing is saved
  assert.notEqual(r.reply.kind, 'confirmed');
  r = await say('sixty', 'en');
  assert.equal(item(r, 'rice').rate, 6000);
  assert.equal(r.state.check, null);
  assert.equal(r.reply.kind, 'confirm');
  console.log('✔ did you mean: ₹16 rice asked as "60 or 16?", answered by voice\n');

  // 7d. The same in Hindi: चीनी (sugar) at ₹15/kg → "50 या 15?", answered "पचास"
  state = null;
  r = await say('दो किलो चीनी पंद्रह रुपये किलो, नकद', 'hi');
  assert.equal(r.state.check?.kind, 'amount', JSON.stringify(r.state));
  assert.match(r.reply.text, /50 रुपये या 15 रुपये\?/);
  r = await say('पचास', 'hi');
  assert.equal(r.state.items[0].rate, 5000);
  assert.equal(r.reply.kind, 'confirm');
  console.log('✔ did you mean in Hindi: "50 या 15?" answered by voice\n');

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
  // Telugu speech with the app in English: item names in Telugu script, never Hindi letters
  for (const i of audioTurn.state.items) {
    assert.match(i.localName, /[ఀ-౿]/, `expected a Telugu name, got ${i.localName}`);
    assert.doesNotMatch(i.localName, /[ऀ-ॿ]/);
  }
  console.log('✔ audio turn with English reply, Telugu item names\n');

  // 9. First turn exactly as older apps send it: form-data state "null" (was a 400 bug),
  //    then a follow-up turn whose state is the form-data JSON from the previous answer.
  const form2 = new FormData();
  form2.append('audio', new Blob([await readFile('test-audio/te-mixed.wav')], { type: 'audio/wav' }), 'r.wav');
  form2.append('state', 'null');
  form2.append('language', 'te');
  const first: any = await (await fetch(`${base}/voice/turn`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form2 })).json();
  assert.equal(first.reply?.kind, 'confirm', JSON.stringify(first));
  const form3 = new FormData();
  form3.append('audio', new Blob([await readFile('test-audio/te-mixed.wav')], { type: 'audio/wav' }), 'r.wav');
  form3.append('state', JSON.stringify(first.state));
  form3.append('language', 'te');
  const second = await fetch(`${base}/voice/turn`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form3 });
  assert.equal(second.status, 200);
  console.log('✔ form-data first turn with state "null", then a follow-up turn\n');

  // 10. Two customers whose names sound alike: asked on khata only, never on cash
  await post('/customers', { customerName: 'Rajesh' });
  state = null;
  r = await say('Rajesh, 1 soap 40 rupees, cash', 'en');
  assert.equal(r.state.check ?? null, null);
  state = null;
  r = await say('Rajesh, 1 soap 40 rupees, khata', 'en');
  assert.equal(r.state.check?.kind, 'customer', JSON.stringify(r.state));
  assert.match(r.reply.text, /Rajesh or Ramesh\?|Ramesh or Rajesh\?/);
  r = await say('Rajesh', 'en');
  assert.equal(r.customer?.name, 'Rajesh');
  assert.equal(r.state.check, null);
  console.log('✔ did you mean: Ramesh or Rajesh asked on khata (not on cash) and answered\n');

  console.log('All conversation checks passed.');
} finally {
  server.close();
  const { default: mongoose } = await import('mongoose');
  await mongoose.disconnect();
  await mongo.stop();
}
