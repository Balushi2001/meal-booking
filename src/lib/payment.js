// Payment gateway adapter. The built-in "mock" provider simulates a hosted checkout page so the
// full flow can be used before a real gateway (e.g. Thawani, OmanNet, Stripe) is connected.
const crypto = require('node:crypto');

const PROVIDER = process.env.PAYMENT_PROVIDER || 'mock';

const pending = new Map(); // token -> checkout data (mock provider only)

function createCheckout({ amount, description, payload }) {
  if (PROVIDER !== 'mock') throw new Error(`مزوّد الدفع "${PROVIDER}" غير مُعدّ بعد`);
  const token = crypto.randomBytes(16).toString('hex');
  pending.set(token, { amount, description, payload, createdAt: Date.now() });
  return { token, redirectUrl: `/pay/gateway/${token}` };
}

function getCheckout(token) {
  const c = pending.get(token);
  if (!c || Date.now() - c.createdAt > 30 * 60 * 1000) return null;
  return c;
}

function finish(token) {
  const c = pending.get(token);
  pending.delete(token);
  return c;
}

module.exports = { PROVIDER, createCheckout, getCheckout, finish };
