// Display helpers shared by all views.
const MEAL_TYPES = { breakfast: 'الإفطار', lunch: 'الغداء', dinner: 'العشاء' };
const MEAL_TYPES_SHORT = { breakfast: 'إفطار', lunch: 'غداء', dinner: 'عشاء' };
const PICKUP_STATUS = { booked: 'محجوز', picked: 'تم الاستلام', no_show: 'لم يُستلم', cancelled: 'ملغى' };
const PAYMENT_STATUS = { paid: 'مدفوع', due: 'مستحق' };
const PAYMENT_METHOD = { now: 'دفع فوري', salary: 'عند الراتب' };
const PICKUP_MODE = { takeaway: 'سفري (بارسل)', dinein: 'الجلوس في النادي' };
const PRICE_LIST = Array.from({ length: 16 }, (_, i) => 500 + i * 100);

const LOCALE = 'ar-u-nu-latn';

function money(baisa) {
  return (Number(baisa || 0) / 1000).toFixed(3);
}

function toDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function dayName(s) {
  return new Intl.DateTimeFormat(LOCALE, { weekday: 'long' }).format(toDate(s));
}

function dateLong(s) {
  return new Intl.DateTimeFormat(LOCALE, { weekday: 'long', day: 'numeric', month: 'long' }).format(toDate(s));
}

function dateFull(s) {
  return new Intl.DateTimeFormat(LOCALE, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(toDate(s));
}

function dateShort(s) {
  const d = toDate(s);
  return `${d.getDate()}/${d.getMonth() + 1}`;
}

function monthName(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Intl.DateTimeFormat(LOCALE, { month: 'long', year: 'numeric' }).format(new Date(y, m - 1, 1));
}

function monthOnly(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Intl.DateTimeFormat(LOCALE, { month: 'long' }).format(new Date(y, m - 1, 1));
}

function timeOf(datetime) {
  return datetime ? datetime.slice(11, 16) : '—';
}

function clock(date) {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function shiftMonth(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

module.exports = {
  clock, shiftMonth,
  MEAL_TYPES, MEAL_TYPES_SHORT, PICKUP_STATUS, PAYMENT_STATUS, PAYMENT_METHOD, PICKUP_MODE, PRICE_LIST,
  money, dayName, dateLong, dateFull, dateShort, monthName, monthOnly, timeOf,
};
