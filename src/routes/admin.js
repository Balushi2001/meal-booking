const express = require('express');
const bcrypt = require('bcryptjs');
const { db, tx, clubs, allSettings, setSetting, audit } = require('../db');
const { requireRole, flash, normalizePhone } = require('../lib/auth');
const bookings = require('../lib/bookings');
const ledger = require('../lib/ledger');
const memberNo = require('../lib/memberNo');
const reports = require('../lib/reports');
const scheduler = require('../lib/scheduler');
const time = require('../lib/time');
const { PRICE_LIST, money } = require('../lib/format');

const router = express.Router();
router.use(requireRole('admin'));

const TYPE_ORDER = "CASE type WHEN 'breakfast' THEN 1 WHEN 'lunch' THEN 2 ELSE 3 END";
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
const isMonth = (s) => /^\d{4}-\d{2}$/.test(s || '');
const back = (req, fallback) => req.get('Referer') || fallback;

function kitchenSummary(date) {
  return db.prepare(`SELECT b.type, m.name, COUNT(*) AS total,
      SUM(b.payment_method = 'now') AS paid_now, SUM(b.payment_method = 'salary') AS salary,
      SUM(b.pickup_mode = 'takeaway') AS takeaway, SUM(b.pickup_mode = 'dinein') AS dinein
    FROM bookings b JOIN meals m ON m.id = b.meal_id
    WHERE b.date = ? AND b.pickup_status <> 'cancelled'
    GROUP BY b.type, m.id ORDER BY CASE b.type WHEN 'breakfast' THEN 1 WHEN 'lunch' THEN 2 ELSE 3 END, m.name`).all(date);
}

function clubBreakdown(date) {
  return db.prepare(`SELECT club, SUM(pickup_mode = 'takeaway') AS takeaway, SUM(pickup_mode = 'dinein') AS dinein, COUNT(*) AS total
    FROM bookings WHERE date = ? AND pickup_status <> 'cancelled' GROUP BY club ORDER BY club`).all(date);
}

// ---------- Dashboard ----------
router.get('/', (req, res) => {
  const today = time.ymd();
  const target = time.bookingTarget();
  const byType = Object.fromEntries(db.prepare(`SELECT type, COUNT(*) AS c FROM bookings
    WHERE date = ? AND pickup_status <> 'cancelled' GROUP BY type`).all(target.date).map((r) => [r.type, r.c]));
  const notBooked = db.prepare(`SELECT COUNT(*) AS c FROM users u WHERE role = 'member' AND active = 1
    AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.user_id = u.id AND b.date = ? AND b.pickup_status <> 'cancelled')`).get(target.date).c;
  const pickup = db.prepare(`SELECT COUNT(*) AS total, SUM(pickup_status = 'picked') AS picked FROM bookings
    WHERE date = ? AND pickup_status <> 'cancelled'`).get(today);
  const dues = db.prepare(`SELECT u.id FROM users u WHERE role = 'member'`).all()
    .map((u) => ledger.outstanding(u.id)).filter((v) => v > 0);
  res.render('admin/dashboard', {
    title: 'لوحة المشرف',
    today, target, byType,
    tomorrowTotal: Object.values(byType).reduce((a, b) => a + b, 0),
    notBooked,
    pickup: { total: pickup.total || 0, picked: pickup.picked || 0 },
    dues: { total: dues.reduce((a, b) => a + b, 0), members: dues.length },
    kitchen: kitchenSummary(target.date),
    clubsRows: clubBreakdown(target.date),
    menuPublished: bookings.publishedMenu(target.date).length > 0,
    capacity: memberNo.capacityWarnings(),
    reminderTime: allSettings().reminder_time,
  });
});

// ---------- Menu ----------
router.get('/menu', (req, res) => {
  const date = isDate(req.query.date) ? req.query.date : time.bookingTarget().date;
  const meals = db.prepare(`SELECT m.*, (SELECT COUNT(*) FROM bookings b WHERE b.meal_id = m.id AND b.pickup_status <> 'cancelled') AS booked
    FROM meals m WHERE date = ? ORDER BY ${TYPE_ORDER}, hidden, id`).all(date);
  const editing = req.query.edit ? meals.find((m) => m.id === Number(req.query.edit)) : null;
  const recentDates = db.prepare('SELECT DISTINCT date FROM meals WHERE date <> ? ORDER BY date DESC LIMIT 14').all(date).map((r) => r.date);
  res.render('admin/menu', { title: 'إدارة المنيو', date, meals, editing, priceList: PRICE_LIST, recentDates });
});

