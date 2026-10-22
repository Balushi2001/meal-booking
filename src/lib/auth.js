function flash(req, type, text) {
  req.session.flash = { type, text };
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.redirect('/login');
    if (!roles.includes(req.user.role)) return res.redirect(homeFor(req.user));
    next();
  };
}

function homeFor(user) {
  if (!user) return '/login';
  if (user.role === 'admin') return '/admin';
  if (user.role === 'kiosk') return '/kiosk';
  return '/';
}

// "+968 9123 4567", "91234567", "0096891234567" -> "+96891234567"
function normalizePhone(input) {
  let digits = String(input || '').replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) digits = digits.slice(1);
  else if (digits.startsWith('00')) digits = digits.slice(2);
  else if (/^[79]\d{7}$/.test(digits)) digits = `968${digits}`;
  digits = digits.replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 15) return null;
  return `+${digits}`;
}

module.exports = { flash, requireRole, homeFor, normalizePhone };
