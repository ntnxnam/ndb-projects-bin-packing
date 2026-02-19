/**
 * Parse prioritization CSV (same columns as Sheet1 / prepare-data.js).
 * Used by the Upload CSV tab to refresh project data without changing column expectations.
 */

export const SIZING_MONTHS = {
  'None': 0,
  'XS (1 month)': 1,
  'S (1-3 months)': 3,
  'M (3-5 months)': 5,
  'L (5-8 months)': 8,
  'XL (8-13 months)': 13,
  'XXL (13+ months)': 21,
  '3L (21+ months)': 34,
  '4L (34+ months)': 55,
};

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
 * Numbers are Sl No. Only mark as dev-blocker when the number is directly followed by "(dev-blocker)" in the same segment.
 * e.g. "33 (dev-blocker)" -> 33 is dev-blocker; "2" -> 2 is not.
 */
function parseDependencyNumbersAndBlockers(raw) {
  if (!raw || typeof raw !== 'string') return { rowNumbers: [], devBlockers: [] };
  const rowNumbers = [];
  const devBlockers = [];
  const parts = raw.split(/[,;]/);
  for (const part of parts) {
    const trimmed = part.trim();
    const numMatch = trimmed.match(/\d+/);
    if (numMatch) {
      const num = parseInt(numMatch[0], 10);
      rowNumbers.push(num);
      if (/\d+\s*\(\s*dev-blocker\s*\)/i.test(trimmed)) devBlockers.push(num);
    }
  }
  return {
    rowNumbers: [...new Set(rowNumbers)],
    devBlockers: [...new Set(devBlockers)],
  };
}

/**
 * Convert CSV text (header + data rows) to projects array.
 * No rows are omitted: all data rows are included regardless of commitment, sizing, or summary.
 */
export function csvToProjects(csvText) {
  const rows = parseCSV(csvText);
  const header = rows[0];
  const dataRows = rows.slice(1);

  if (!header || !dataRows.length) return { projects: [], error: 'CSV has no header or data rows.' };

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
    return { projects: [], error: 'CSV must include "FEAT NUMBER" and "SUMMARY" columns. Check the header row.' };
  }
  const iPriority = idx('Priority');
  const iStatus = idx('STATUS');
  const iCommit = idx('3.0 Commitment Status');
  const iDevResources = idx('Dev Resources required for max parallization');
  const iSizing = idx('sizing (refer sheet 2 for guidance)');
  const iDri = idx('DRI');
  const iDependencyNumbers = idx('Dependency Numbers (Comma Separated List)');
  const iTotalPersonMonths = header.findIndex(h => (h || '').trim().indexOf('Total Months Needed for 1 person by Dev') === 0);
  const iNumberMonthsDev = idx('Number of Months (Dev)');
  const iTotalPersonMonthsByName = idx('Total Months Needed for 1 person by Dev (Everything from start to finish)');
  const _totalPersonMonthsCol = iTotalPersonMonthsByName >= 0 ? iTotalPersonMonthsByName : iTotalPersonMonths;
  const iQAResources = header.findIndex(h => (h || '').trim().indexOf('Num of QA required') === 0);
  const iAdditionalResources = idx('Additional Resources');
  const iSizingComment = idx('Sizing Comment');
  const iCompletedPct = idx('How much of this is Completed in % (do not add %, just put a number)') >= 0
    ? idx('How much of this is Completed in % (do not add %, just put a number)')
    : header.findIndex(h => (h || '').trim().toLowerCase().indexOf('completed') !== -1 && (h || '').trim().indexOf('%') !== -1);
  const iCompletedPctFallback = iCompletedPct >= 0 ? iCompletedPct : 5;

  const projects = [];

  for (const row of dataRows) {
    const commitment = (row[iCommit] || '').trim();
    const sizingRaw = (row[iSizing] || '').trim();
    const months = SIZING_MONTHS[sizingRaw];
    const monthsFromSizing = months !== undefined ? months : 0;

    let devResources = parseFloat(String(row[iDevResources] || '').replace(/,/g, ''));
    if (Number.isNaN(devResources) || devResources < 0) devResources = 0;

    const feat = (row[iFeat] || '').trim();
    const summary = (row[iSummary] || '').trim().replace(/\s+/g, ' ') || feat || '';
    const dri = (row[iDri] || '').trim();
    const priority = (row[iPriority] || '').trim();
    const status = iStatus >= 0 ? (row[iStatus] || '').trim() : '';

    const rowNumRaw = (row[iFirstCol] || '').trim();
    const rowNumber = rowNumRaw && !Number.isNaN(parseInt(rowNumRaw, 10)) ? parseInt(rowNumRaw, 10) : null;
    const assignedRowNumber = rowNumber != null ? rowNumber : 9000 + projects.length;
    const { rowNumbers: dependencyRowNumbers, devBlockers: dependencyDevBlockers } = parseDependencyNumbersAndBlockers(row[iDependencyNumbers]);

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
      totalPersonMonths: totalPersonMonthsRaw,
      additionalResources,
      sizingComment,
    });
  }

  detectResourceGroups(projects);
  return { projects, error: null };
}