router.post('/menu', (req, res) => {
  const { id, date, type, name, description } = req.body;
  const price = Number(req.body.price);
  const to = `/admin/menu?date=${encodeURIComponent(date)}`;
  if (!isDate(date) || !['breakfast', 'lunch', 'dinner'].includes(type) || !String(name || '').trim()) {
    flash(req, 'error', 'أكمل نوع الوجبة واسمها.');
    return res.redirect(to);
  }
  if (!PRICE_LIST.includes(price)) {
    flash(req, 'error', 'اختر السعر من القائمة (0.500 – 2.000 ر.ع).');
    return res.redirect(to);
  }
  if (id) {
    // Price changes never touch existing bookings: each booking stores its own price.
    db.prepare('UPDATE meals SET type = ?, name = ?, description = ?, price = ?, hidden = 0 WHERE id = ?')
      .run(type, name.trim(), String(description || '').trim(), price, Number(id));
    audit(req.user.id, 'meal.update', { id: Number(id), date, type, name, price });
    flash(req, 'success', 'تم حفظ التعديل.');
  } else {
    const r = db.prepare('INSERT INTO meals (date, type, name, description, price) VALUES (?, ?, ?, ?, ?)')
      .run(date, type, name.trim(), String(description || '').trim(), price);
    audit(req.user.id, 'meal.create', { id: Number(r.lastInsertRowid), date, type, name, price });
    flash(req, 'success', 'تمت إضافة الوجبة.');
  }
  res.redirect(to);
});

router.post('/menu/:id/delete', (req, res) => {
  const meal = db.prepare('SELECT * FROM meals WHERE id = ?').get(req.params.id);
  if (!meal) return res.redirect('/admin/menu');
  const count = db.prepare("SELECT COUNT(*) AS c FROM bookings WHERE meal_id = ? AND pickup_status <> 'cancelled'").get(meal.id).c;
  const anyBookings = db.prepare('SELECT COUNT(*) AS c FROM bookings WHERE meal_id = ?').get(meal.id).c;
  if (anyBookings) {
    db.prepare('UPDATE meals SET hidden = 1 WHERE id = ?').run(meal.id);
    audit(req.user.id, 'meal.hide', { id: meal.id, bookings: count });
    flash(req, 'warning', `الوجبة عليها ${count} حجز، لذلك أُخفيت بدل حذفها نهائيًا. الحجوزات القائمة باقية.`);
  } else {
    db.prepare('DELETE FROM meals WHERE id = ?').run(meal.id);
    audit(req.user.id, 'meal.delete', { id: meal.id, name: meal.name });
    flash(req, 'success', 'تم حذف الوجبة.');
  }
  res.redirect(`/admin/menu?date=${meal.date}`);
});

router.post('/menu/:id/show', (req, res) => {
  const meal = db.prepare('SELECT * FROM meals WHERE id = ?').get(req.params.id);
  if (meal) {
    db.prepare('UPDATE meals SET hidden = 0 WHERE id = ?').run(meal.id);
    audit(req.user.id, 'meal.show', { id: meal.id });
  }
  res.redirect(`/admin/menu?date=${meal ? meal.date : ''}`);
});

router.post('/menu/copy', (req, res) => {
  const { from, to } = req.body;
  if (!isDate(from) || !isDate(to) || from === to) {
    flash(req, 'error', 'اختر يومًا سابقًا صحيحًا للنسخ منه.');
    return res.redirect(`/admin/menu?date=${to || ''}`);
  }
  const n = tx(() => {
    const src = db.prepare('SELECT * FROM meals WHERE date = ? AND hidden = 0').all(from);
    const ins = db.prepare('INSERT INTO meals (date, type, name, description, price) VALUES (?, ?, ?, ?, ?)');
    for (const m of src) ins.run(to, m.type, m.name, m.description, m.price);
    return src.length;
  });
  audit(req.user.id, 'menu.copy', { from, to, count: n });
  flash(req, n ? 'success' : 'warning', n ? `تم نسخ ${n} وجبة من ${from}. يمكنك تعديلها الآن.` : 'لا توجد وجبات في اليوم المختار.');
  res.redirect(`/admin/menu?date=${to}`);
});

