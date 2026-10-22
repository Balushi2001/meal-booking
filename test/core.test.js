process.env.TZ = 'Asia/Muscat';
process.env.DB_FILE = ':memory:';

const test = require('node:test');
const assert = require('node:assert');
const { db } = require('../src/db');
const memberNo = require('../src/lib/memberNo');
const time = require('../src/lib/time');
const ledger = require('../src/lib/ledger');
const bookings = require('../src/lib/bookings');
const { normalizePhone } = require('../src/lib/auth');
const { markNoShows } = require('../src/lib/scheduler');

function addMember(name, phone) {
  const no = memberNo.generate(name);
  const id = db.prepare("INSERT INTO users (member_no, name, phone, password_hash, role, club) VALUES (?, ?, ?, 'x', 'member', 'نادي 1')")
    .run(no, name, phone).lastInsertRowid;
  return { id: Number(id), no };
}

test('membership number: English capital of the first letter + 3 distinct digits', () => {
  assert.strictEqual(memberNo.letterFor('أحمد سالم'), 'A');
  assert.strictEqual(memberNo.letterFor('سالم خالد'), 'S');
  assert.strictEqual(memberNo.letterFor('مريم'), 'M');
  assert.strictEqual(memberNo.letterFor('john'), 'J');
  for (let i = 0; i < 200; i++) {
    const no = memberNo.generate('فاطمة');
    assert.match(no, /^F\d{3}$/);
    assert.strictEqual(new Set(no.slice(1)).size, 3, `${no} has repeated digits`);
  }
});

test('membership numbers never repeat', () => {
  const seen = new Set();
  for (let i = 0; i < 300; i++) seen.add(addMember('نورة', `+9689${String(1000000 + i)}`).no);
  assert.strictEqual(seen.size, 300);
});

test('booking target is tomorrow until the cutoff, then the day after', () => {
  const before = new Date(2026, 9, 1, 23, 58);
  const after = new Date(2026, 9, 1, 23, 59, 30);
  assert.strictEqual(time.bookingTarget(before).date, '2026-10-02');
  assert.strictEqual(time.bookingTarget(after).date, '2026-10-03');
  assert.ok(!time.isBookingOpenFor('2026-10-02', after));
});

test('phone numbers are normalised with the country code', () => {
  assert.strictEqual(normalizePhone('+968 9123 4567'), '+96891234567');
  assert.strictEqual(normalizePhone('91234567'), '+96891234567');
  assert.strictEqual(normalizePhone('00968 9123 4567'), '+96891234567');
  assert.strictEqual(normalizePhone('12'), null);
});

test('salary bookings, partial payments and no-shows', () => {
  const m = addMember('خالد', '+96899990000');
  const date = time.bookingTarget().date;
  const ins = db.prepare('INSERT INTO meals (date, type, name, price) VALUES (?, ?, ?, ?)');
  const b = Number(ins.run(date, 'breakfast', 'فول', 800).lastInsertRowid);
  const l = Number(ins.run(date, 'lunch', 'مجبوس', 1500).lastInsertRowid);
  const opts = { userId: m.id, date, club: 'نادي 1', mode: 'takeaway', method: 'salary' };
  bookings.create({ ...opts, mealIds: [b, l] });
  assert.strictEqual(ledger.outstanding(m.id), 2300);
  assert.throws(() => bookings.create({ ...opts, mealIds: [l] }), bookings.BookingError);

  db.prepare("INSERT INTO payments (user_id, amount, date, method) VALUES (?, 1000, '2026-10-01', 'نقدًا')").run(m.id);
  ledger.recompute(m.id);
  const rows = db.prepare('SELECT type, payment_status FROM bookings WHERE user_id = ? ORDER BY id').all(m.id);
  assert.deepStrictEqual(rows.map((r) => r.payment_status), ['paid', 'due']);
  assert.strictEqual(ledger.outstanding(m.id), 1300);

  markNoShows(time.addDays(date, 1));
  const statuses = db.prepare('SELECT pickup_status FROM bookings WHERE user_id = ?').all(m.id).map((r) => r.pickup_status);
  assert.deepStrictEqual(statuses, ['no_show', 'no_show']);
  assert.strictEqual(ledger.outstanding(m.id), 1300, 'unpicked meals stay due');
});

test('bookings are refused after the cutoff for that day', () => {
  const m = addMember('سعيد', '+96899990001');
  const yesterdayTarget = time.ymd();
  const meal = Number(db.prepare("INSERT INTO meals (date, type, name, price) VALUES (?, 'dinner', 'شوربة', 700)").run(yesterdayTarget).lastInsertRowid);
  assert.throws(() => bookings.create({ userId: m.id, date: yesterdayTarget, mealIds: [meal], club: 'نادي 1', mode: 'dinein', method: 'salary' }),
    /انتهى وقت الحجز/);
});
