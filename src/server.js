process.env.TZ = process.env.APP_TZ || 'Asia/Muscat';

const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const session = require('express-session');
const { db } = require('./db');
const SqliteStore = require('./lib/sessionStore');
const fmt = require('./lib/format');
const scheduler = require('./lib/scheduler');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const store = new SqliteStore();
setInterval(() => store.prune(), 60 * 60 * 1000).unref();
app.use(session({
  store,
  name: 'mb.sid',
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.COOKIE_SECURE === '1',
    maxAge: 365 * 24 * 60 * 60 * 1000, // sessions stay open on the member's device until logout
  },
}));

// Current user + view helpers.
app.use((req, res, next) => {
  res.locals.fmt = fmt;
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  res.locals.path = req.path;
  if (req.session.userId) {
    const user = db.prepare('SELECT id, member_no, name, phone, role, club, active FROM users WHERE id = ?').get(req.session.userId);
    if (!user || !user.active) {
      req.session.userId = null;
    } else {
      req.user = user;
    }
  }
  res.locals.user = req.user || null;
  next();
});

app.use(require('./routes/auth'));
app.use('/kiosk', require('./routes/kiosk'));
app.use('/admin', require('./routes/admin'));
app.use(require('./routes/member'));

app.use((req, res) => res.status(404).render('error', { title: 'الصفحة غير موجودة', message: 'الصفحة التي تبحث عنها غير موجودة.' }));
app.use((err, req, res, _next) => {
  console.error(err);
  res.status(500).render('error', { title: 'حدث خطأ', message: 'حدث خطأ غير متوقع، حاول مرة أخرى.' });
});

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => {
    console.log(`نظام حجز الوجبات يعمل على http://localhost:${port}`);
    scheduler.start();
  });
}

module.exports = app;