// ---------- Bookings ----------
router.get('/bookings', (req, res) => {
  const date = isDate(req.query.date) ? req.query.date : time.bookingTarget().date;
  const f = { type: req.query.type || '', club: req.query.club || '', status: req.query.status || '', q: (req.query.q || '').trim() };
  const where = ['b.date = ?'];
  const params = [date];
  if (f.type) { where.push('b.type = ?'); params.push(f.type); }
  if (f.club) { where.push('b.club = ?'); params.push(f.club); }
  if (f.status) { where.push('b.pickup_status = ?'); params.push(f.status); }
  if (f.q) { where.push('(u.name LIKE ? OR u.member_no LIKE ? OR u.phone LIKE ?)'); params.push(`%${f.q}%`, `%${f.q}%`, `%${f.q}%`); }
  const rows = db.prepare(`SELECT b.*, u.name AS user_name, u.member_no, m.name AS meal_name, c.role AS creator_role, c.name AS creator_name
    FROM bookings b JOIN users u ON u.id = b.user_id JOIN meals m ON m.id = b.meal_id LEFT JOIN users c ON c.id = b.created_by
    WHERE ${where.join(' AND ')} ORDER BY CASE b.type WHEN 'breakfast' THEN 1 WHEN 'lunch' THEN 2 ELSE 3 END, u.name`).all(...params);
  res.render('admin/bookings', {
    title: 'الحجوزات', date, f, rows, clubs: clubs(),
    kitchen: kitchenSummary(date), clubsRows: clubBreakdown(date),
  });
});

router.post('/bookings/:id/status', (req, res) => {
  const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);
  const status = req.body.pickup_status;
  if (b && ['booked', 'picked', 'no_show', 'cancelled'].includes(status)) {
    db.prepare(`UPDATE bookings SET pickup_status = ?, picked_at = CASE WHEN ? = 'picked' THEN COALESCE(picked_at, datetime('now','localtime')) ELSE NULL END WHERE id = ?`)
      .run(status, status, b.id);
    ledger.recompute(b.user_id);
    audit(req.user.id, 'booking.status', { id: b.id, from: b.pickup_status, to: status });
    flash(req, 'success', 'تم تحديث حالة الحجز.');
  }
  res.redirect(back(req, '/admin/bookings'));
});

router.get('/bookings/export', async (req, res) => {
  const date = isDate(req.query.date) ? req.query.date : time.bookingTarget().date;
  await reports.send(res, await reports.kitchenWorkbook(date), `ملخص-المطبخ-${date}.xlsx`);
});

// ---------- Book on behalf of a member ----------
router.get('/book', (req, res) => {
  const q = (req.query.q || '').trim();
  const results = q ? db.prepare(`SELECT * FROM users WHERE role = 'member' AND active = 1
    AND (name LIKE ? OR member_no LIKE ? OR phone LIKE ?) ORDER BY name LIMIT 20`).all(`%${q}%`, `%${q}%`, `%${q}%`) : [];
  const member = req.query.user ? db.prepare("SELECT * FROM users WHERE id = ? AND role = 'member'").get(req.query.user) : null;
  const dates = db.prepare('SELECT DISTINCT date FROM meals WHERE hidden = 0 AND date >= ? ORDER BY date LIMIT 30').all(time.ymd()).map((r) => r.date);
  const date = isDate(req.query.date) ? req.query.date : null;
  const menu = member && date ? bookings.publishedMenu(date) : [];
  const booked = member && date ? bookings.activeBookings(member.id, date) : [];
  res.render('admin/book', { title: 'حجز نيابة عن عضو', q, results, member, dates, date, menu, booked, clubs: clubs() });
});

