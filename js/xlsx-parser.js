/**
 * Parse XLSX (Excel) files to rows with merged cells resolved.
 * Uses SheetJS from CDN; loaded only when user selects an .xlsx file.
 * @module xlsx-parser
 */

const XLSX_CDN = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs';

/** Normalize cell value to string (for consistency with CSV parser). */
function cellStr(cell) {
  if (cell == null || cell === '') return '';
  if (typeof cell === 'number' && !Number.isNaN(cell)) return String(cell);
  if (typeof cell === 'boolean') return cell ? 'TRUE' : 'FALSE';
  if (cell instanceof Date) return cell.toISOString ? cell.toISOString() : String(cell);
  return String(cell).trim();
}

/**
 * Convert sheet to 2D array of strings, filling merged cells from the top-left value.
 * @param {object} XLSX - SheetJS library
 * @param {object} sheet - SheetJS worksheet (with !ref and optionally !merges)
 * @returns {string[][]}
 */
function sheetToRowsWithMerges(XLSX, sheet) {
  const range = XLSX.utils.decode_range(sheet['!ref'] || 'A1');
  const rows = [];
  for (let r = range.s.r; r <= range.e.r; r++) {
    const row = [];
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cellObj = sheet[XLSX.utils.encode_cell({ r, c })];
      const v = cellObj != null && cellObj.v !== undefined && cellObj.v !== null && cellObj.v !== '' ? cellObj.v : '';
      row.push(cellStr(v));
    }
    rows.push(row);
  }

  const merges = sheet['!merges'] || [];
  for (const m of merges) {
    const sr = m.s.r - range.s.r, sc = m.s.c - range.s.c;
    const er = m.e.r - range.s.r, ec = m.e.c - range.s.c;
    const topLeftVal = rows[sr] && rows[sr][sc] != null ? rows[sr][sc] : '';
    for (let r = sr; r <= er; r++) {
      for (let c = sc; c <= ec; c++) {
        if (rows[r]) rows[r][c] = topLeftVal;
      }
    }
  }

  return rows;
}

/**
 * Parse XLSX file (ArrayBuffer) to array of rows. First row = header.
 * Merged cells are resolved: each cell in a merge gets the top-left value.
 * @param {ArrayBuffer} arrayBuffer - Raw .xlsx file bytes
 * @returns {Promise<{ rows: string[][], error?: string }>}
 */
export async function parseXlsxToRows(arrayBuffer) {
  let XLSX;
  try {
    XLSX = await import(/* webpackIgnore: true */ XLSX_CDN);
  } catch (e) {
    return { rows: [], error: 'Could not load XLSX library. Check network or try CSV export.' };
  }

  try {
    const wb = XLSX.read(arrayBuffer, { type: 'array', cellDates: false });
    const firstSheetName = wb.SheetNames && wb.SheetNames[0];
    if (!firstSheetName) return { rows: [], error: 'Workbook has no sheets.' };
    const sheet = wb.Sheets[firstSheetName];
    if (!sheet || !sheet['!ref']) return { rows: [], error: 'First sheet is empty.' };
    const rows = sheetToRowsWithMerges(XLSX, sheet);
    if (!rows.length) return { rows: [], error: 'Sheet has no rows.' };
    return { rows, error: null };
  } catch (err) {
    return { rows: [], error: err && err.message ? err.message : 'Invalid or unsupported XLSX file.' };
  }
}
