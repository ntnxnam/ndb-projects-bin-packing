/**
 * Parse staff from spreadsheet rows (XLSX or CSV). Expects columns: Name, Capacity %.
 * @module staff-parser
 */

/**
 * Parse CSV text to array of rows (string[][]). Handles quoted fields.
 * @param {string} text
 * @returns {string[][]}
 */
export function parseCsvToRows(text) {
  const rows = [];
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  for (const line of lines) {
    if (!line) continue;
    const row = [];
    let i = 0;
    while (i < line.length) {
      if (line[i] === '"') {
        let cell = '';
        i++;
        while (i < line.length) {
          if (line[i] === '"') {
            i++;
            if (line[i] === '"') {
              cell += '"';
              i++;
            } else break;
          } else {
            cell += line[i];
            i++;
          }
        }
        row.push(cell.trim());
      } else {
        const end = line.indexOf(',', i);
        const slice = end === -1 ? line.slice(i) : line.slice(i, end);
        row.push(slice.trim());
        i = end === -1 ? line.length : end + 1;
      }
    }
    rows.push(row);
  }
  return rows;
}

/** Normalize header for column matching. */
function norm(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Find column index by header (flexible names). */
function findCol(headerRow, names) {
  const normalized = names.map(norm);
  for (let c = 0; c < headerRow.length; c++) {
    const h = norm(headerRow[c]);
    if (normalized.some((n) => h.includes(n) || n.includes(h))) return c;
  }
  return -1;
}

/**
 * Convert rows (first row = header) to staff list. Columns: Name (or "Staff name"), Capacity % (or "Capacity").
 * @param {string[][]} rows
 * @returns {{ staff: { id: string, name: string, capacityPct: number }[], error?: string }}
 */
export function rowsToStaff(rows) {
  if (!rows || rows.length < 2) {
    return { staff: [], error: 'Need a header row and at least one data row.' };
  }
  const header = rows[0].map((c) => String(c).trim());
  const nameCol = findCol(header, ['name', 'staff name', 'person', 'resource']);
  const capCol = findCol(header, ['capacity %', 'capacity', 'capacity (%)', 'capacity pct']);
  if (nameCol < 0) return { staff: [], error: 'Could not find a "Name" (or "Staff name") column.' };
  if (capCol < 0) return { staff: [], error: 'Could not find a "Capacity %" (or "Capacity") column.' };

  const staff = [];
  const DEFAULT_CAPACITY = 80;
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const name = (row[nameCol] != null ? String(row[nameCol]) : '').trim();
    if (!name) continue;
    let cap = DEFAULT_CAPACITY;
    const capVal = row[capCol];
    if (capVal != null && String(capVal).trim() !== '') {
      const n = parseFloat(String(capVal).replace(/%/g, ''));
      if (!Number.isNaN(n)) cap = Math.max(0.1, Math.min(100, n));
    }
    staff.push({
      id: `staff-${r}`,
      name,
      capacityPct: cap,
    });
  }
  return { staff, error: null };
}
