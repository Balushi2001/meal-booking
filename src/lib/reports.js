// Monthly Excel reports (RTL): one sheet per member plus a summary sheet.
const ExcelJS = require('exceljs');
const { db } = require('../db');
const fmt = require('./format');
const ledger = require('./ledger');

const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F4C45' } };
const HEADER_FONT = { bold: true, color: { argb: 'FFFFFFFF' } };

function memberRows(userId, ym) {
  return db.prepare(`SELECT b.*, m.name AS meal_name, c.role AS creator_role FROM bookings b
    JOIN meals m ON m.id = b.meal_id LEFT JOIN users c ON c.id = b.created_by
    WHERE b.user_id = ? AND substr(b.date,1,7) = ? AND b.pickup_status <> 'cancelled'
    ORDER BY b.date, CASE b.type WHEN 'breakfast' THEN 1 WHEN 'lunch' THEN 2 ELSE 3 END`).all(userId, ym);
}

function styleHeader(row) {
  row.eachCell((c) => { c.fill = HEADER_FILL; c.font = HEADER_FONT; c.alignment = { horizontal: 'center' }; });
}

function sheetName(user) {
  return `${user.member_no} ${user.name}`.replace(/[\\/?*[\]:]/g, '').slice(0, 31);
}

function addMemberSheet(wb, user, ym) {
  const ws = wb.addWorksheet(sheetName(user), { views: [{ rightToLeft: true }] });
  ws.columns = [
    { header: 'اليوم', width: 12 }, { header: 'التاريخ', width: 12 }, { header: 'الوجبة', width: 10 },
    { header: 'الصنف', width: 26 }, { header: 'السعر (ر.ع)', width: 12 }, { header: 'طريقة الدفع', width: 13 },
    { header: 'حالة الدفع', width: 11 }, { header: 'الاستلام', width: 12 }, { header: 'الوقت', width: 9 },
    { header: 'النادي', width: 12 }, { header: 'طريقة الاستلام', width: 16 }, { header: 'ملاحظة', width: 16 },
  ];
  styleHeader(ws.getRow(1));
  for (const b of memberRows(user.id, ym)) {
    ws.addRow([
      fmt.dayName(b.date), b.date, fmt.MEAL_TYPES_SHORT[b.type], b.meal_name, b.price / 1000,
      fmt.PAYMENT_METHOD[b.payment_method], fmt.PAYMENT_STATUS[b.payment_status], fmt.PICKUP_STATUS[b.pickup_status],
      b.picked_at ? fmt.timeOf(b.picked_at) : '—', b.club || '', b.pickup_mode ? fmt.PICKUP_MODE[b.pickup_mode] : '',
      b.creator_role === 'admin' ? 'بواسطة المشرف' : '',
    ]);
  }
  ws.getColumn(5).numFmt = '0.000';
  const t = ledger.monthTotals(user.id, ym);
  ws.addRow([]);
  const total = ws.addRow(['', '', '', 'الإجمالي', t.total / 1000, '', `مستحق ${fmt.money(t.due)}`, `مدفوع ${fmt.money(t.paid)}`]);
  total.font = { bold: true };
  ws.insertRow(1, [`${user.name} · ${user.member_no} · ${fmt.monthName(ym)}`]).font = { bold: true, size: 13 };
  ws.mergeCells('A1:L1');
  return t;
}

async function memberWorkbook(userId, ym) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'نظام حجز الوجبات';
  addMemberSheet(wb, user, ym);
  return wb;
}

async function allMembersWorkbook(ym) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'نظام حجز الوجبات';
  const summary = wb.addWorksheet('الملخص', { views: [{ rightToLeft: true }] });
  summary.columns = [
    { header: 'رقم العضوية', width: 13 }, { header: 'الاسم', width: 24 }, { header: 'الهاتف', width: 16 },
    { header: 'النادي', width: 12 }, { header: 'عدد الوجبات', width: 12 }, { header: 'الإجمالي (ر.ع)', width: 14 },
    { header: 'المدفوع (ر.ع)', width: 14 }, { header: 'المستحق (ر.ع)', width: 14 },
  ];
  styleHeader(summary.getRow(1));
  const users = db.prepare(`SELECT u.* FROM users u WHERE role = 'member'
    AND EXISTS (SELECT 1 FROM bookings b WHERE b.user_id = u.id AND substr(b.date,1,7) = ? AND b.pickup_status <> 'cancelled')
    ORDER BY u.member_no`).all(ym);
  const sums = { count: 0, total: 0, paid: 0, due: 0 };
  for (const u of users) {
    const t = addMemberSheet(wb, u, ym);
    const count = memberRows(u.id, ym).length;
    summary.addRow([u.member_no, u.name, u.phone, u.club, count, t.total / 1000, t.paid / 1000, t.due / 1000]);
    sums.count += count; sums.total += t.total; sums.paid += t.paid; sums.due += t.due;
  }
  const r = summary.addRow(['', 'الإجمالي', '', '', sums.count, sums.total / 1000, sums.paid / 1000, sums.due / 1000]);
  r.font = { bold: true };
  for (const c of [6, 7, 8]) summary.getColumn(c).numFmt = '0.000';
  return wb;
}

async function kitchenWorkbook(date) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('ملخص المطبخ', { views: [{ rightToLeft: true }] });
  ws.columns = [
    { header: 'الوجبة', width: 10 }, { header: 'الصنف', width: 26 }, { header: 'النادي', width: 12 },
    { header: 'سفري', width: 9 }, { header: 'جلوس', width: 9 }, { header: 'العدد', width: 9 },
  ];
  styleHeader(ws.getRow(1));
  const rows = db.prepare(`SELECT b.type, m.name, b.club,
      SUM(b.pickup_mode = 'takeaway') AS takeaway, SUM(b.pickup_mode = 'dinein') AS dinein, COUNT(*) AS total
    FROM bookings b JOIN meals m ON m.id = b.meal_id WHERE b.date = ? AND b.pickup_status <> 'cancelled'
    GROUP BY b.type, m.id, b.club ORDER BY CASE b.type WHEN 'breakfast' THEN 1 WHEN 'lunch' THEN 2 ELSE 3 END, m.name, b.club`).all(date);
  for (const r of rows) ws.addRow([fmt.MEAL_TYPES_SHORT[r.type], r.name, r.club, r.takeaway, r.dinein, r.total]);
  ws.insertRow(1, [`ملخص وجبات ${fmt.dateFull(date)}`]).font = { bold: true, size: 13 };
  ws.mergeCells('A1:F1');
  return wb;
}

async function send(res, wb, filename) {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="report.xlsx"; filename*=UTF-8''${encodeURIComponent(filename)}`);
  await wb.xlsx.write(res);
  res.end();
}

module.exports = { memberWorkbook, allMembersWorkbook, kitchenWorkbook, send, memberRows };
