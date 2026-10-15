// Report files: CSV, Excel and PDF from a result ({ columns, rows }), plus a zip of one file per customer.
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const JSZip = require('jszip');
const { logoFor } = require('./brand');

const PDF_MAX_ROWS = 5000;
const FORMATS = { csv: { ext: 'csv', mime: 'text/csv; charset=utf-8' }, xlsx: { ext: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }, pdf: { ext: 'pdf', mime: 'application/pdf' } };

const slug = s => String(s || 'report').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 80) || 'report';
const fileName = (title, fmt, suffix) => `${slug(title)}${suffix ? '-' + slug(suffix) : ''}-${new Date().toISOString().slice(0, 10)}.${FORMATS[fmt].ext}`;

const isoDay = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const isoTime = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v);
function display(v, kind) {
  if (v == null) return '';
  if (kind === 'number' && typeof v === 'number') return v.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (isoTime(v)) return v.endsWith('T00:00:00.000Z') ? v.slice(0, 10) : v.replace('T', ' ').slice(0, 16);
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return String(v);
}

function toCSV({ columns, rows }) {
  const cell = v => {
    if (v == null) return '';
    let s = typeof v === 'string' && isoTime(v) && v.endsWith('T00:00:00.000Z') ? v.slice(0, 10) : String(v);
    if (/^[=+\-@\t\r]/.test(s) && !/^-?\d/.test(s)) s = "'" + s; // keep spreadsheet formulas from running
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + [columns.map(c => cell(c.label)).join(','), ...rows.map(r => r.map(cell).join(','))].join('\r\n') + '\r\n';
}

async function toXLSX({ columns, rows }, { title, subtitle, extraSheets = [] } = {}) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Reporting Center';
  const ws = wb.addWorksheet(String(title || 'Report').replace(/[*?:\\/[\]]/g, '').slice(0, 31) || 'Report');
  let start = 1;
  if (title) {
    ws.getCell(1, 1).value = title; ws.getCell(1, 1).font = { bold: true, size: 14 };
    if (subtitle) { ws.getCell(2, 1).value = subtitle; ws.getCell(2, 1).font = { italic: true, color: { argb: 'FF666666' } }; }
    start = subtitle ? 4 : 3;
  }
  const head = ws.getRow(start);
  columns.forEach((c, i) => { const cell = head.getCell(i + 1); cell.value = c.label; cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }; cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2E5BFF' } }; });
  rows.forEach((r, ri) => {
    const row = ws.getRow(start + 1 + ri);
    r.forEach((v, i) => {
      const k = columns[i].kind;
      if (v == null) return;
      if (k === 'number' && typeof v === 'number') { row.getCell(i + 1).value = v; row.getCell(i + 1).numFmt = Number.isInteger(v) ? '#,##0' : '#,##0.00'; }
      else if (isoDay(v)) { row.getCell(i + 1).value = new Date(v + 'T00:00:00Z'); row.getCell(i + 1).numFmt = 'yyyy-mm-dd'; }
      else if (isoTime(v)) { row.getCell(i + 1).value = new Date(v); row.getCell(i + 1).numFmt = v.endsWith('T00:00:00.000Z') ? 'yyyy-mm-dd' : 'yyyy-mm-dd hh:mm'; }
      else row.getCell(i + 1).value = typeof v === 'boolean' ? v : String(v);
    });
  });
  columns.forEach((c, i) => {
    const len = Math.max(String(c.label).length, ...rows.slice(0, 500).map(r => display(r[i], c.kind).length));
    ws.getColumn(i + 1).width = Math.min(60, Math.max(8, len + 2));
  });
  ws.views = [{ state: 'frozen', ySplit: start }];
  if (rows.length) ws.autoFilter = { from: { row: start, column: 1 }, to: { row: start + rows.length, column: columns.length } };
  for (const s of extraSheets) {
    const x = wb.addWorksheet(s.name.slice(0, 31));
    x.addRow(s.columns.map(c => c.label)).font = { bold: true };
    for (const r of s.rows) x.addRow(r.map(v => (v == null ? '' : v)));
    s.columns.forEach((c, i) => { x.getColumn(i + 1).width = Math.min(60, Math.max(10, String(c.label).length + 4)); });
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function toPDF({ columns, rows }, { title = 'Report', subtitle = '', brand = null, notes = [] } = {}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', layout: columns.length > 6 ? 'landscape' : 'portrait', margin: 36, bufferPages: true });
    const chunks = [];
    doc.on('data', c => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    const W = doc.page.width - 72, left = 36, bottom = () => doc.page.height - 50;
    const logo = (() => { try { return logoFor(null); } catch { return null; } })();
    let y = 36;
    if (logo) { try { doc.image(logo, left, y, { height: 28 }); y += 36; } catch {} }
    doc.font('Helvetica-Bold').fontSize(15).fillColor('#111').text(title, left, y, { width: W }); y = doc.y + 2;
    const sub = [subtitle, `Generated ${new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}`, `${rows.length.toLocaleString()} row${rows.length === 1 ? '' : 's'}`].filter(Boolean).join(' · ');
    doc.font('Helvetica').fontSize(8.5).fillColor('#555').text(sub, left, y, { width: W }); y = doc.y + 4;
    for (const n of notes) { doc.fillColor('#9a5b00').text(n, left, y, { width: W }); y = doc.y + 2; }
    y += 6;

    const shown = rows.slice(0, PDF_MAX_ROWS);
    const FS = columns.length > 12 ? 6.5 : columns.length > 8 ? 7.5 : 8.5;
    const weights = columns.map((c, i) => Math.min(40, Math.max(4, String(c.label).length * 0.8, ...shown.slice(0, 300).map(r => display(r[i], c.kind).length))));
    const sum = weights.reduce((a, b) => a + b, 0) || 1;
    const widths = weights.map(w => (w / sum) * W);
    const fit = (s, w) => { const max = Math.max(3, Math.floor(w / (FS * 0.5))); return s.length > max ? s.slice(0, max - 1) + '…' : s; };
    const rowH = FS + 6;
    const header = () => {
      doc.rect(left, y, W, rowH + 2).fill('#2e5bff');
      let x = left;
      doc.font('Helvetica-Bold').fontSize(FS).fillColor('#fff');
      columns.forEach((c, i) => { doc.text(fit(String(c.label), widths[i] - 4), x + 2, y + 4, { width: widths[i] - 4, lineBreak: false, align: c.kind === 'number' ? 'right' : 'left' }); x += widths[i]; });
      y += rowH + 2;
      doc.font('Helvetica').fillColor('#111');
    };
    header();
    shown.forEach((r, ri) => {
      if (y + rowH > bottom()) { doc.addPage(); y = 36; header(); }
      if (ri % 2) doc.rect(left, y, W, rowH).fill('#f3f5fb').fillColor('#111');
      let x = left;
      r.forEach((v, i) => { doc.fontSize(FS).fillColor('#111').text(fit(display(v, columns[i].kind), widths[i] - 4), x + 2, y + 3, { width: widths[i] - 4, lineBreak: false, align: columns[i].kind === 'number' ? 'right' : 'left' }); x += widths[i]; });
      y += rowH;
    });
    if (!rows.length) doc.fontSize(9).fillColor('#555').text('No rows match this report.', left, y + 6);
    if (rows.length > PDF_MAX_ROWS) doc.fontSize(8).fillColor('#9a5b00').text(`Showing the first ${PDF_MAX_ROWS.toLocaleString()} of ${rows.length.toLocaleString()} rows. Export to Excel or CSV for the full report.`, left, y + 6, { width: W });
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(i);
      doc.fontSize(7.5).fillColor('#888').text(`${brand?.name ? brand.name + ' · ' : ''}${title} · Page ${i + 1} of ${range.count}`, left, doc.page.height - 30, { width: W, align: 'center', lineBreak: false });
    }
    doc.end();
  });
}

/** One file in the requested format. */
async function render(result, fmt, opts = {}) {
  if (!FORMATS[fmt]) { const e = new Error('Choose CSV, Excel or PDF'); e.status = 400; throw e; }
  const content = fmt === 'csv' ? Buffer.from(toCSV(result), 'utf8') : fmt === 'xlsx' ? await toXLSX(result, opts) : await toPDF(result, opts);
  return { filename: fileName(opts.title, fmt, opts.suffix), mime: FORMATS[fmt].mime, content };
}

async function zip(files) {
  const z = new JSZip();
  const used = new Set();
  for (const f of files) { let n = f.filename, i = 2; while (used.has(n)) n = f.filename.replace(/(\.\w+)$/, `-${i++}$1`); used.add(n); z.file(n, f.content); }
  return z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

module.exports = { render, zip, toCSV, toXLSX, toPDF, display, FORMATS, fileName, PDF_MAX_ROWS };
