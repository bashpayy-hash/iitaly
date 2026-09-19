'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ORDER_ID_RE = /^ord_[a-f0-9]{16}$/;

function createOrderStore({ dir, key }) {
  const ordersDir = path.join(dir, 'orders');
  fs.mkdirSync(ordersDir, { recursive: true });
  const encKey = key ? crypto.createHash('sha256').update(String(key)).digest() : null;

  function fileFor(id) {
    if (!ORDER_ID_RE.test(String(id || ''))) throw new Error('bad order id');
    return path.join(ordersDir, id + '.json');
  }

  function encrypt(text) {
    if (!encKey) return text;
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', encKey, iv);
    const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join('.');
  }

  function decrypt(raw) {
    if (!raw.startsWith('v1.')) return raw;
    if (!encKey) throw new Error('encrypted order without key');
    const p = raw.split('.');
    if (p.length !== 4) throw new Error('bad order format');
    const decipher = crypto.createDecipheriv('aes-256-gcm', encKey, Buffer.from(p[1], 'base64'));
    decipher.setAuthTag(Buffer.from(p[2], 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(p[3], 'base64')), decipher.final()]).toString('utf8');
  }

  function write(record) {
    const target = fileFor(record.id);
    const tmp = target + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
    try {
      fs.writeFileSync(tmp, encrypt(JSON.stringify(record)), { mode: 0o600, flag: 'wx' });
      fs.renameSync(tmp, target);
      return true;
    } catch {
      try { fs.unlinkSync(tmp); } catch {}
      return false;
    }
  }

  function read(id) {
    try {
      const raw = fs.readFileSync(fileFor(id), 'utf8');
      return JSON.parse(decrypt(raw));
    } catch {
      return null;
    }
  }

  function create(fields) {
    let id;
    do id = 'ord_' + crypto.randomBytes(8).toString('hex'); while (fs.existsSync(fileFor(id)));
    const record = {
      id,
      status: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      product: String(fields.product || '').slice(0, 100),
      price: Number.isFinite(Number(fields.price)) ? Number(fields.price) : null,
      name: String(fields.name || '').trim().slice(0, 60),
      surname: String(fields.surname || '').trim().slice(0, 60),
      phone: String(fields.phone || '').trim().slice(0, 20),
    };
    if (!write(record)) throw new Error('order write failed');
    return record;
  }

  function list() {
    let names = [];
    try { names = fs.readdirSync(ordersDir).filter(name => /^ord_[a-f0-9]{16}\.json$/.test(name)); }
    catch { return []; }
    return names
      .map(name => read(name.replace(/\.json$/, '')))
      .filter(Boolean)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  return { create, read, write, list, ordersDir };
}

module.exports = { createOrderStore, ORDER_ID_RE };
