const express = require('express');
const bcrypt = require('bcryptjs');
const { db, clubs, getSetting } = require('../db');
const { requireRole, flash } = require('../lib/auth');
const bookings = require('../lib/bookings');
const ledger = require('../lib/ledger');
const payment = require('../lib/payment');
const time = require('../lib/time');

const router = express.Router();
const member = requireRole('member');

router.get('/', member, (req, res) => {
  const today = time.ymd();
  const target = time.bookingTarget();
  res.render('member/home', {
    title: 'الرئيسية',
    today,
    target,
    todayBookings: bookings.activeBookings(req.user.id, today),
    targetBookings: bookings.activeBookings(req.user.id, target.date),
    menuPublished: bookings.publishedMenu(target.date).length > 0,
    outstanding: ledger.outstanding(req.user.id),
  });
});

// Step 1: menu of the booking day.
router.get('/book', member, (req, res) => {
  const target = time.bookingTarget();
  const menu = bookings.publishedMenu(target.date);
  const booked = bookings.activeBookings(req.user.id, target.date);
  const draft = req.session.draft && req.session.draft.date === target.date ? req.session.draft : null;
  res.render('member/book', { title: 'منيو الغد', target, menu, booked, selected: draft ? draft.mealIds : [] });
});

router.post('/book', member, (req, res) => {
  const target = time.bookingTarget();
  const mealIds = [].concat(req.body.meal || []).map(Number).filter(Boolean);
  if (!mealIds.length) {
    flash(req, 'error', 'اختر وجبة واحدة على الأقل.');
    return res.redirect('/book');
  }
  const prev = req.session.draft || {};
  req.session.draft = { date: target.date, mealIds, club: prev.club || req.user.club, mode: prev.mode || 'takeaway' };
  res.redirect('/book/options');
});

function loadDraft(req, res) {
  const target = time.bookingTarget();
  const draft = req.session.draft;
  if (!draft || draft.date !== target.date) {
    if (draft) flash(req, 'error', 'انتهى وقت الحجز لذلك اليوم. هذا منيو اليوم التالي.');
    delete req.session.draft;
    res.redirect('/book');
    return null;
  }
  const meals = draft.mealIds.map((id) => db.prepare('SELECT * FROM meals WHERE id = ?').get(id)).filter(Boolean);
  return { target, draft, meals, total: meals.reduce((s, m) => s + m.price, 0) };
}

// Step 2: club and pickup method.
router.get('/book/options', member, (req, res) => {
  const ctx = loadDraft(req, res);
  if (!ctx) return;
  res.render('member/options', { title: 'النادي وطريقة الاستلام', ...ctx, clubs: clubs() });
});

router.post('/book/options', member, (req, res) => {
  const ctx = loadDraft(req, res);
  if (!ctx) return;
  const club = String(req.body.club || '');
  const mode = String(req.body.mode || '');
  if (!clubs().includes(club) || !['takeaway', 'dinein'].includes(mode)) {
    flash(req, 'error', 'اختر النادي وطريقة الاستلام.');
    return res.redirect('/book/options');
  }
  req.session.draft = { ...ctx.draft, club, mode };
  res.redirect('/book/confirm');
});

// Step 3: payment method and confirmation.
router.get('/book/confirm', member, (req, res) => {
  const ctx = loadDraft(req, res);
  if (!ctx) return;
  res.render('member/confirm', { title: 'تأكيد الحجز', ...ctx });
});

router.post('/book/confirm', member, (req, res) => {
  const ctx = loadDraft(req, res);
  if (!ctx) return;
  const method = String(req.body.method || '');
  const opts = { userId: req.user.id, date: ctx.draft.date, mealIds: ctx.draft.mealIds,
    club: ctx.draft.club, mode: ctx.draft.mode, method };
  try {
    bookings.validate(opts);
  } catch (e) {
    if (!(e instanceof bookings.BookingError)) throw e;
    flash(req, 'error', e.message);
    return res.redirect('/book/confirm');
  }
  if (method === 'salary') {
    bookings.create(opts);
    delete req.session.draft;
    req.session.lastBooking = { date: opts.date, method };
    return res.redirect('/book/done');
  }
  const checkout = payment.createCheckout({
    amount: ctx.total,
    description: `حجز وجبات ${ctx.draft.date}`,
    payload: opts,
  });
  req.session.checkoutToken = checkout.token;
  res.redirect(checkout.redirectUrl);
});

router.get('/book/done', member, (req, res) => {
  const last = req.session.lastBooking;
  if (!last) return res.redirect('/');
  res.render('member/done', { title: 'تم الحجز', last, items: bookings.activeBookings(req.user.id, last.date) });
});

