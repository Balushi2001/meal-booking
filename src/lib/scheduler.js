// Background jobs: 21:00 WhatsApp reminder, 23:59 booking close (enforced by time checks), and
// end-of-day marking of unpicked meals as "not picked up".
const { db, getSetting, setSetting } = require('../db');
const { ymd, addDays, hm, minutesOf, bookingTarget } = require('./time');
const { dateLong } = require('./format');
const whatsapp = require('./whatsapp');

function markNoShows(today = ymd()) {
  const r = db.prepare(`UPDATE bookings SET pickup_status = 'no_show'
    WHERE pickup_status = 'booked' AND date < ?`).run(today);
  return r.changes;
}

async function sendReminders(now = new Date()) {
  const date = addDays(ymd(now), 1);
  const menuCount = db.prepare('SELECT COUNT(*) AS c FROM meals WHERE date = ? AND hidden = 0').get(date).c;
  if (!menuCount) return { sent: 0, skipped: 'no-menu' };
  const members = db.prepare(`SELECT id, name, phone FROM users u WHERE role = 'member' AND active = 1 AND phone IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.user_id = u.id AND b.date = ? AND b.pickup_status <> 'cancelled')`).all(date);
  const template = getSetting('reminder_template');
  const cutoff = getSetting('cutoff_time');
  const link = getSetting('site_url');
  const dateText = dateLong(date);
  for (const m of members) {
    const first = m.name.split(/\s+/)[0];
    const body = template.replaceAll('{name}', first).replaceAll('{date}', dateText)
      .replaceAll('{cutoff}', cutoff).replaceAll('{link}', link);
    await whatsapp.send({ userId: m.id, phone: m.phone, body, kind: 'reminder', templateParams: [first, dateText, cutoff, link] });
  }
  return { sent: members.length };
}

async function tick(now = new Date()) {
  const today = ymd(now);
  if (getSetting('last_noshow_date') !== today) {
    markNoShows(today);
    setSetting('last_noshow_date', today);
  }
  const t = minutesOf(hm(now));
  const reminderAt = minutesOf(getSetting('reminder_time'));
  const cutoffAt = minutesOf(getSetting('cutoff_time'));
  if (t >= reminderAt && t < cutoffAt && getSetting('last_reminder_date') !== today) {
    setSetting('last_reminder_date', today);
    const r = await sendReminders(now);
    console.log(`[scheduler] تذكير واتساب: ${r.sent} رسالة${r.skipped ? ' (لم يُنشر منيو الغد)' : ''}`);
  }
}

function start() {
  tick().catch((e) => console.error('[scheduler]', e));
  return setInterval(() => tick().catch((e) => console.error('[scheduler]', e)), 30 * 1000);
}

module.exports = { start, tick, markNoShows, sendReminders, bookingTarget };
