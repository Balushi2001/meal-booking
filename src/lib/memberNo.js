// Membership number = first letter of the name (as an English capital) + 3 distinct random digits, e.g. A527.
const crypto = require('node:crypto');
const { db } = require('../db');

const ARABIC_TO_LATIN = {
  'ا': 'A', 'أ': 'A', 'إ': 'A', 'آ': 'A', 'ء': 'A', 'ع': 'A',
  'ب': 'B', 'ت': 'T', 'ث': 'T', 'ط': 'T', 'ج': 'J', 'ح': 'H', 'ه': 'H', 'ة': 'H',
  'خ': 'K', 'ك': 'K', 'د': 'D', 'ذ': 'D', 'ض': 'D', 'ر': 'R', 'ز': 'Z', 'ظ': 'Z',
  'س': 'S', 'ش': 'S', 'ص': 'S', 'غ': 'G', 'ف': 'F', 'ق': 'Q', 'ل': 'L', 'م': 'M',
  'ن': 'N', 'و': 'W', 'ي': 'Y', 'ى': 'Y',
};

const CAPACITY_3 = 10 * 9 * 8; // 720 numbers per letter with distinct digits

function letterFor(name) {
  const ch = name.trim().charAt(0);
  if (/[a-z]/i.test(ch)) return ch.toUpperCase();
  return ARABIC_TO_LATIN[ch] || 'X';
}

function randomDistinctDigits(n) {
  const digits = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
  for (let i = digits.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [digits[i], digits[j]] = [digits[j], digits[i]];
  }
  return digits.slice(0, n).join('');
}

function usedCount(letter, digits = 3) {
  return db.prepare(`SELECT COUNT(*) AS c FROM users WHERE member_no GLOB ?`)
    .get(`${letter}${'[0-9]'.repeat(digits)}`).c;
}

function generate(name) {
  const letter = letterFor(name);
  const digits = usedCount(letter, 3) < CAPACITY_3 ? 3 : 4;
  const exists = db.prepare('SELECT 1 FROM users WHERE member_no = ?');
  for (let attempt = 0; attempt < 5000; attempt++) {
    const candidate = letter + randomDistinctDigits(digits);
    if (!exists.get(candidate)) return candidate;
  }
  throw new Error('تعذّر توليد رقم عضوية جديد');
}

// Letters at 90% or more of their 3-digit capacity, for the admin dashboard warning.
function capacityWarnings() {
  const rows = db.prepare(`SELECT substr(member_no,1,1) AS letter, COUNT(*) AS c FROM users
    WHERE role = 'member' AND member_no GLOB '[A-Z][0-9][0-9][0-9]' GROUP BY letter`).all();
  return rows.filter((r) => r.c >= CAPACITY_3 * 0.9).map((r) => ({ letter: r.letter, used: r.c, capacity: CAPACITY_3 }));
}

module.exports = { generate, letterFor, capacityWarnings, CAPACITY_3 };
