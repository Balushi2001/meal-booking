// Booking rules shared by the member flow and the admin "book on behalf" flow.
const { db, tx, clubs } = require('../db');
const ledger = require('./ledger');
const { isBookingOpenFor } = require('./time');

class BookingError extends Error {}

function publishedMenu(date) {
  return db.prepare(`SELECT * FROM meals WHERE date = ? AND hidden = 0
    ORDER BY CASE type WHEN 'breakfast' THEN 1 WHEN 'lunch' THEN 2 ELSE 3 END, price, id`).all(date);
}

function activeBookings(userId, date) {
  return db.prepare(`SELECT b.*, m.name AS meal_name, m.description AS meal_description FROM bookings b
    JOIN meals m ON m.id = b.meal_id
    WHERE b.user_id = ? AND b.date = ? AND b.pickup_status <> 'cancelled'
    ORDER BY CASE b.type WHEN 'breakfast' THEN 1 WHEN 'lunch' THEN 2 ELSE 3 END`).all(userId, date);
}

// Validates a selection and returns the chosen meals; throws BookingError with an Arabic message.
function validate({ userId, date, mealIds, club, mode, method, enforceCutoff = true }) {
  if (enforceCutoff && !isBookingOpenFor(date)) throw new BookingError('انتهى وقت الحجز لهذا اليوم.');
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user || user.role !== 'member' || !user.active) throw new BookingError('الحساب غير متاح للحجز.');
  if (!['now', 'salary'].includes(method)) throw new BookingError('اختر طريقة الدفع.');
  if (!clubs().includes(club)) throw new BookingError('اختر النادي.');
  if (!['takeaway', 'dinein'].includes(mode)) throw new BookingError('اختر طريقة الاستلام.');
  const ids = [...new Set((mealIds || []).map(Number))].filter(Boolean);
  if (!ids.length) throw new BookingError('اختر وجبة واحدة على الأقل.');
  const meals = ids.map((id) => db.prepare('SELECT * FROM meals WHERE id = ?').get(id));
  if (meals.some((m) => !m || m.date !== date || m.hidden)) throw new BookingError('إحدى الوجبات المختارة لم تعد متاحة.');
  const types = meals.map((m) => m.type);
  if (new Set(types).size !== types.length) throw new BookingError('يمكن اختيار صنف واحد فقط لكل وجبة.');
  const already = activeBookings(userId, date).map((b) => b.type);
  if (types.some((t) => already.includes(t))) throw new BookingError('لديك حجز مسبق لإحدى هذه الوجبات.');
  return meals;
}

function create(opts) {
  return tx(() => {
    const meals = validate(opts);
    const insert = db.prepare(`INSERT INTO bookings
      (user_id, meal_id, date, type, price, payment_method, payment_status, club, pickup_mode, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const status = opts.method === 'now' ? 'paid' : 'due';
    const ids = meals.map((m) => insert.run(opts.userId, m.id, opts.date, m.type, m.price, opts.method, status,
      opts.club, opts.mode, opts.createdBy || opts.userId).lastInsertRowid);
    if (opts.method === 'salary') ledger.recompute(opts.userId);
    return ids;
  });
}

module.exports = { BookingError, publishedMenu, activeBookings, validate, create };
