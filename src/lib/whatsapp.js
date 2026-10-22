// WhatsApp Business (Cloud API). Without credentials, messages are only logged so the flow can be tested.
const { db } = require('../db');

const TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const TEMPLATE = process.env.WHATSAPP_REMINDER_TEMPLATE; // approved template name, optional

function log(userId, phone, body, kind, status) {
  db.prepare('INSERT INTO messages (user_id, phone, body, kind, status) VALUES (?, ?, ?, ?, ?)')
    .run(userId, phone, body, kind, status);
}

async function send({ userId = null, phone, body, kind = 'general', templateParams = null }) {
  if (!TOKEN || !PHONE_ID) {
    log(userId, phone, body, kind, 'logged');
    console.log(`[whatsapp:${kind}] → ${phone}: ${body}`);
    return { ok: true, simulated: true };
  }
  const to = phone.replace(/[^\d]/g, '');
  const payload = TEMPLATE && templateParams
    ? { messaging_product: 'whatsapp', to, type: 'template',
        template: { name: TEMPLATE, language: { code: 'ar' },
          components: [{ type: 'body', parameters: templateParams.map((t) => ({ type: 'text', text: t })) }] } }
    : { messaging_product: 'whatsapp', to, type: 'text', text: { body } };
  try {
    const res = await fetch(`https://graph.facebook.com/v21.0/${PHONE_ID}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    log(userId, phone, body, kind, res.ok ? 'sent' : `failed:${res.status}`);
    return { ok: res.ok };
  } catch (err) {
    log(userId, phone, body, kind, 'failed:network');
    return { ok: false, error: err.message };
  }
}

module.exports = { send };
