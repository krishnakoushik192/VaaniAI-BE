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
