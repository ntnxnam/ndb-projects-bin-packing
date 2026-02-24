/**
 * Parse prioritization CSV (same columns as Sheet1 / prepare-data.js).
 * Used by the Upload CSV tab to refresh project data without changing column expectations.
 * @module csv-parser
 */

import { SIZING_MONTHS } from './sizing.js';
import { detectResourceGroups } from './resource-groups.js';
import { logger } from './logger.js';

/**
 * Parse raw CSV text into rows of cells (handles quoted fields and commas).
 * @param {string} text - Raw CSV string.
 * @returns {string[][]}
 */
export function parseCSV(text) {
  const rows = [];
  let i = 0;
  const len = text.length;

  while (i < len) {
    const row = [];
    while (i < len) {
      if (text[i] === '"') {
        let cell = '';
        i++;
        while (i < len) {
          if (text[i] === '"') {
            if (text[i + 1] === '"') {
              cell += '"';
              i += 2;
            } else {
              i++;
              break;
            }
          } else {
            cell += text[i];
            i++;
          }
        }
        row.push(cell);
        if (text[i] === ',') i++;
        else if (text[i] === '\n' || text[i] === '\r') {
          if (text[i] === '\r' && text[i + 1] === '\n') i += 2;
          else i++;
          break;
        } else if (i >= len) break;
      } else {
        let cell = '';
        while (i < len && text[i] !== ',' && text[i] !== '\n' && text[i] !== '\r') {
          cell += text[i];
          i++;
        }
        row.push(cell.trim());
        if (text[i] === ',') i++;
        else {
          if (text[i] === '\r' && text[i + 1] === '\n') i += 2;
          else i++;
          break;
        }
      }
    }
    if (row.some(c => c !== '')) rows.push(row);
  }
  return rows;
}

/**
 * Parse "Dependency Numbers (Comma Separated List)".
 * Numbers are Sl No. Mark as dev-blocker when "(dev-blocker)" in same segment; rel-blocker when "(rel-blocker)".
 * e.g. "33 (dev-blocker)" -> 33 is dev-blocker; "6 (rel-blocker)" -> 6 is rel-blocker; "2" -> plain.
 */
function parseDependencyNumbersAndBlockers(raw) {
  if (!raw || typeof raw !== 'string') return { rowNumbers: [], devBlockers: [], relBlockers: [] };
  const rowNumbers = [];
  const devBlockers = [];
  const relBlockers = [];
  const parts = raw.split(/[,;]/);
  for (const part of parts) {
    const trimmed = part.trim();
    const numMatch = trimmed.match(/\d+/);
    if (numMatch) {
      const num = parseInt(numMatch[0], 10);
      rowNumbers.push(num);
      if (/\d+\s*\(\s*dev-blocker\s*\)/i.test(trimmed)) devBlockers.push(num);
      else if (/\d+\s*\(\s*rel-blocker\s*\)/i.test(trimmed)) relBlockers.push(num);
    }
  }
  return {
    rowNumbers: [...new Set(rowNumbers)],
    devBlockers: [...new Set(devBlockers)],
    relBlockers: [...new Set(relBlockers)],
  };
}

/**
 * Convert rows (header + data rows) to projects array.
 * Same column mapping as Sheet1: FEAT NUMBER, SUMMARY, Dev Resources, Total Months Needed, etc.
 * Use for CSV (after parseCSV) or XLSX (after parseXlsxToRows). No rows omitted.
 * @param {string[][]} rows - First row = header, rest = data
 * @returns {{ projects: object[], error: string|null }}
 */
/** Normalize header cell: trim, strip BOM, strip optional surrounding double quotes. */
function normalizeHeaderCell(h) {
  let s = (h != null ? String(h) : '').trim();
  if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1).trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1).trim();
  return s;
}

