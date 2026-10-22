// Fills the database with sample members, menus and bookings so every screen has something to show.
process.env.TZ = process.env.APP_TZ || 'Asia/Muscat';

const bcrypt = require('bcryptjs');
const { db, tx, clubs } = require('./db');
const memberNo = require('./lib/memberNo');
const ledger = require('./lib/ledger');
const time = require('./lib/time');

const MEMBERS = [
  ['أحمد سالم', '+96891001234'], ['سالم خالد', '+96891005521'], ['مريم ناصر', '+96891007740'],
  ['فاطمة علي', '+96891003082'], ['خالد سعيد', '+96891004411'], ['نورة حمد', '+96891006620'],
];

const MENU = [
  ['breakfast', 'فول مدمس وبيض', 'فول بالكمون مع بيض مسلوق وخبز', 800],
  ['breakfast', 'شكشوكة', 'بيض بالطماطم والفلفل مع خبز', 900],
  ['lunch', 'مجبوس دجاج', 'أرز بالبهارات العُمانية مع سلطة ولبن', 1500],
  ['lunch', 'برياني لحم', 'أرز برياني مع لحم ورايتا', 1800],
  ['dinner', 'شوربة عدس وسندويش', 'شوربة عدس مع سندويش جبن', 700],
  ['dinner', 'سلطة دجاج', 'سلطة خضراء مع دجاج مشوي', 1000],
];

const password = bcrypt.hashSync('12345678', 10);
const today = time.ymd();
const dates = [-3, -2, -1, 0, 1, 2].map((n) => time.addDays(today, n));
const clubList = clubs();

tx(() => {
  const users = MEMBERS.map(([name, phone], i) => {
    const existing = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
    if (existing) return existing;
    const no = memberNo.generate(name);
    const r = db.prepare("INSERT INTO users (member_no, name, phone, password_hash, role, club) VALUES (?, ?, ?, ?, 'member', ?)")
      .run(no, name, phone, password, clubList[i % clubList.length]);
    return db.prepare('SELECT * FROM users WHERE id = ?').get(r.lastInsertRowid);
  });

  for (const date of dates) {
    if (db.prepare('SELECT 1 FROM meals WHERE date = ?').get(date)) continue;
    const ins = db.prepare('INSERT INTO meals (date, type, name, description, price) VALUES (?, ?, ?, ?, ?)');
    for (const m of MENU) ins.run(date, ...m);
  }

  // Past and today's bookings (tomorrow is left open so the booking flow can be tried).
  const insB = db.prepare(`INSERT OR IGNORE INTO bookings (user_id, meal_id, date, type, price, payment_method, payment_status,
    pickup_status, picked_at, club, pickup_mode, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  users.forEach((u, ui) => {
    for (const date of dates.filter((d) => d <= today)) {
      const meals = db.prepare('SELECT * FROM meals WHERE date = ?').all(date);
      for (const type of ['breakfast', 'lunch', 'dinner']) {
        if ((ui + type.length + date.charCodeAt(9)) % 3 === 0) continue;
        const options = meals.filter((m) => m.type === type);
        const meal = options[(ui + date.charCodeAt(9)) % options.length];
        const method = ui % 3 === 1 ? 'now' : 'salary';
        const past = date < today;
        const picked = past && (ui + type.length) % 4 !== 0;
        insB.run(u.id, meal.id, date, type, meal.price, method, method === 'now' ? 'paid' : 'due',
          picked ? 'picked' : past ? 'no_show' : 'booked', picked ? `${date} 12:${String(10 + ui).padStart(2, '0')}:00` : null,
          u.club, ui % 2 ? 'dinein' : 'takeaway', u.id);
      }
    }
    ledger.recompute(u.id);
  });
});

console.log('تمت إضافة البيانات التجريبية. كلمة مرور كل الأعضاء التجريبيين: 12345678');
for (const u of db.prepare("SELECT member_no, name FROM users WHERE role = 'member' ORDER BY id").all()) {
  console.log(`  ${u.member_no}  ${u.name}`);
}
