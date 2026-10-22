const crypto = require('node:crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const { db, clubs } = require('../db');
const memberNo = require('../lib/memberNo');
const whatsapp = require('../lib/whatsapp');
const { flash, homeFor, normalizePhone } = require('../lib/auth');

const router = express.Router();

const MAX_FAILURES = 5;
const LOCK_MINUTES = 15;

router.get('/login', (req, res) => {
  if (req.user) return res.redirect(homeFor(req.user));
  res.render('auth/login', { title: 'تسجيل الدخول', values: {}, error: null });
});

router.post('/login', (req, res) => {
  const no = String(req.body.member_no || '').trim().toUpperCase();
  const password = String(req.body.password || '');
  const values = { member_no: no };
  const fail = (error) => res.status(400).render('auth/login', { title: 'تسجيل الدخول', values, error });

  if (!no || !password) return fail('أدخل رقم العضوية وكلمة المرور.');

  const attempt = db.prepare('SELECT * FROM login_attempts WHERE member_no = ?').get(no);
  if (attempt && attempt.locked_until > Date.now()) {
    const mins = Math.ceil((attempt.locked_until - Date.now()) / 60000);
    return fail(`تم إيقاف الدخول لهذا الرقم مؤقتًا بسبب محاولات خاطئة متكررة. حاول بعد ${mins} دقيقة.`);
  }

  const user = db.prepare('SELECT * FROM users WHERE member_no = ?').get(no);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    const lockExpired = attempt && attempt.locked_until && attempt.locked_until <= Date.now();
    const failures = (attempt && !lockExpired ? attempt.failures : 0) + 1;
    const lockedUntil = failures >= MAX_FAILURES ? Date.now() + LOCK_MINUTES * 60000 : 0;
    db.prepare(`INSERT INTO login_attempts (member_no, failures, locked_until) VALUES (?, ?, ?)
      ON CONFLICT(member_no) DO UPDATE SET failures = excluded.failures, locked_until = excluded.locked_until`)
      .run(no, failures, lockedUntil);
    if (lockedUntil) return fail(`تم إيقاف الدخول لهذا الرقم ${LOCK_MINUTES} دقيقة بعد ${MAX_FAILURES} محاولات خاطئة.`);
    return fail(`رقم العضوية أو كلمة المرور غير صحيحة. (المتبقي ${MAX_FAILURES - failures} محاولات)`);
  }
  if (!user.active) return fail('هذا الحساب موقوف. تواصل مع المشرف.');

  db.prepare('DELETE FROM login_attempts WHERE member_no = ?').run(no);
  req.session.regenerate((err) => {
    if (err) throw err;
    req.session.userId = user.id;
    res.redirect(homeFor(user));
  });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

router.get('/register', (req, res) => {
  if (req.user) return res.redirect(homeFor(req.user));
  res.render('auth/register', { title: 'إنشاء حساب', values: {}, errors: {}, clubs: clubs() });
});

router.post('/register', (req, res) => {
  const values = {
    name: String(req.body.name || '').trim().replace(/\s+/g, ' '),
    phone: String(req.body.phone || '').trim(),
    club: String(req.body.club || ''),
  };
  const password = String(req.body.password || '');
  const confirm = String(req.body.password_confirm || '');
  const errors = {};

  if (!values.name) errors.name = 'الاسم الكامل مطلوب.';
  else if (values.name.length < 3) errors.name = 'أدخل الاسم الكامل.';
  else if (memberNo.letterFor(values.name) === 'X') errors.name = 'يجب أن يبدأ الاسم بحرف عربي أو إنجليزي.';

  const phone = normalizePhone(values.phone);
  if (!values.phone) errors.phone = 'رقم الهاتف مطلوب.';
  else if (!phone) errors.phone = 'رقم الهاتف غير صحيح. اكتبه مع رمز الدولة مثل ‎+968 9123 4567.';
  else if (db.prepare('SELECT 1 FROM users WHERE phone = ?').get(phone)) errors.phone = 'رقم الهاتف مسجّل لعضو آخر.';

  if (!clubs().includes(values.club)) errors.club = 'اختر النادي الذي لديك عضوية فيه.';
  if (password.length < 8) errors.password = 'كلمة المرور يجب أن تكون 8 خانات على الأقل.';
  if (password !== confirm) errors.password_confirm = 'كلمتا المرور غير متطابقتين.';

  if (Object.keys(errors).length) {
    return res.status(400).render('auth/register', { title: 'إنشاء حساب', values, errors, clubs: clubs() });
  }

  const hash = bcrypt.hashSync(password, 10);
  let no;
  // The UNIQUE constraint is the final guard if two members register at the same moment.
  for (let i = 0; i < 5; i++) {
    no = memberNo.generate(values.name);
    try {
      db.prepare('INSERT INTO users (member_no, name, phone, password_hash, role, club) VALUES (?, ?, ?, ?, ?, ?)')
        .run(no, values.name, phone, hash, 'member', values.club);
      break;
    } catch (e) {
      if (!String(e.message).includes('UNIQUE')) throw e;
      if (String(e.message).includes('phone')) {
        errors.phone = 'رقم الهاتف مسجّل لعضو آخر.';
        return res.status(400).render('auth/register', { title: 'إنشاء حساب', values, errors, clubs: clubs() });
      }
      no = null;
    }
  }
  if (!no) throw new Error('member number generation failed');
  req.session.newMemberNo = no;
  res.redirect('/register/done');
});

router.get('/register/done', (req, res) => {
  const no = req.session.newMemberNo;
  if (!no) return res.redirect('/login');
  res.render('auth/register-done', { title: 'تم إنشاء حسابك', memberNo: no });
});

// Forgot password / membership number: WhatsApp verification code.
router.get('/forgot', (req, res) => {
  res.render('auth/forgot', { title: 'استعادة الحساب', step: 'phone', values: {}, error: null });
});

router.post('/forgot', async (req, res) => {
  const phone = normalizePhone(req.body.phone);
  const render = (error) => res.status(400).render('auth/forgot', { title: 'استعادة الحساب', step: 'phone', values: { phone: req.body.phone }, error });
  if (!phone) return render('أدخل رقم الهاتف المسجّل مع رمز الدولة.');
  const user = db.prepare("SELECT * FROM users WHERE phone = ? AND role = 'member'").get(phone);
  if (user && user.active) {
    const code = String(crypto.randomInt(100000, 1000000));
    db.prepare('UPDATE otps SET used = 1 WHERE phone = ?').run(phone);
    db.prepare('INSERT INTO otps (phone, code_hash, expires_at) VALUES (?, ?, ?)')
      .run(phone, bcrypt.hashSync(code, 8), Date.now() + 10 * 60000);
    await whatsapp.send({ userId: user.id, phone, body: `رمز التحقق لنظام حجز الوجبات: ${code} (صالح لمدة 10 دقائق)`, kind: 'otp' });
  }
  // Same response whether or not the phone exists, so numbers cannot be probed.
  req.session.resetPhone = phone;
  res.render('auth/forgot', { title: 'استعادة الحساب', step: 'code', values: { phone }, error: null });
});

router.post('/forgot/verify', (req, res) => {
  const phone = req.session.resetPhone;
  if (!phone) return res.redirect('/forgot');
  const code = String(req.body.code || '').trim();
  const otp = db.prepare('SELECT * FROM otps WHERE phone = ? AND used = 0 ORDER BY id DESC LIMIT 1').get(phone);
  const bad = (error) => res.status(400).render('auth/forgot', { title: 'استعادة الحساب', step: 'code', values: { phone }, error });
  if (!otp || otp.expires_at < Date.now() || otp.attempts >= 5) return bad('انتهت صلاحية الرمز. اطلب رمزًا جديدًا.');
  if (!bcrypt.compareSync(code, otp.code_hash)) {
    db.prepare('UPDATE otps SET attempts = attempts + 1 WHERE id = ?').run(otp.id);
    return bad('رمز التحقق غير صحيح.');
  }
  db.prepare('UPDATE otps SET used = 1 WHERE id = ?').run(otp.id);
  const user = db.prepare("SELECT * FROM users WHERE phone = ? AND role = 'member'").get(phone);
  if (!user) return bad('رمز التحقق غير صحيح.');
  req.session.resetUserId = user.id;
  res.render('auth/forgot', { title: 'استعادة الحساب', step: 'reset', values: { memberNo: user.member_no }, error: null });
});

router.post('/forgot/reset', (req, res) => {
  const userId = req.session.resetUserId;
  if (!userId) return res.redirect('/forgot');
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  const password = String(req.body.password || '');
  if (password.length < 8 || password !== req.body.password_confirm) {
    return res.status(400).render('auth/forgot', { title: 'استعادة الحساب', step: 'reset', values: { memberNo: user.member_no },
      error: password.length < 8 ? 'كلمة المرور يجب أن تكون 8 خانات على الأقل.' : 'كلمتا المرور غير متطابقتين.' });
  }
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(password, 10), userId);
  db.prepare('DELETE FROM login_attempts WHERE member_no = ?').run(user.member_no);
  delete req.session.resetUserId;
  delete req.session.resetPhone;
  flash(req, 'success', `تم تغيير كلمة المرور. رقم عضويتك ${user.member_no}.`);
  res.redirect('/login');
});

module.exports = router;