/**
 * Detect resource groups using two complementary strategies:
 *
 * Strategy 1 — Feat-capacity groups:
 *   The FEAT column contains "~N people/M months" (e.g. "Go Based WF Phase 2: ~18 people/10 months").
 *   The parent row's totalResources and durationMonths are overridden with the parsed N and M.
 *   Subsequent rows with empty feat field are children until the next non-empty feat row.
 *
 * Strategy 2 — Summary-prefix groups:
 *   Multiple projects share a summary prefix (text before " - ").
 *   Exactly one has totalResources > 0 (parent), the rest have totalResources = 0 (children).
 *   Example: "IAMv2 - User onboarding" (parent) + "IAMv2 - Session mgmt" (child).
 *
 * Children share the parent's FTE pool — they don't consume additional org capacity.
 * Mutates projects in place, adding resourceGroup* fields.
 */
export function detectResourceGroups(projects) {
  const grouped = new Set();

  /* --- Strategy 1: feat-capacity groups ("~N people/M months" in feat column) --- */
  for (let i = 0; i < projects.length; i++) {
    const p = projects[i];
    if (grouped.has(p.rowNumber)) continue;
    const match = (p.feat || '').match(/~(\d+)\s*people\s*\/\s*(\d+)\s*months/i);
    if (!match) continue;

    const groupFte = parseInt(match[1], 10);
    const groupDuration = parseInt(match[2], 10);
    const parentDri = (p.dri || '').trim().toLowerCase();
    const children = [];
    let j = i + 1;
    while (j < projects.length && !(projects[j].feat || '').trim()) {
      const childDri = (projects[j].dri || '').trim().toLowerCase();
      if (childDri && parentDri && childDri !== parentDri) break;
      children.push(projects[j]);
      j++;
    }
    if (children.length === 0) continue;

    /* If individual allocations sum to the annotated capacity, each sub-project
       is independently staffed — not a shared pool. Skip grouping. */
    const individualSum = (p.totalResources || 0) + children.reduce((s, c) => s + (c.totalResources || 0), 0);
    if (individualSum === groupFte) continue;

    const groupId = `feat-group-${p.rowNumber}`;
    p.resourceGroupId = groupId;
    p.totalResources = groupFte;
    p.durationMonths = groupDuration;
    p.resourceGroupChildRows = children.map(c => c.rowNumber);
    p.resourceGroupCapacityNote = `~${groupFte} people/${groupDuration} months (from FEAT column)`;
    grouped.add(p.rowNumber);

    for (const child of children) {
      child.resourceGroupId = groupId;
      child.isResourceGroupChild = true;
      child.resourceGroupParentRow = p.rowNumber;
      grouped.add(child.rowNumber);
    }
  }

  /* --- Strategy 2: summary-prefix groups (IAMv2-style) --- */
  const prefixOf = (summary) => {
    const idx = summary.indexOf(' - ');
    return idx >= 0 ? summary.slice(0, idx).trim() : null;
  };

  const byPrefix = new Map();
  for (const p of projects) {
    if (grouped.has(p.rowNumber)) continue;
    const prefix = prefixOf(p.summary);
    if (!prefix) continue;
    if (!byPrefix.has(prefix)) byPrefix.set(prefix, []);
    byPrefix.get(prefix).push(p);
  }

  for (const [prefix, members] of byPrefix) {
    if (members.length < 2) continue;
    const parents = members.filter(p => p.totalResources > 0);
    const children = members.filter(p => p.totalResources <= 0);
    if (parents.length !== 1 || children.length === 0) continue;

    const parent = parents[0];
    const groupId = `group-${parent.rowNumber}`;
    const childRowNumbers = children.map(c => c.rowNumber);

    parent.resourceGroupId = groupId;
    parent.resourceGroupChildRows = childRowNumbers;
    grouped.add(parent.rowNumber);

    for (const child of children) {
      child.resourceGroupId = groupId;
      child.isResourceGroupChild = true;
      child.resourceGroupParentRow = parent.rowNumber;
      grouped.add(child.rowNumber);
    }
  }
}
