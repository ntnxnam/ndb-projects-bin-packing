#!/usr/bin/env node
/**
 * Prepares project data from the prioritization CSV (Sheet1).
 * Outputs data/projects.json with rows that have sizing + Committed/Approved.
 * People allocated (FTE) = Column J "Dev Resources required for max parallization".
 *
 * Usage: node scripts/prepare-data.js [path/to/Sheet1.csv]
 * Default CSV path: ../data/sheet1.csv (place export there first).
 */

const fs = require('fs');
const path = require('path');

const CSV_PATH = process.argv[2] || path.join(__dirname, '../data/sheet1.csv');
const OUT_PATH = path.join(__dirname, '../data/projects.json');

// Sizing label → "up to" months (for bar length).
const SIZING_MONTHS = {
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

function parseCSV(text) {
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

function main() {
  let csvText;
  try {
    csvText = fs.readFileSync(CSV_PATH, 'utf8');
  } catch (e) {
    console.error('Could not read CSV at', CSV_PATH);
    process.exit(1);
  }

  const rows = parseCSV(csvText);
  const header = rows[0];
  const dataRows = rows.slice(1);

  const idx = (name) => {
    const n = (name || '').trim();
    const i = header.findIndex(h => (h || '').trim() === n);
    return i >= 0 ? i : -1;
  };

  const iSlNo = idx('Sl No') >= 0 ? idx('Sl No') : idx('Sl. No');
  const iFirstCol = iSlNo >= 0 ? iSlNo : 0;
  const iFeat = idx('FEAT NUMBER');
  const iSummary = idx('SUMMARY');
  const iPriority = idx('Priority');
  const iStatus = idx('STATUS');
  const iCommit = idx('3.0 Commitment Status');
  const iDevResources = idx('Dev Resources required for max parallization');
  const iSizing = idx('sizing (refer sheet 2 for guidance)');
  const iDri = idx('DRI');
  const iDependencyNumbers = idx('Dependency Numbers (Comma Separated List)');
  const iTotalPersonMonths = idx('Total Months Needed for 1 person by Dev (Everything from start to finish)');
  const iNumberMonthsDev = idx('Number of Months (Dev)');
  const iCompletedPctExact = idx('How much of this is Completed in % (do not add %, just put a number)');
  const iCompletedPctByKeyword = header.findIndex(h => {
    const t = (h || '').trim().toLowerCase();
    return t.indexOf('completed') !== -1 || t.indexOf('progress') !== -1;
  });
  const iCompletedPct = iCompletedPctExact >= 0 ? iCompletedPctExact : iCompletedPctByKeyword;
  const iCompletedPctCol = iCompletedPct >= 0 ? iCompletedPct : 5;

  const iQAResources = header.findIndex(h => {
    const t = (h || '').trim();
    return t.indexOf('Num of QA required') !== -1 && t.indexOf('60% productivity') === -1;
  });

  /** Parse dependency list. Mark dev-blocker when "(dev-blocker)" in segment, rel-blocker when "(rel-blocker)". */
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
    const inProgress = /in\s*progress/i.test(status);
    const completedPctRaw = (row[iCompletedPctCol] || '').toString().replace(/,/g, '').trim();
    let completedPct = parseFloat(completedPctRaw);
    if (Number.isNaN(completedPct) || completedPct < 0) completedPct = 0;
    completedPct = Math.min(100, Math.max(0, completedPct));

    const rowNumRaw = (row[iFirstCol] || '').trim();
    const rowNumber = rowNumRaw && !Number.isNaN(parseInt(rowNumRaw, 10)) ? parseInt(rowNumRaw, 10) : null;
    const assignedRowNumber = rowNumber != null ? rowNumber : 9000 + projects.length;
    const { rowNumbers: dependencyRowNumbers, devBlockers: dependencyDevBlockers, relBlockers: dependencyRelBlockers } = parseDependencyNumbersAndBlockers(row[iDependencyNumbers]);

    const totalPersonMonthsRaw = iTotalPersonMonths >= 0 ? (row[iTotalPersonMonths] || '').trim() : '';

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

    let qaResources = iQAResources >= 0 && row[iQAResources] ? parseFloat(String(row[iQAResources]).replace(/,/g, '')) : NaN;
    if (Number.isNaN(qaResources) || qaResources < 0) {
      qaResources = null;
    } else {
      qaResources = Math.round(qaResources * 100) / 100;
    }

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
      totalPersonMonthsNum: Number.isNaN(totalPersonMonthsNum) ? null : totalPersonMonthsNum,
      dependencyRowNumbers,
      dependencyDevBlockers: dependencyDevBlockers || [],
      dependencyRelBlockers: dependencyRelBlockers || [],
    });
  }

  /* Detect resource groups (two strategies):
     1. Feat-capacity: FEAT column contains "~N people/M months". Subsequent empty-feat rows are children.
     2. Summary-prefix: IAMv2-style — parent has totalResources > 0, children have 0, shared summary prefix. */
  const grouped = new Set();

  /* Strategy 1: feat-capacity groups */
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
    const bucketName = (p.feat || '').trim().replace(/\s*~.*$/, '').trim() || `#${p.rowNumber}`;
    p.resourceGroupId = groupId;
    p.resourceGroupName = bucketName;
    p.totalResources = groupFte;
    p.durationMonths = groupDuration;
    p.resourceGroupChildRows = children.map(c => c.rowNumber);
    p.resourceGroupCapacityNote = `~${groupFte} people/${groupDuration} months (from FEAT column)`;
    grouped.add(p.rowNumber);
    for (const child of children) {
      child.resourceGroupId = groupId;
      child.resourceGroupName = bucketName;
      child.isResourceGroupChild = true;
      child.resourceGroupParentRow = p.rowNumber;
      grouped.add(child.rowNumber);
    }
  }

  /* Strategy 2: summary-prefix groups */
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
    const bucketName = prefix;
    parent.resourceGroupId = groupId;
    parent.resourceGroupName = bucketName;
    parent.resourceGroupChildRows = childRowNumbers;
    grouped.add(parent.rowNumber);
    for (const child of children) {
      child.resourceGroupId = groupId;
      child.resourceGroupName = bucketName;
      child.isResourceGroupChild = true;
      child.resourceGroupParentRow = parent.rowNumber;
      grouped.add(child.rowNumber);
    }
  }

  const outDir = path.dirname(OUT_PATH);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(projects, null, 2), 'utf8');
  console.log('Wrote', projects.length, 'projects (all rows) to', OUT_PATH);

  /* --- Step 2: Committed-only schedule data --- */
  function isDependencyOnlyRow(p) {
    const hasSummary = (p.summary || '').trim().length > 0;
    const hasFeat = (p.feat || '').trim().length > 0;
    const hasResources = (p.totalResources || 0) > 0;
    const hasDuration = (p.durationMonths || 0) > 0;
    const hasTotalMonths = p.totalPersonMonthsNum != null && p.totalPersonMonthsNum > 0;
    const hasSizing = (p.sizingLabel || '').trim().length > 0;
    const hasPriority = (p.priority || '').trim().length > 0;
    const hasCommitment = (p.commitment || '').trim().length > 0;
    if (!hasSummary && !hasFeat && !hasResources && !hasDuration && !hasTotalMonths && !hasSizing) return true;
    if (!hasCommitment && !hasPriority && !hasResources && !hasDuration && !hasTotalMonths && !hasSizing && !hasSummary) return true;
    return false;
  }

  const committed = projects.filter(p => {
    if (isDependencyOnlyRow(p)) return false;
    return (p.commitment || '').trim().toLowerCase() === 'committed';
  });

  const SCHEDULE_PATH = path.join(__dirname, '../data/committed-schedule.json');
  fs.writeFileSync(SCHEDULE_PATH, JSON.stringify(committed, null, 2), 'utf8');
  console.log('Wrote', committed.length, 'committed projects to', SCHEDULE_PATH, '(filtered from', projects.length, ')');
}

main();
