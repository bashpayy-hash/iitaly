'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createOrderStore, ORDER_ID_RE } = require('../order-store');

test('order store creates encrypted durable records and lists newest first', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iitaly-orders-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createOrderStore({ dir, key: 'synthetic-key' });
  const first = store.create({ product: 'Поступление под ключ', price: 25000, name: 'Test', surname: 'One', phone: '+77000000001' });
  const second = store.create({ product: 'Проверка', price: 16900, name: 'Test', surname: 'Two', phone: '+77000000002' });
  assert.match(first.id, ORDER_ID_RE);
  assert.match(fs.readFileSync(path.join(store.ordersDir, first.id + '.json'), 'utf8'), /^v1\./);
  assert.equal(store.read(first.id).phone, '+77000000001');
  assert.equal(store.list().length, 2);
  assert.equal(store.list()[0].id, second.id);
});

test('order store rejects path traversal and preserves existing record on failed temp write', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iitaly-orders-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createOrderStore({ dir, key: 'synthetic-key' });
  assert.equal(store.read('../../etc/passwd'), null);
  const order = store.create({ product: 'X', price: 1, name: 'Test', surname: 'User', phone: '+77000000000' });
  order.status = 'activated';
  assert.equal(store.write(order), true);
  assert.equal(store.read(order.id).status, 'activated');
});
