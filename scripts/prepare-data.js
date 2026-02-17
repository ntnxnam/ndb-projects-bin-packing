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

  const iFirstCol = 0;
  const iFeat = idx('FEAT NUMBER');
  const iSummary = idx('SUMMARY');
  const iPriority = idx('Priority');
  const iCommit = idx('3.0 Commitment Status');
  const iDevResources = idx('Dev Resources required for max parallization');
  const iSizing = idx('sizing (refer sheet 2 for guidance)');
  const iDri = idx('DRI');
  const iDependencyNumbers = idx('Dependency Numbers (Comma Separated List)');

  /** Parse "37(Dev-blocker)", "2", "6, 27" -> [37, 2] or [6, 27]. */
  function parseDependencyNumbers(raw) {
    if (!raw || typeof raw !== 'string') return [];
    const out = [];
    const parts = raw.split(/[,;]/);
    for (const part of parts) {
      const match = part.trim().match(/\d+/);
      if (match) out.push(parseInt(match[0], 10));
    }
    return [...new Set(out)];
  }

  const included = new Set(['Committed', 'Approved']);
  const projects = [];

  for (const row of dataRows) {
    const commitment = (row[iCommit] || '').trim();
    if (!included.has(commitment)) continue;

    const sizingRaw = (row[iSizing] || '').trim();
    const months = SIZING_MONTHS[sizingRaw];
    if (months === undefined) continue;

    let devResources = parseFloat(String(row[iDevResources] || '').replace(/,/g, ''));
    if (Number.isNaN(devResources) || devResources < 0) devResources = 0;

    const feat = (row[iFeat] || '').trim();
    const summary = (row[iSummary] || '').trim().replace(/\s+/g, ' ');
    const dri = (row[iDri] || '').trim();
    const priority = (row[iPriority] || '').trim();

    if (!summary) continue;

    const rowNumRaw = (row[iFirstCol] || '').trim();
    const rowNumber = rowNumRaw ? parseInt(rowNumRaw, 10) : projects.length + 1;
    const dependencyRowNumbers = parseDependencyNumbers(row[iDependencyNumbers]);

    projects.push({
      id: feat || `row-${rowNumber}`,
      feat: feat || '',
      summary: summary.slice(0, 120),
      dri,
      priority: priority || 'P0',
      commitment,
      totalResources: Math.round(devResources * 100) / 100,
      sizingLabel: sizingRaw,
      durationMonths: months,
      rowNumber: Number.isNaN(rowNumber) ? projects.length + 1 : rowNumber,
      dependencyRowNumbers,
    });
  }

  const outDir = path.dirname(OUT_PATH);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(projects, null, 2), 'utf8');
  console.log('Wrote', projects.length, 'projects to', OUT_PATH);
}

main();