export function rowsToProjects(rows) {
  const rawHeader = (rows && rows[0]) ? rows[0] : [];
  const header = rawHeader.map(h => normalizeHeaderCell(h));
  const dataRows = rows && rows.length > 1 ? rows.slice(1) : [];

  if (!header.length || !dataRows.length) return { projects: [], error: 'No header or data rows.' };

  const idx = (name) => {
    const n = (name || '').trim();
    const i = header.findIndex(h => (h || '').trim() === n);
    return i >= 0 ? i : -1;
  };
  const idxContains = (sub) => header.findIndex(h => (h || '').trim().indexOf(sub) !== -1);
  const iSlNo = idx('Sl No') >= 0 ? idx('Sl No') : idx('Sl. No') >= 0 ? idx('Sl. No') : idxContains('Sl No');
  const iFirstCol = iSlNo >= 0 ? iSlNo : 0;
  const iFeat = idx('FEAT NUMBER') >= 0 ? idx('FEAT NUMBER') : idxContains('FEAT NUMBER');
  const iSummary = idx('SUMMARY') >= 0 ? idx('SUMMARY') : idxContains('SUMMARY');
  if (iFeat < 0 || iSummary < 0) {
    return { projects: [], error: 'Sheet must include "FEAT NUMBER" and "SUMMARY" columns. Check the header row.' };
  }
  const iPriority = idx('Priority');
  const iStatus = idx('STATUS');
  const iCommit = idx('3.0 Commitment Status');
  const iDevResources = idx('Dev Resources required for max parallization');
  const iDevResources60 = header.findIndex(h => (h || '').trim().indexOf('Dev Resources required for max parallization and 60% productivity') !== -1);
  const iSizing = idx('sizing (refer sheet 2 for guidance)');
  const iDri = idx('DRI');
  const iDependencyNumbers = idx('Dependency Numbers (Comma Separated List)');
  const iNumberMonthsDev = idx('Number of Months (Dev)');
  /* Total person-months: exact name, or header that contains the key phrase (Excel/export variations). */
  const iTotalPersonMonthsByName = idx('Total Months Needed for 1 person by Dev (Everything from start to finish)');
  const iTotalPersonMonthsStartsWith = header.findIndex(h => (h || '').trim().indexOf('Total Months Needed for 1 person by Dev') === 0);
  const iTotalPersonMonthsContains = header.findIndex(h => {
    const t = (h || '').trim().toLowerCase();
    return t.includes('total months needed') && (t.includes('1 person') || t.includes('person by dev')) && (t.includes('start to finish') || t.includes('everything'));
  });
  const _totalPersonMonthsCol = iTotalPersonMonthsByName >= 0
    ? iTotalPersonMonthsByName
    : iTotalPersonMonthsStartsWith >= 0
      ? iTotalPersonMonthsStartsWith
      : iTotalPersonMonthsContains;
  const iQAResources = header.findIndex(h => (h || '').trim().indexOf('Num of QA required') === 0);
  const iAdditionalResources = idx('Additional Resources');
  const iSizingComment = idx('Sizing Comment');
  const iCompletedPctExact = idx('How much of this is Completed in % (do not add %, just put a number)');
  const iCompletedPctByKeyword = header.findIndex(h => {
    const t = (h || '').trim().toLowerCase();
    return (t.indexOf('completed') !== -1 && (t.indexOf('%') !== -1 || t.indexOf('percent') !== -1))
      || t.indexOf('progress') !== -1;
  });
  const iCompletedPct = iCompletedPctExact >= 0 ? iCompletedPctExact : iCompletedPctByKeyword;
  const iCompletedPctFallback = iCompletedPct >= 0 ? iCompletedPct : 5;

  const projects = [];

  for (const row of dataRows) {
    const commitment = (row[iCommit] || '').trim();
    const sizingRaw = (row[iSizing] || '').trim();
    const months = SIZING_MONTHS[sizingRaw];
    const monthsFromSizing = months !== undefined ? months : 0;

    let devResources = parseFloat(String(row[iDevResources] || '').replace(/,/g, ''));
    if (Number.isNaN(devResources) || devResources < 0) devResources = 0;

    let devResources60 = null;
    if (iDevResources60 >= 0 && row[iDevResources60]) {
      const val = parseFloat(String(row[iDevResources60]).replace(/,/g, ''));
      if (!Number.isNaN(val) && val >= 0) devResources60 = Math.round(val * 100) / 100;
    }

    const feat = (row[iFeat] || '').trim();
    const summary = (row[iSummary] || '').trim().replace(/\s+/g, ' ') || feat || '';
    const dri = (row[iDri] || '').trim();
    const priority = (row[iPriority] || '').trim();
    const status = iStatus >= 0 ? (row[iStatus] || '').trim() : '';

    const rowNumRaw = (row[iFirstCol] || '').trim();
    const rowNumber = rowNumRaw && !Number.isNaN(parseInt(rowNumRaw, 10)) ? parseInt(rowNumRaw, 10) : null;
    const { rowNumbers: dependencyRowNumbers, devBlockers: dependencyDevBlockers, relBlockers: dependencyRelBlockers } = parseDependencyNumbersAndBlockers(row[iDependencyNumbers]);

    /* Every row is a project. Rows without Sl No get assigned row number 9000 + index. */
    const assignedRowNumber = rowNumber != null ? rowNumber : 9000 + projects.length;

    const totalPersonMonthsRaw = _totalPersonMonthsCol >= 0 ? (row[_totalPersonMonthsCol] || '').trim() : '';
    const additionalResources = iAdditionalResources >= 0 ? (row[iAdditionalResources] || '').trim() : '';
    const sizingComment = iSizingComment >= 0 ? (row[iSizingComment] || '').trim() : '';

    let qaResources = iQAResources >= 0 && row[iQAResources] ? parseFloat(String(row[iQAResources]).replace(/,/g, '')) : NaN;
    if (Number.isNaN(qaResources) || qaResources < 0) {
      qaResources = null;
    } else {
      qaResources = Math.round(qaResources * 100) / 100;
    }

    /* Duration priority:
       1. "Number of Months (Dev)" — explicit calculated duration
       2. "Total Months for 1 person" / "Dev Resources" — derive: ceil(totalMonths / devResources)
       3. "sizing (refer sheet 2 for guidance)" — ceiling from SIZING_MONTHS (last resort)
       4. Default: 0 (blank fields use 1 month in the packer) */
    const numMonthsDev = (iNumberMonthsDev >= 0 && row[iNumberMonthsDev]) ? parseFloat(String(row[iNumberMonthsDev]).replace(/,/g, '')) : NaN;
    const totalPersonMonthsNum = totalPersonMonthsRaw ? parseFloat(String(totalPersonMonthsRaw).replace(/,/g, '')) : NaN;

    let durationMonths;
    if (!Number.isNaN(numMonthsDev) && numMonthsDev > 0) {
      durationMonths = numMonthsDev;
    } else if (!Number.isNaN(totalPersonMonthsNum) && totalPersonMonthsNum > 0 && devResources > 0) {
      durationMonths = Math.ceil(totalPersonMonthsNum / devResources);
    } else if (!Number.isNaN(totalPersonMonthsNum) && totalPersonMonthsNum > 0) {
      /* devResources = 0 but Total Months is known (formula gives #DIV/0! in sheet): treat as 1 dev. */
      durationMonths = Math.ceil(totalPersonMonthsNum);
      if (devResources === 0) devResources = 1;
    } else if (monthsFromSizing > 0) {
      durationMonths = monthsFromSizing;
    } else {
      durationMonths = 0;
    }

    const inProgress = /in\s*progress/i.test(status);
    const completedPctRaw = (iCompletedPct >= 0 ? row[iCompletedPct] : row[iCompletedPctFallback]) || '';
    let completedPct = parseFloat(String(completedPctRaw).replace(/,/g, '').trim());
    if (Number.isNaN(completedPct) || completedPct < 0) completedPct = 0;
    completedPct = Math.min(100, Math.max(0, completedPct));

    projects.push({
      id: `row-${assignedRowNumber}`,
      rowNumber: assignedRowNumber,
      feat: feat || '',
      summary: summary.slice(0, 120),
      dri,
      priority: priority || 'P0',
      status,
      inProgress,
      completedPct,
      commitment,
      totalResources: Math.round(devResources * 100) / 100,
      qaResources,
      sizingLabel: sizingRaw,
      durationMonths,
      dependencyRowNumbers,
      dependencyDevBlockers: dependencyDevBlockers || [],
      dependencyRelBlockers: dependencyRelBlockers || [],
      totalPersonMonths: totalPersonMonthsRaw,
      totalPersonMonthsNum: Number.isNaN(totalPersonMonthsNum) ? null : totalPersonMonthsNum,
      totalResources60: devResources60,
      additionalResources,
      sizingComment,
    });
  }

  detectResourceGroups(projects);
  logger.debug('csv-parser.rowsToProjects: parsed', projects.length, 'projects');
  return { projects, error: null };
}

/**
 * Convert CSV text (header + data rows) to projects array.
 * @param {string} csvText - Raw CSV string
 * @returns {{ projects: object[], error: string|null }}
 */
export function csvToProjects(csvText) {
  const rows = parseCSV(csvText);
  return rowsToProjects(rows);
}

// Re-export so callers can import detectResourceGroups from csv-parser.
export { detectResourceGroups } from './resource-groups.js';
