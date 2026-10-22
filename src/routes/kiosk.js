// Self-service pickup screen. Runs on a fixed tablet logged in with the limited "kiosk" account.
const express = require('express');
const { db, tx } = require('../db');
const { requireRole } = require('../lib/auth');
const time = require('../lib/time');

const router = express.Router();
router.use(requireRole('kiosk', 'admin'));

function render(res, state, data = {}) {
  res.render('kiosk/screen', { title: 'شاشة الاستلام', state, mealType: time.currentMealType(), today: time.ymd(), ...data });
}

router.get('/', (req, res) => render(res, 'input'));

router.post('/check', (req, res) => {
  const no = String(req.body.member_no || '').trim().toUpperCase();
  const mealType = time.currentMealType();
  if (!mealType) return render(res, 'closed', { memberNo: no });
  const user = db.prepare("SELECT id, name, member_no, active FROM users WHERE member_no = ? AND role = 'member'").get(no);
  if (!user) return render(res, 'unknown', { memberNo: no });
  const booking = db.prepare(`SELECT b.*, m.name AS meal_name FROM bookings b JOIN meals m ON m.id = b.meal_id
    WHERE b.user_id = ? AND b.date = ? AND b.type = ? AND b.pickup_status <> 'cancelled'`).get(user.id, time.ymd(), mealType);
  if (!booking) return render(res, 'none', { member: user });
  if (booking.pickup_status === 'picked') return render(res, 'already', { member: user, booking });
  render(res, 'found', { member: user, booking });
});

router.post('/confirm', (req, res) => {
  const id = Number(req.body.booking_id);
  const result = tx(() => {
    const b = db.prepare(`SELECT b.*, m.name AS meal_name, u.name AS user_name, u.member_no FROM bookings b
      JOIN meals m ON m.id = b.meal_id JOIN users u ON u.id = b.user_id WHERE b.id = ?`).get(id);
    if (!b || b.date !== time.ymd() || b.type !== time.currentMealType()) return { state: 'input' };
    const member = { name: b.user_name, member_no: b.member_no };
    if (b.pickup_status === 'picked') return { state: 'already', member, booking: b };
    if (b.pickup_status !== 'booked') return { state: 'none', member };
    db.prepare("UPDATE bookings SET pickup_status = 'picked', picked_at = datetime('now','localtime') WHERE id = ? AND pickup_status = 'booked'").run(id);
    return { state: 'picked', member, booking: db.prepare('SELECT * FROM bookings WHERE id = ?').get(id), mealName: b.meal_name };
  });
  render(res, result.state, result);
});

module.exports = router;