// Mock hosted payment page (replace with the real gateway redirect/callback).
router.get('/pay/gateway/:token', member, (req, res) => {
  const checkout = payment.getCheckout(req.params.token);
  if (!checkout || checkout.payload.userId !== req.user.id) return res.redirect('/book/confirm');
  res.render('member/gateway', { title: 'بوابة الدفع', checkout, token: req.params.token });
});

router.post('/pay/gateway/:token', member, (req, res) => {
  const checkout = payment.getCheckout(req.params.token);
  if (!checkout || checkout.payload.userId !== req.user.id) return res.redirect('/book/confirm');
  payment.finish(req.params.token);
  if (req.body.result !== 'success') {
    flash(req, 'error', 'لم تنجح عملية الدفع، ولم يُثبت الحجز. اختر طريقة دفع أخرى أو حاول مجددًا.');
    return res.redirect('/book/confirm');
  }
  try {
    bookings.create({ ...checkout.payload, method: 'now' });
  } catch (e) {
    if (!(e instanceof bookings.BookingError)) throw e;
    flash(req, 'error', `${e.message} (لم يتم خصم أي مبلغ في الوضع التجريبي)`);
    return res.redirect('/book');
  }
  delete req.session.draft;
  req.session.lastBooking = { date: checkout.payload.date, method: 'now' };
  res.redirect('/book/done');
});

router.post('/bookings/:id/cancel', member, (req, res) => {
  const b = db.prepare('SELECT * FROM bookings WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (getSetting('allow_cancel') !== '1' || !b || b.pickup_status !== 'booked' || !time.isBookingOpenFor(b.date)) {
    flash(req, 'error', 'لا يمكن إلغاء هذا الحجز.');
  } else if (b.payment_method === 'now') {
    flash(req, 'error', 'الحجز مدفوع إلكترونيًا؛ تواصل مع المشرف لإلغائه واسترداد المبلغ.');
  } else {
    db.prepare("UPDATE bookings SET pickup_status = 'cancelled' WHERE id = ?").run(b.id);
    ledger.recompute(req.user.id);
    flash(req, 'success', 'تم إلغاء الحجز.');
  }
  res.redirect(req.get('Referer') || '/my');
});

router.get('/my', member, (req, res) => {
  const ym = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : time.ymd().slice(0, 7);
  const rows = db.prepare(`SELECT b.*, m.name AS meal_name, c.role AS creator_role FROM bookings b
    JOIN meals m ON m.id = b.meal_id LEFT JOIN users c ON c.id = b.created_by
    WHERE b.user_id = ? AND substr(b.date,1,7) = ?
    ORDER BY b.date DESC, CASE b.type WHEN 'breakfast' THEN 1 WHEN 'lunch' THEN 2 ELSE 3 END`).all(req.user.id, ym);
  res.render('member/my', {
    title: 'حجوزاتي',
    ym,
    rows,
    totals: ledger.monthTotals(req.user.id, ym),
    allowCancel: getSetting('allow_cancel') === '1',
    isOpen: (d) => time.isBookingOpenFor(d),
  });
});

router.get('/account', member, (req, res) => {
  const payments = db.prepare('SELECT * FROM payments WHERE user_id = ? ORDER BY date DESC, id DESC LIMIT 20').all(req.user.id);
  res.render('member/account', {
    title: 'حسابي',
    clubs: clubs(),
    outstanding: ledger.outstanding(req.user.id),
    credit: ledger.partialCredit(req.user.id),
    payments,
  });
});

router.post('/account/club', member, (req, res) => {
  if (clubs().includes(req.body.club)) {
    db.prepare('UPDATE users SET club = ? WHERE id = ?').run(req.body.club, req.user.id);
    flash(req, 'success', 'تم حفظ النادي.');
  }
  res.redirect('/account');
});

router.post('/account/password', member, (req, res) => {
  const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  const { current, password, password_confirm: confirm } = req.body;
  if (!bcrypt.compareSync(String(current || ''), user.password_hash)) flash(req, 'error', 'كلمة المرور الحالية غير صحيحة.');
  else if (String(password || '').length < 8) flash(req, 'error', 'كلمة المرور الجديدة يجب أن تكون 8 خانات على الأقل.');
  else if (password !== confirm) flash(req, 'error', 'كلمتا المرور غير متطابقتين.');
  else {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(password, 10), req.user.id);
    flash(req, 'success', 'تم تغيير كلمة المرور.');
  }
  res.redirect('/account');
});

module.exports = router;
