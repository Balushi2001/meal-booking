// Salary bookings are settled oldest-first by the member's recorded payments.
const { db } = require('../db');

function recompute(userId) {
  const paidTotal = db.prepare('SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE user_id = ?').get(userId).s;
  const bookings = db.prepare(`SELECT id, price, payment_status FROM bookings
    WHERE user_id = ? AND payment_method = 'salary' AND pickup_status <> 'cancelled'
    ORDER BY date, id`).all(userId);
  const update = db.prepare('UPDATE bookings SET payment_status = ? WHERE id = ?');
  let credit = paidTotal;
  for (const b of bookings) {
    const status = credit >= b.price ? 'paid' : 'due';
    if (status === 'paid') credit -= b.price;
    if (status !== b.payment_status) update.run(status, b.id);
  }
}

// Total still owed by the member, net of any partial payment not yet covering a whole booking.
function outstanding(userId) {
  const owed = db.prepare(`SELECT COALESCE(SUM(price),0) AS s FROM bookings
    WHERE user_id = ? AND payment_method = 'salary' AND pickup_status <> 'cancelled'`).get(userId).s;
  const paid = db.prepare('SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE user_id = ?').get(userId).s;
  return Math.max(0, owed - paid);
}

function partialCredit(userId) {
  const dueSum = db.prepare(`SELECT COALESCE(SUM(price),0) AS s FROM bookings
    WHERE user_id = ? AND payment_status = 'due' AND pickup_status <> 'cancelled'`).get(userId).s;
  return Math.max(0, dueSum - outstanding(userId));
}

function monthTotals(userId, ym) {
  const row = db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN payment_status = 'due' THEN price END),0) AS due,
      COALESCE(SUM(CASE WHEN payment_status = 'paid' THEN price END),0) AS paid,
      COALESCE(SUM(price),0) AS total
    FROM bookings WHERE user_id = ? AND substr(date,1,7) = ? AND pickup_status <> 'cancelled'`).get(userId, ym);
  return row;
}

module.exports = { recompute, outstanding, partialCredit, monthTotals };
