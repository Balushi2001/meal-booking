// All dates are handled in the app timezone (process.env.TZ, default Asia/Muscat).
const { getSetting } = require('../db');

const pad = (n) => String(n).padStart(2, '0');

function ymd(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parseYmd(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function addDays(s, n) {
  const d = parseYmd(s);
  d.setDate(d.getDate() + n);
  return ymd(d);
}

function hm(d = new Date()) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function minutesOf(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function cutoffFor(today) {
  const [h, m] = getSetting('cutoff_time').split(':').map(Number);
  const d = parseYmd(today);
  d.setHours(h, m, 0, 0);
  return d;
}

// The date members are currently booking for: tomorrow, or the day after once today's cutoff has passed.
function bookingTarget(now = new Date()) {
  const today = ymd(now);
  const cutoff = cutoffFor(today);
  if (now < cutoff) return { date: addDays(today, 1), closesAt: cutoff };
  const next = addDays(today, 1);
  return { date: addDays(today, 2), closesAt: cutoffFor(next) };
}

function isBookingOpenFor(date, now = new Date()) {
  return bookingTarget(now).date === date;
}

function monthOf(s) {
  return s.slice(0, 7);
}

function shiftMonth(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

// Which meal is being served right now according to the kiosk meal windows.
function currentMealType(now = new Date()) {
  const t = minutesOf(hm(now));
  for (const type of ['breakfast', 'lunch', 'dinner']) {
    const [from, to] = getSetting(`${type}_window`).split('-');
    if (t >= minutesOf(from) && t <= minutesOf(to)) return type;
  }
  return null;
}

module.exports = { ymd, parseYmd, addDays, hm, minutesOf, bookingTarget, isBookingOpenFor, monthOf, shiftMonth, currentMealType, cutoffFor };
