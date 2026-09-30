// Minimal RFC 4180 CSV reader/writer (handles quotes, commas and newlines in cells).

export function parseCsv(text) {
  text = text.replace(/^﻿/, ''); // Excel adds a byte-order mark
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }

  const nonEmpty = rows.filter((r) => r.some((c) => c.trim() !== ''));
  if (!nonEmpty.length) return { headers: [], records: [] };

  const headers = nonEmpty[0].map((h) => h.trim().toLowerCase().replace(/[\s-]+/g, '_'));
  const records = nonEmpty.slice(1).map((cells, index) => {
    const record = { _line: index + 2 };
    headers.forEach((h, i) => (record[h] = (cells[i] ?? '').trim()));
    return record;
  });
  return { headers, records };
}

export function toCsv(headers, rows) {
  const escape = (value) => {
    const s = value == null ? '' : String(value);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers, ...rows].map((r) => r.map(escape).join(',')).join('\r\n') + '\r\n';
}