router.post('/book', (req, res) => {
  const userId = Number(req.body.user_id);
  const opts = {
    userId, date: req.body.date, mealIds: ['breakfast', 'lunch', 'dinner'].map((t) => req.body[`meal_${t}`]).filter(Boolean),
    club: req.body.club, mode: req.body.mode, method: req.body.method, createdBy: req.user.id,
    enforceCutoff: false,
  };
  try {
    const ids = bookings.create(opts);
    audit(req.user.id, 'booking.on_behalf', { userId, date: opts.date, bookings: ids.map(Number) });
    flash(req, 'success', 'تم الحجز. يظهر للعضو في «حجوزاتي» مع إشارة «بواسطة المشرف».');
    res.redirect(`/admin/book?user=${userId}&date=${opts.date}`);
  } catch (e) {
    if (!(e instanceof bookings.BookingError)) throw e;
    flash(req, 'error', e.message);
    res.redirect(`/admin/book?user=${userId}&date=${opts.date || ''}`);
  }
});

// ---------- Members ----------
router.get('/members', (req, res) => {
  const q = (req.query.q || '').trim();
  const filter = req.query.filter || 'all';
  const ym = time.ymd().slice(0, 7);
  const where = ["role = 'member'"];
  const params = [];
  if (q) { where.push('(name LIKE ? OR member_no LIKE ? OR phone LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  if (filter === 'suspended') where.push('active = 0');
  let members = db.prepare(`SELECT u.*, (SELECT COUNT(*) FROM bookings b WHERE b.user_id = u.id AND substr(b.date,1,7) = ? AND b.pickup_status <> 'cancelled') AS month_count
    FROM users u WHERE ${where.join(' AND ')} ORDER BY member_no`).all(ym, ...params)
    .map((m) => ({ ...m, outstanding: ledger.outstanding(m.id) }));
  if (filter === 'due') members = members.filter((m) => m.outstanding > 0);
  res.render('admin/members', { title: 'الأعضاء', q, filter, members, ym });
});

router.get('/members/:id', (req, res) => {
  const member = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'member'").get(req.params.id);
  if (!member) return res.redirect('/admin/members');
  const ym = isMonth(req.query.month) ? req.query.month : time.ymd().slice(0, 7);
  res.render('admin/member', {
    title: member.name, member, ym, clubs: clubs(),
    rows: reports.memberRows(member.id, ym),
    totals: ledger.monthTotals(member.id, ym),
    outstanding: ledger.outstanding(member.id),
    payments: db.prepare(`SELECT p.*, a.name AS admin_name FROM payments p LEFT JOIN users a ON a.id = p.admin_id
      WHERE p.user_id = ? ORDER BY p.date DESC, p.id DESC LIMIT 20`).all(member.id),
  });
});

router.post('/members/:id/payment', (req, res) => {
  const member = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'member'").get(req.params.id);
  const amount = Math.round(Number(req.body.amount) * 1000);
  if (!member || !Number.isFinite(amount) || amount <= 0) {
    flash(req, 'error', 'أدخل مبلغًا صحيحًا.');
    return res.redirect(back(req, '/admin/members'));
  }
  const method = req.body.method === 'transfer' ? 'تحويل' : 'نقدًا';
  tx(() => {
    db.prepare('INSERT INTO payments (user_id, amount, date, method, admin_id, note) VALUES (?, ?, ?, ?, ?, ?)')
      .run(member.id, amount, time.ymd(), method, req.user.id, String(req.body.note || '').trim());
    ledger.recompute(member.id);
  });
  audit(req.user.id, 'payment.create', { userId: member.id, amount });
  const left = ledger.outstanding(member.id);
  flash(req, 'success', `تم تسجيل دفعة ${money(amount)} ر.ع لـ ${member.name}.${left ? ` المتبقي مستحقًا: ${money(left)} ر.ع` : ' لا توجد مستحقات متبقية.'}`);
  res.redirect(back(req, `/admin/members/${member.id}`));
});

router.post('/members/:id/edit', (req, res) => {
  const member = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'member'").get(req.params.id);
  if (!member) return res.redirect('/admin/members');
  const name = String(req.body.name || '').trim();
  const phone = normalizePhone(req.body.phone);
  if (!name || !phone) {
    flash(req, 'error', 'الاسم ورقم الهاتف مطلوبان.');
  } else if (db.prepare('SELECT 1 FROM users WHERE phone = ? AND id <> ?').get(phone, member.id)) {
    flash(req, 'error', 'رقم الهاتف مسجّل لعضو آخر.');
  } else {
    const club = clubs().includes(req.body.club) ? req.body.club : member.club;
    db.prepare('UPDATE users SET name = ?, phone = ?, club = ? WHERE id = ?').run(name, phone, club, member.id);
    audit(req.user.id, 'member.edit', { id: member.id, before: { name: member.name, phone: member.phone, club: member.club }, after: { name, phone, club } });
    flash(req, 'success', 'تم حفظ بيانات العضو.');
  }
  res.redirect(`/admin/members/${member.id}`);
});

router.post('/members/:id/password', (req, res) => {
  const member = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'member'").get(req.params.id);
  if (!member) return res.redirect('/admin/members');
  const password = String(req.body.password || '');
  if (password.length < 8) {
    flash(req, 'error', 'كلمة المرور يجب أن تكون 8 خانات على الأقل.');
  } else {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(password, 10), member.id);
    db.prepare('DELETE FROM login_attempts WHERE member_no = ?').run(member.member_no);
    db.prepare("DELETE FROM sessions WHERE json_extract(data, '$.userId') = ?").run(member.id);
    audit(req.user.id, 'member.password_reset', { id: member.id });
    flash(req, 'success', 'تمت إعادة تعيين كلمة المرور. أبلغ العضو بها.');
  }
  res.redirect(`/admin/members/${member.id}`);
});

router.post('/members/:id/toggle', (req, res) => {
  const member = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'member'").get(req.params.id);
  if (member) {
    db.prepare('UPDATE users SET active = ? WHERE id = ?').run(member.active ? 0 : 1, member.id);
    audit(req.user.id, member.active ? 'member.suspend' : 'member.activate', { id: member.id });
    flash(req, 'success', member.active ? 'تم إيقاف الحساب.' : 'تم تفعيل الحساب.');
  }
  res.redirect(back(req, '/admin/members'));
});

router.get('/members/:id/export', async (req, res) => {
  const member = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'member'").get(req.params.id);
  if (!member) return res.redirect('/admin/members');
  const ym = isMonth(req.query.month) ? req.query.month : time.ymd().slice(0, 7);
  await reports.send(res, await reports.memberWorkbook(member.id, ym), `${member.member_no}-${ym}.xlsx`);
});

// ---------- Payments ----------
router.get('/payments', (req, res) => {
  const ym = isMonth(req.query.month) ? req.query.month : time.ymd().slice(0, 7);
  const rows = db.prepare(`SELECT p.*, u.name AS user_name, u.member_no, a.name AS admin_name FROM payments p
    JOIN users u ON u.id = p.user_id LEFT JOIN users a ON a.id = p.admin_id
    WHERE substr(p.date,1,7) = ? ORDER BY p.date DESC, p.id DESC`).all(ym);
  const online = db.prepare(`SELECT COALESCE(SUM(price),0) AS s, COUNT(*) AS c FROM bookings
    WHERE payment_method = 'now' AND substr(date,1,7) = ? AND pickup_status <> 'cancelled'`).get(ym);
  res.render('admin/payments', { title: 'المدفوعات', ym, rows, total: rows.reduce((s, r) => s + r.amount, 0), online });
});

// ---------- Reports ----------
router.get('/reports', (req, res) => {
  const ym = isMonth(req.query.month) ? req.query.month : time.ymd().slice(0, 7);
  const t = db.prepare(`SELECT COUNT(*) AS meals, COALESCE(SUM(price),0) AS total,
      COALESCE(SUM(CASE WHEN payment_status = 'paid' THEN price END),0) AS paid,
      COALESCE(SUM(CASE WHEN payment_status = 'due' THEN price END),0) AS due,
      SUM(pickup_status = 'picked') AS picked, SUM(pickup_status = 'no_show') AS no_show,
      COUNT(DISTINCT user_id) AS members
    FROM bookings WHERE substr(date,1,7) = ? AND pickup_status <> 'cancelled'`).get(ym);
  const byType = db.prepare(`SELECT type, COUNT(*) AS c, SUM(price) AS s FROM bookings
    WHERE substr(date,1,7) = ? AND pickup_status <> 'cancelled' GROUP BY type ORDER BY ${TYPE_ORDER}`).all(ym);
  res.render('admin/reports', { title: 'التقارير', ym, t, byType });
});

router.get('/reports/export', async (req, res) => {
  const ym = isMonth(req.query.month) ? req.query.month : time.ymd().slice(0, 7);
  await reports.send(res, await reports.allMembersWorkbook(ym), `تقرير-الوجبات-${ym}.xlsx`);
});

// ---------- Settings ----------
router.get('/settings', (req, res) => {
  const messages = db.prepare('SELECT * FROM messages ORDER BY id DESC LIMIT 30').all();
  const auditRows = db.prepare(`SELECT l.*, u.name AS admin_name FROM audit_log l LEFT JOIN users u ON u.id = l.admin_id
    ORDER BY l.id DESC LIMIT 30`).all();
  res.render('admin/settings', { title: 'الإعدادات', s: allSettings(), messages, auditRows,
    whatsappConfigured: Boolean(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID) });
});

router.post('/settings', (req, res) => {
  const timeRe = /^([01]\d|2[0-3]):[0-5]\d$/;
  const windowRe = /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/;
  const b = req.body;
  const errors = [];
  for (const k of ['cutoff_time', 'reminder_time']) if (!timeRe.test(b[k] || '')) errors.push(k);
  for (const k of ['breakfast_window', 'lunch_window', 'dinner_window']) if (!windowRe.test((b[k] || '').replace(/\s/g, ''))) errors.push(k);
  const clubList = String(b.clubs || '').split(/[,\n،]/).map((s) => s.trim()).filter(Boolean);
  if (!clubList.length) errors.push('clubs');
  if (!String(b.reminder_template || '').trim()) errors.push('reminder_template');
  if (errors.length) {
    flash(req, 'error', 'تحقق من الأوقات (الصيغة 21:00 أو 06:00-10:00) ومن قائمة الأندية ونص الرسالة.');
    return res.redirect('/admin/settings');
  }
  setSetting('cutoff_time', b.cutoff_time);
  setSetting('reminder_time', b.reminder_time);
  for (const k of ['breakfast_window', 'lunch_window', 'dinner_window']) setSetting(k, b[k].replace(/\s/g, ''));
  setSetting('clubs', clubList.join(','));
  setSetting('reminder_template', b.reminder_template.trim());
  setSetting('site_url', String(b.site_url || '').trim());
  setSetting('allow_cancel', b.allow_cancel === '1' ? '1' : '0');
  audit(req.user.id, 'settings.update', { cutoff: b.cutoff_time, reminder: b.reminder_time, clubs: clubList });
  flash(req, 'success', 'تم حفظ الإعدادات.');
  res.redirect('/admin/settings');
});

router.post('/settings/remind-now', async (req, res) => {
  const r = await scheduler.sendReminders();
  audit(req.user.id, 'reminder.manual', r);
  flash(req, r.skipped ? 'warning' : 'success', r.skipped ? 'لم يُنشر منيو الغد بعد، لذلك لا يُرسل تذكير.' : `تم إرسال ${r.sent} رسالة تذكير.`);
  res.redirect('/admin/settings');
});

router.post('/settings/password', (req, res) => {
  const { current, password, password_confirm: confirm } = req.body;
  const me = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  if (!bcrypt.compareSync(String(current || ''), me.password_hash)) flash(req, 'error', 'كلمة المرور الحالية غير صحيحة.');
  else if (String(password || '').length < 8 || password !== confirm) flash(req, 'error', 'كلمة المرور الجديدة 8 خانات على الأقل ويجب أن تتطابق.');
  else {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(password, 10), req.user.id);
    flash(req, 'success', 'تم تغيير كلمة مرور المشرف.');
  }
  res.redirect('/admin/settings');
});

router.post('/settings/kiosk-password', (req, res) => {
  const password = String(req.body.password || '');
  if (password.length < 8) flash(req, 'error', 'كلمة المرور يجب أن تكون 8 خانات على الأقل.');
  else {
    db.prepare("UPDATE users SET password_hash = ? WHERE role = 'kiosk'").run(bcrypt.hashSync(password, 10));
    audit(req.user.id, 'kiosk.password_reset');
    flash(req, 'success', 'تم تغيير كلمة مرور حساب شاشة الاستلام.');
  }
  res.redirect('/admin/settings');
});

module.exports = router;
