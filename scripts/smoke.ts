// End-to-end check against a throwaway in-memory MongoDB (no Atlas needed).
// Run: npm run smoke
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

const mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } }); // transactions need a replica set
process.env.MONGODB_URI = mongo.getUri();
process.env.JWT_SECRET = 'smoke-test-secret';
process.env.VERCEL = '1'; // don't auto-listen on PORT

const { default: app } = await import('../src/index.ts');
const server = app.listen(0);
const base = `http://localhost:${(server.address() as AddressInfo).port}/api`;

let token: string | undefined;
async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const step = (name: string, ok: boolean) => console.log(`${ok ? '✔' : '✘'} ${name}`);

try {
  const shop = { shopName: 'Test Kirana', shopkeeperName: 'Test Owner', mobileNumber: '9000000001', passcode: '1234' };

  let r = await call('POST', '/auth/register', shop);
  assert.equal(r.status, 201);
  assert.equal(r.body.shopkeeper.passcodeHash, undefined);
  step('register (passcode hash hidden)', true);

  r = await call('POST', '/auth/check', { mobileNumber: shop.mobileNumber });
  assert.deepEqual(r.body, { exists: true });
  r = await call('POST', '/auth/check', { mobileNumber: '9000000999' });
  assert.deepEqual(r.body, { exists: false });
  r = await call('POST', '/auth/check', { mobileNumber: '12345' });
  assert.equal(r.status, 400);
  step('account check: existing, new and invalid numbers', true);

  {
    // Voice replies (no AI needed): one question for everything missing, then the short read-back.
    const { buildReply, nextQuestion } = await import('../src/lib/billState.ts');
    const items = [
      { id: 'i1', name: 'Rice', localName: 'Rice', qty: 2, unit: 'kg', rate: 6000 },
      { id: 'i2', name: 'Oil', localName: 'Oil', qty: 1, unit: 'L', rate: null },
      { id: 'i3', name: 'Sugar', localName: 'Sugar', qty: 1, unit: 'kg', rate: null },
    ];
    const s: any = { items, customerId: null, method: 'cash', discount: 0, question: null };
    s.question = nextQuestion(s);
    assert.deepEqual(buildReply(s, 'en', null), { kind: 'question', text: 'Price of Oil and Sugar?' });
    items[1].rate = 14500;
    items[2].rate = 4500;
    s.question = nextQuestion(s);
    assert.deepEqual(buildReply(s, 'en', { name: 'Ramesh', pastDues: 30000 }), { kind: 'confirm', text: 'Ramesh, 3 items, 310 rupees, cash. Save?' });
    s.method = 'khata';
    assert.equal(buildReply(s, 'en', { name: 'Ramesh', pastDues: 30000 }).text, 'Ramesh, 3 items, 310 rupees, khata. Old due 300, total 610. Save?');
    assert.match(buildReply(s, 'en', null, { readAll: true }).text, /^2 kg Rice, 120 rupees\. 1 litre Oil, 145 rupees\./);
    assert.match(buildReply(s, 'te', null).text, /3 వస్తువులు, 310 రూపాయలు, ఖాతా\. సేవ్ చేయనా\?/);
    assert.match(buildReply(s, 'hi', null).text, /3 सामान, 310 रुपये, खाता\. सेव करूँ\?/);
    step('voice replies: combined question, short read-back in en/te/hi, full read-back on request', true);
  }

  r = await call('POST', '/auth/register', shop);
  assert.equal(r.status, 409);
  step('duplicate mobile rejected', true);

  r = await call('POST', '/auth/login', { mobileNumber: shop.mobileNumber, passcode: '1234' });
  assert.equal(r.status, 200);
  token = r.body.token;
  step('login', true);

  r = await call('POST', '/customers', { customerName: 'Ramesh', phoneNumber: '9000000011', openingDue: 50000 });
  assert.equal(r.status, 201);
  const ramesh = r.body.customer;
  assert.equal(ramesh.pastDues, 50000);
  step('add customer with ₹500 opening due', true);

  // 2 kg rice @ ₹60 + 1 L oil @ ₹145.50, ₹10.50 off → 12000 + 14550 − 1050 = 25500 paise
  const bill = {
    kind: 'bill',
    txnId: 'bill_1',
    customerId: ramesh.id,
    method: 'khata',
    discount: 1050,
    items: [
      { name: 'Rice', qty: 2, unit: 'kg', rate: 6000 },
      { name: 'Oil', qty: 1, unit: 'L', rate: 14550 },
    ],
  };
  r = await call('POST', '/transactions', bill);
  assert.equal(r.status, 201);
  assert.equal(r.body.transaction.amount, 25500);
  assert.equal(r.body.customer.pastDues, 75500);
  assert.equal(r.body.shopkeeper.todaysBill, 25500);
  assert.equal(r.body.shopkeeper.todaysDues, 25500);
  assert.equal(r.body.shopkeeper.duesTotal, 75500);
  step('khata bill: server computes total, dues + shop totals update', true);

  {
    // "Did you mean?": the bill above saved Rice at ₹60/kg. A voice bill that hears ₹16/kg rice
    // asks "60 or 16?"; a tapped choice fixes it without speech or AI; ₹62 is not doubted.
    const { findCheck } = await import('../src/lib/billState.ts');
    const { knownPrices, priceKey } = await import('../src/models/ItemPrice.ts');
    const prices = await knownPrices(r.body.shopkeeper.id, ['Rice']);
    assert.equal(prices.get('rice|kg'), 6000);
    const rice = { id: 'i1', name: 'Rice', localName: 'Rice', qty: 2, unit: 'kg', rate: 1600 };
    const s: any = { items: [rice], customerId: null, method: 'cash', discount: 0, question: null };
    s.check = findCheck(s, { prices, priceKey });
    assert.deepEqual(s.check, { kind: 'amount', itemId: 'i1', field: 'rate', options: [1600, 6000] });
    assert.equal(findCheck({ ...s, items: [{ ...rice, rate: 6200 }] }, { prices, priceKey }), null);
    // no saved price: the AI's usual price is used instead
    assert.equal(findCheck({ ...s, items: [{ ...rice, name: 'Dal', localName: 'Dal', rate: 1500, usualRate: 11000 }] }, { prices, priceKey }), null);
    assert.deepEqual(findCheck({ ...s, items: [{ ...rice, name: 'Sugar', localName: 'Sugar', rate: 1500, usualRate: 4500 }] }, { prices, priceKey })?.options, [1500, 5000]);

    const t = await call('POST', '/voice/turn', { state: s, choose: 1, language: 'en' });
    assert.equal(t.status, 200);
    assert.equal(t.body.state.items[0].rate, 6000);
    assert.equal(t.body.state.items[0].checked, true);
    assert.equal(t.body.state.check, null);
    assert.equal(t.body.reply.kind, 'confirm');
    assert.equal(t.body.totals.total, 12000);
    const { buildReply } = await import('../src/lib/billState.ts');
    assert.equal(buildReply(s, 'en', null).text, 'Rice: 60 or 16 rupees?');
    assert.equal(buildReply(s, 'hi', null).text, 'Rice: 60 रुपये या 16 रुपये?');
    step('did you mean: misheard price flagged from saved price, tapped answer fixes it', true);

    // Item names must be in the spoken language's own script: a Telugu bill never shows Hindi letters.
    const { inScript, applyEdits, emptyState } = await import('../src/lib/billState.ts');
    assert.equal(inScript('కందిపప్పు', 'te'), true);
    assert.equal(inScript('कंदीपप्पू', 'te'), false);
    assert.equal(inScript('Surf Excel', 'te'), true);
    assert.equal(inScript('चावल', 'hi'), true);
    assert.equal(inScript('चावल', 'en'), false);
    const op = { op: 'add', itemId: null, name: 'Toor Dal', qtySpoken: true, qty: 1, unit: 'kg', ratePerUnit: 70, lineAmount: null, usualRate: null };
    const edits: any = { customerName: null, matchedCustomerId: null, similarCustomerId: null, paymentMethod: null, discount: null, confirmed: false, operations: [{ ...op, localName: 'कंदीपप्पू' }] };
    assert.equal(applyEdits(emptyState(), edits, new Set(), 'te').items[0].localName, 'Toor Dal');
    edits.operations[0].localName = 'కందిపప్పు';
    assert.equal(applyEdits(emptyState(), edits, new Set(), 'te').items[0].localName, 'కందిపప్పు');
    step('item names: wrong-script names (Hindi letters on a Telugu bill) fall back to English', true);
  }

  r = await call('POST', '/transactions', bill);
  assert.equal(r.status, 200);
  assert.equal(r.body.customer.pastDues, 75500);
  step('retrying the same txnId does not double-count', true);

  r = await call('POST', '/transactions', { kind: 'bill', txnId: 'walk_1', method: 'cash', items: [{ name: 'Soap', qty: 3, rate: 4000 }] });
  assert.equal(r.status, 201);
  assert.equal(r.body.customer.isWalkinCustomer, true);
  assert.equal(r.body.shopkeeper.todaysBill, 37500);
  assert.equal(r.body.shopkeeper.weeklyBill, 37500);
  step('walk-in cash bill counts in today/weekly bill', true);

  r = await call('POST', '/transactions', { kind: 'bill', txnId: 'walk_2', method: 'khata', items: [{ name: 'Soap', qty: 1, rate: 4000 }] });
  assert.equal(r.status, 400);
  step('khata for walk-in rejected', true);

  r = await call('POST', '/transactions', { kind: 'payment', txnId: 'pay_x', customerId: ramesh.id, method: 'cash', amount: 999999 });
  assert.equal(r.status, 400);
  step('overpayment rejected', true);

  for (const [i, amount] of [10000, 5000, 500].entries()) {
    r = await call('POST', '/transactions', { kind: 'payment', txnId: `pay_${i}`, customerId: ramesh.id, method: 'upi', amount });
    assert.equal(r.status, 201);
  }
  assert.equal(r.body.customer.pastDues, 60000);
  assert.equal(r.body.shopkeeper.duesTotal, 60000);
  assert.deepEqual(r.body.customer.recentTransactions.map((t: { txnId: string }) => t.txnId), ['pay_0', 'pay_1', 'pay_2']);
  step('payments reduce dues; only last 3 transactions kept', true);

  r = await call('GET', '/customers?search=ram');
  assert.equal(r.body.customers.length, 1);
  r = await call('GET', '/shopkeeper/me');
  assert.equal(r.body.shopkeeper.duesTotal, 60000);
  step('search customers + shop summary', true);

  r = await call('DELETE', `/customers/${ramesh.id}`);
  assert.equal(r.status, 400);
  step('cannot delete customer with dues', true);

  token = undefined;
  for (let i = 0; i < 5; i++) {
    r = await call('POST', '/auth/login', { mobileNumber: shop.mobileNumber, passcode: '0000' });
  }
  r = await call('POST', '/auth/login', { mobileNumber: shop.mobileNumber, passcode: '1234' });
  assert.equal(r.status, 429);
  step('5 wrong passcodes lock the account', true);

  console.log('\nAll smoke checks passed.');
} finally {
  server.close();
  const { default: mongoose } = await import('mongoose');
  await mongoose.disconnect();
  await mongo.stop();
}
