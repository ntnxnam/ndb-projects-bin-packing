/**
 * Tests for start-date override feature:
 *  1. normalizeToDateValue — format conversion
 *  2. State override functions — get/set/clear/apply
 *  3. Bin-packing — requestedStartDate respected as lower bound
 *  4. Override → restore cycle — CSV original preserved
 */

/* ── Mock localStorage ───────────────────────────────── */
const store = {};
globalThis.localStorage = {
  getItem: (k) => store[k] ?? null,
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
  clear: () => { for (const k in store) delete store[k]; },
};

/* ── Mock window for config.js DEBUG check ───────────── */
globalThis.window = { location: { search: '' } };

/* ── Test harness ────────────────────────────────────── */
let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, msg) {
  if (condition) {
    passed++;
  } else {
    failed++;
    failures.push(msg);
    console.error(`  FAIL: ${msg}`);
  }
}

function assertEqual(actual, expected, msg) {
  const eq = JSON.stringify(actual) === JSON.stringify(expected);
  if (eq) {
    passed++;
  } else {
    failed++;
    const detail = `${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
    failures.push(detail);
    console.error(`  FAIL: ${detail}`);
  }
}

function section(name) { console.log(`\n── ${name} ──`); }

/* ═══════════════════════════════════════════════════════
   1. normalizeToDateValue
   ═══════════════════════════════════════════════════════ */
section('normalizeToDateValue');

const MONTH_ABBR = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];

function normalizeToDateValue(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  const fullMatch = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (fullMatch) return `${fullMatch[1]}-${String(fullMatch[2]).padStart(2, '0')}-${String(fullMatch[3]).padStart(2, '0')}`;
  const isoMatch = s.match(/^(\d{4})-(\d{1,2})$/);
  if (isoMatch) return `${isoMatch[1]}-${String(isoMatch[2]).padStart(2, '0')}-01`;
  const nameMatch = s.match(/^([A-Za-z]+)\s*(\d{4})$/);
  if (nameMatch) {
    const mi = MONTH_ABBR.indexOf(nameMatch[1].slice(0, 3).toLowerCase());
    if (mi >= 0) return `${nameMatch[2]}-${String(mi + 1).padStart(2, '0')}-01`;
  }
  const serial = parseFloat(s);
  if (!Number.isNaN(serial) && serial > 40000) {
    const d = new Date(Math.round((serial - 25569) * 86400000));
    if (!Number.isNaN(d.getTime())) return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  return '';
}

assertEqual(normalizeToDateValue(null), '', 'null → empty');
assertEqual(normalizeToDateValue(''), '', 'empty string → empty');
assertEqual(normalizeToDateValue('2026-08-15'), '2026-08-15', 'YYYY-MM-DD passthrough');
assertEqual(normalizeToDateValue('2026-8-5'), '2026-08-05', 'YYYY-M-D pads zeros');
assertEqual(normalizeToDateValue('2026-08'), '2026-08-01', 'YYYY-MM → first of month');
assertEqual(normalizeToDateValue('2026-6'), '2026-06-01', 'YYYY-M → first of month, padded');
assertEqual(normalizeToDateValue('Jun 2026'), '2026-06-01', '"Jun 2026" → 2026-06-01');
assertEqual(normalizeToDateValue('June 2026'), '2026-06-01', '"June 2026" → 2026-06-01');
assertEqual(normalizeToDateValue('jan 2027'), '2027-01-01', '"jan 2027" → 2027-01-01');
assertEqual(normalizeToDateValue('December 2026'), '2026-12-01', '"December 2026" → 2026-12-01');
assertEqual(normalizeToDateValue('garbage'), '', 'garbage → empty');
assertEqual(normalizeToDateValue('46204'), '2026-07-01', 'Excel serial 46204 → 2026-07-01');

/* ═══════════════════════════════════════════════════════
   2. State override functions
   ═══════════════════════════════════════════════════════ */
section('State override functions');

const START_DATE_OVERRIDES_KEY = 'ndb-start-date-overrides';

function getStartDateOverrides() {
  try {
    const raw = localStorage.getItem(START_DATE_OVERRIDES_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch (e) {
    return {};
  }
}

function setStartDateOverride(rowNumber, dateStr) {
  const overrides = getStartDateOverrides();
  if (dateStr) {
    overrides[String(rowNumber)] = dateStr;
  } else {
    delete overrides[String(rowNumber)];
  }
  localStorage.setItem(START_DATE_OVERRIDES_KEY, JSON.stringify(overrides));
}

function applyStartDateOverrides(projects) {
  const overrides = getStartDateOverrides();
  for (const p of projects) {
    if (p.rowNumber == null) continue;
    const key = String(p.rowNumber);
    if (!p.hasOwnProperty('_csvStartDate')) {
      p._csvStartDate = p.requestedStartDate ?? null;
    }
    if (key in overrides) {
      p.requestedStartDate = overrides[key];
    } else {
      p.requestedStartDate = p._csvStartDate;
    }
  }
}

localStorage.clear();

// 2a. Empty overrides initially
assertEqual(getStartDateOverrides(), {}, 'empty overrides initially');

// 2b. Set an override
setStartDateOverride(5, '2026-09-01');
assertEqual(getStartDateOverrides(), { '5': '2026-09-01' }, 'set override for row 5');

// 2c. Set another override
setStartDateOverride(12, '2027-01-01');
assertEqual(getStartDateOverrides(), { '5': '2026-09-01', '12': '2027-01-01' }, 'set override for row 12');

// 2d. Update existing override
setStartDateOverride(5, '2026-11-01');
assertEqual(getStartDateOverrides()['5'], '2026-11-01', 'update override for row 5');

// 2e. Clear an override (null)
setStartDateOverride(5, null);
assert(!('5' in getStartDateOverrides()), 'clear override for row 5 removes key');
assertEqual(getStartDateOverrides(), { '12': '2027-01-01' }, 'only row 12 remains');

// 2f. applyStartDateOverrides — stash CSV, apply override
localStorage.clear();
setStartDateOverride(1, '2026-10-01');

const projects = [
  { rowNumber: 1, requestedStartDate: 'Jun 2026' },
  { rowNumber: 2, requestedStartDate: null },
  { rowNumber: 3, requestedStartDate: '2026-08' },
];

applyStartDateOverrides(projects);
assertEqual(projects[0]._csvStartDate, 'Jun 2026', 'row 1: CSV original stashed');
assertEqual(projects[0].requestedStartDate, '2026-10-01', 'row 1: override applied');
assertEqual(projects[1]._csvStartDate, null, 'row 2: CSV null stashed');
assertEqual(projects[1].requestedStartDate, null, 'row 2: no override, stays null');
assertEqual(projects[2]._csvStartDate, '2026-08', 'row 3: CSV stashed');
assertEqual(projects[2].requestedStartDate, '2026-08', 'row 3: no override, keeps CSV');

// 2g. Clear override for row 1 → restores CSV original
setStartDateOverride(1, null);
applyStartDateOverrides(projects);
assertEqual(projects[0].requestedStartDate, 'Jun 2026', 'row 1: restore CSV original after clear');
assertEqual(projects[0]._csvStartDate, 'Jun 2026', 'row 1: _csvStartDate unchanged');

// 2h. Multiple apply calls don't corrupt _csvStartDate
setStartDateOverride(3, '2027-03-01');
applyStartDateOverrides(projects);
assertEqual(projects[2]._csvStartDate, '2026-08', 'row 3: _csvStartDate still original after override');
assertEqual(projects[2].requestedStartDate, '2027-03-01', 'row 3: override applied');
setStartDateOverride(3, null);
applyStartDateOverrides(projects);
assertEqual(projects[2].requestedStartDate, '2026-08', 'row 3: restored to CSV after clearing override');

/* ═══════════════════════════════════════════════════════
   3. Bin-packing: requestedStartDate as lower bound
   ═══════════════════════════════════════════════════════ */
section('Bin-packing: requestedStartDate constraint');

const MONTH_NAMES = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];

function parseRequestedStartDate(raw, timelineStart) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const isoMatch = s.match(/^(\d{4})-(\d{1,2})(?:-\d{1,2})?$/);
  if (isoMatch) return new Date(+isoMatch[1], +isoMatch[2] - 1, 1);
  const monthNameMatch = s.match(/^([A-Za-z]+)\s*(\d{4})$/);
  if (monthNameMatch) {
    const mi = MONTH_NAMES.indexOf(monthNameMatch[1].slice(0, 3).toLowerCase());
    if (mi >= 0) return new Date(+monthNameMatch[2], mi, 1);
  }
  const monthNumOnly = s.match(/^(\d{1,2})$/);
  if (monthNumOnly) {
    const m = +monthNumOnly[1];
    if (m >= 1 && m <= 12) return new Date(timelineStart.getFullYear(), m - 1, 1);
  }
  return null;
}

function monthIndex(d, timelineStart) {
  return (d.getFullYear() - timelineStart.getFullYear()) * 12 + (d.getMonth() - timelineStart.getMonth());
}

/**
 * Simplified bin-packing: tests that requestedStartDate acts as a lower bound,
 * dependencies push it later, and capacity constraints slide further.
 */
function simplePack(projectList, timelineStartStr, capacityFTE) {
  const timelineStart = new Date(timelineStartStr);
  timelineStart.setDate(1);
  const usage = new Map();
  const endByRow = new Map();
  const results = [];

  function canFit(startMo, dur, fte) {
    const reserved = Math.ceil(fte);
    if (reserved <= 0) return true;
    for (let i = 0; i < dur; i++) {
      if ((usage.get(startMo + i) ?? 0) + reserved > capacityFTE) return false;
    }
    return true;
  }

  function addUsage(startMo, dur, fte) {
    const reserved = Math.ceil(fte);
    for (let i = 0; i < dur; i++) {
      usage.set(startMo + i, (usage.get(startMo + i) ?? 0) + reserved);
    }
  }

  for (const p of projectList) {
    const dur = p.durationMonths || 1;
    const fte = p.totalResources || 1;
    let earliestStart = 0;

    if (p.requestedStartDate) {
      const reqDate = parseRequestedStartDate(p.requestedStartDate, timelineStart);
      if (reqDate) {
        earliestStart = Math.max(earliestStart, monthIndex(reqDate, timelineStart));
      }
    }

    for (const depRow of (p.dependencyRowNumbers || [])) {
      if (endByRow.has(depRow)) {
        const depEndDate = endByRow.get(depRow);
        earliestStart = Math.max(earliestStart, monthIndex(depEndDate, timelineStart));
      }
    }

    let startMo = earliestStart;
    while (!canFit(startMo, dur, fte)) startMo++;

    const startDate = new Date(timelineStart.getFullYear(), timelineStart.getMonth() + startMo, 1);
    const endDate = new Date(timelineStart.getFullYear(), timelineStart.getMonth() + startMo + dur, 1);
    addUsage(startMo, dur, fte);
    endByRow.set(p.rowNumber, endDate);
    results.push({ rowNumber: p.rowNumber, startMonth: startMo, startDate, endDate, fte });
  }
  return results;
}

// 3a. No requestedStartDate → starts at month 0
{
  const projs = [
    { rowNumber: 1, durationMonths: 3, totalResources: 2, requestedStartDate: null, dependencyRowNumbers: [] },
  ];
  const r = simplePack(projs, '2026-04-01', 85);
  assertEqual(r[0].startMonth, 0, '3a: no requested start → month 0');
}

// 3b. requestedStartDate pushes start forward
{
  const projs = [
    { rowNumber: 1, durationMonths: 3, totalResources: 2, requestedStartDate: '2026-08-01', dependencyRowNumbers: [] },
  ];
  const r = simplePack(projs, '2026-04-01', 85);
  assertEqual(r[0].startMonth, 4, '3b: requested 2026-08 → month 4 (Aug - Apr)');
}

// 3c. Dependency pushes start later than requestedStartDate
{
  const projs = [
    { rowNumber: 1, durationMonths: 6, totalResources: 2, requestedStartDate: null, dependencyRowNumbers: [] },
    { rowNumber: 2, durationMonths: 3, totalResources: 2, requestedStartDate: '2026-06-01', dependencyRowNumbers: [1] },
  ];
  const r = simplePack(projs, '2026-04-01', 85);
  assertEqual(r[0].startMonth, 0, '3c: proj 1 starts at 0');
  assertEqual(r[1].startMonth, 6, '3c: proj 2 dep ends at month 6, later than requested month 2');
}

// 3d. requestedStartDate is later than dependency end → requestedStartDate wins
{
  const projs = [
    { rowNumber: 1, durationMonths: 2, totalResources: 2, requestedStartDate: null, dependencyRowNumbers: [] },
    { rowNumber: 2, durationMonths: 3, totalResources: 2, requestedStartDate: '2026-10-01', dependencyRowNumbers: [1] },
  ];
  const r = simplePack(projs, '2026-04-01', 85);
  assertEqual(r[0].startMonth, 0, '3d: proj 1 at 0');
  assertEqual(r[1].startMonth, 6, '3d: proj 2 dep ends at 2, but requested month 6 (Oct) wins');
}

// 3e. Capacity constraint slides past requestedStartDate
{
  const projs = [
    { rowNumber: 1, durationMonths: 4, totalResources: 80, requestedStartDate: null, dependencyRowNumbers: [] },
    { rowNumber: 2, durationMonths: 3, totalResources: 10, requestedStartDate: '2026-05-01', dependencyRowNumbers: [] },
  ];
  const r = simplePack(projs, '2026-04-01', 85);
  assertEqual(r[0].startMonth, 0, '3e: proj 1 uses 80 FTEs from month 0');
  assert(r[1].startMonth >= 4, '3e: proj 2 requested month 1, but 80+10>85, slides to month 4+');
}

// 3f. YYYY-MM format (from <input type="date"> → stored as YYYY-MM-DD)
{
  const projs = [
    { rowNumber: 1, durationMonths: 2, totalResources: 2, requestedStartDate: '2026-07', dependencyRowNumbers: [] },
  ];
  const r = simplePack(projs, '2026-04-01', 85);
  assertEqual(r[1 - 1].startMonth, 3, '3f: YYYY-MM "2026-07" → month 3');
}

// 3g. "Jun 2026" format
{
  const projs = [
    { rowNumber: 1, durationMonths: 2, totalResources: 2, requestedStartDate: 'Jun 2026', dependencyRowNumbers: [] },
  ];
  const r = simplePack(projs, '2026-04-01', 85);
  assertEqual(r[0].startMonth, 2, '3g: "Jun 2026" → month 2 (Jun - Apr)');
}

// 3h. Clearing override (null) → no constraint
{
  const projs = [
    { rowNumber: 1, durationMonths: 2, totalResources: 2, requestedStartDate: null, dependencyRowNumbers: [] },
  ];
  const r = simplePack(projs, '2026-04-01', 85);
  assertEqual(r[0].startMonth, 0, '3h: null requestedStartDate → month 0');
}

/* ═══════════════════════════════════════════════════════
   4. Full override → pack → restore cycle
   ═══════════════════════════════════════════════════════ */
section('Full override → pack → restore cycle');

localStorage.clear();

const fullProjects = [
  { rowNumber: 1, durationMonths: 3, totalResources: 5, requestedStartDate: 'Jun 2026', dependencyRowNumbers: [], completedPct: 0 },
  { rowNumber: 2, durationMonths: 4, totalResources: 3, requestedStartDate: null, dependencyRowNumbers: [], completedPct: 0 },
  { rowNumber: 3, durationMonths: 2, totalResources: 2, requestedStartDate: '2026-08', dependencyRowNumbers: [1], completedPct: 0 },
];

// 4a. Initial state — CSV values used
applyStartDateOverrides(fullProjects);
assertEqual(fullProjects[0].requestedStartDate, 'Jun 2026', '4a: row 1 CSV value');
assertEqual(fullProjects[1].requestedStartDate, null, '4a: row 2 no CSV');
assertEqual(fullProjects[2].requestedStartDate, '2026-08', '4a: row 3 CSV value');

const r1 = simplePack(fullProjects, '2026-04-01', 85);
assertEqual(r1[0].startMonth, 2, '4a: row 1 starts Jun (month 2)');
assertEqual(r1[1].startMonth, 0, '4a: row 2 starts month 0 (no constraint)');
assert(r1[2].startMonth >= 5, '4a: row 3 dep on row 1 (ends month 5), later than requested month 4');

// 4b. Override row 1 to start later
setStartDateOverride(1, '2026-10-01');
applyStartDateOverrides(fullProjects);
assertEqual(fullProjects[0].requestedStartDate, '2026-10-01', '4b: row 1 overridden to Oct');
assertEqual(fullProjects[0]._csvStartDate, 'Jun 2026', '4b: row 1 CSV original preserved');

const r2 = simplePack(fullProjects, '2026-04-01', 85);
assertEqual(r2[0].startMonth, 6, '4b: row 1 now starts Oct (month 6)');
assert(r2[2].startMonth >= 9, '4b: row 3 dep on row 1 (ends month 9), pushed further');

// 4c. Override row 2 with an explicit date
setStartDateOverride(2, '2026-07-01');
applyStartDateOverrides(fullProjects);
assertEqual(fullProjects[1].requestedStartDate, '2026-07-01', '4c: row 2 overridden to Jul');

const r3 = simplePack(fullProjects, '2026-04-01', 85);
assertEqual(r3[1].startMonth, 3, '4c: row 2 starts Jul (month 3)');

// 4d. Clear override for row 1 → restores CSV
setStartDateOverride(1, null);
applyStartDateOverrides(fullProjects);
assertEqual(fullProjects[0].requestedStartDate, 'Jun 2026', '4d: row 1 restored to CSV "Jun 2026"');
assertEqual(fullProjects[0]._csvStartDate, 'Jun 2026', '4d: _csvStartDate still intact');

const r4 = simplePack(fullProjects, '2026-04-01', 85);
assertEqual(r4[0].startMonth, 2, '4d: row 1 back to Jun (month 2)');

// 4e. Clear override for row 2 → restores null
setStartDateOverride(2, null);
applyStartDateOverrides(fullProjects);
assertEqual(fullProjects[1].requestedStartDate, null, '4e: row 2 restored to null');

const r5 = simplePack(fullProjects, '2026-04-01', 85);
assertEqual(r5[1].startMonth, 0, '4e: row 2 back to month 0');

/* ═══════════════════════════════════════════════════════
   5. Rapid successive overrides (simulates the bug scenario)
   ═══════════════════════════════════════════════════════ */
section('Rapid successive overrides on same project');

localStorage.clear();

const rapidProjects = [
  { rowNumber: 1, durationMonths: 3, totalResources: 5, requestedStartDate: null, dependencyRowNumbers: [], completedPct: 0 },
  { rowNumber: 2, durationMonths: 4, totalResources: 3, requestedStartDate: 'Jun 2026', dependencyRowNumbers: [], completedPct: 0 },
];

// 5a. First override on row 1
setStartDateOverride(1, '2026-08-01');
applyStartDateOverrides(rapidProjects);
assertEqual(rapidProjects[0].requestedStartDate, '2026-08-01', '5rapid-a: first override applied');
assertEqual(rapidProjects[0]._csvStartDate, null, '5rapid-a: CSV stashed as null');
const rr1 = simplePack(rapidProjects, '2026-04-01', 85);
assertEqual(rr1[0].startMonth, 4, '5rapid-a: row 1 starts Aug (month 4)');

// 5b. Second override on SAME row 1 — this is the bug scenario
setStartDateOverride(1, '2026-11-01');
applyStartDateOverrides(rapidProjects);
assertEqual(rapidProjects[0].requestedStartDate, '2026-11-01', '5rapid-b: second override applied');
assertEqual(rapidProjects[0]._csvStartDate, null, '5rapid-b: CSV still null (not corrupted)');
const rr2 = simplePack(rapidProjects, '2026-04-01', 85);
assertEqual(rr2[0].startMonth, 7, '5rapid-b: row 1 starts Nov (month 7)');

// 5c. Third override on SAME row 1 — earlier date this time
setStartDateOverride(1, '2026-06-01');
applyStartDateOverrides(rapidProjects);
assertEqual(rapidProjects[0].requestedStartDate, '2026-06-01', '5rapid-c: third override applied');
assertEqual(rapidProjects[0]._csvStartDate, null, '5rapid-c: CSV still null');
const rr3 = simplePack(rapidProjects, '2026-04-01', 85);
assertEqual(rr3[0].startMonth, 2, '5rapid-c: row 1 starts Jun (month 2)');

// 5d. Clear override → back to CSV null → month 0
setStartDateOverride(1, null);
applyStartDateOverrides(rapidProjects);
assertEqual(rapidProjects[0].requestedStartDate, null, '5rapid-d: cleared, back to null');
const rr4 = simplePack(rapidProjects, '2026-04-01', 85);
assertEqual(rr4[0].startMonth, 0, '5rapid-d: row 1 back to month 0');

// 5e. Override row 2 multiple times (has CSV value "Jun 2026")
setStartDateOverride(2, '2026-10-01');
applyStartDateOverrides(rapidProjects);
assertEqual(rapidProjects[1].requestedStartDate, '2026-10-01', '5rapid-e: row 2 overridden to Oct');
assertEqual(rapidProjects[1]._csvStartDate, 'Jun 2026', '5rapid-e: CSV preserved');
const rr5 = simplePack(rapidProjects, '2026-04-01', 85);
assertEqual(rr5[1].startMonth, 6, '5rapid-e: row 2 starts Oct (month 6)');

setStartDateOverride(2, '2027-01-01');
applyStartDateOverrides(rapidProjects);
assertEqual(rapidProjects[1].requestedStartDate, '2027-01-01', '5rapid-e2: row 2 changed to Jan 2027');
assertEqual(rapidProjects[1]._csvStartDate, 'Jun 2026', '5rapid-e2: CSV still Jun 2026');
const rr6 = simplePack(rapidProjects, '2026-04-01', 85);
assertEqual(rr6[1].startMonth, 9, '5rapid-e2: row 2 starts Jan 2027 (month 9)');

setStartDateOverride(2, null);
applyStartDateOverrides(rapidProjects);
assertEqual(rapidProjects[1].requestedStartDate, 'Jun 2026', '5rapid-e3: row 2 restored to CSV "Jun 2026"');
const rr7 = simplePack(rapidProjects, '2026-04-01', 85);
assertEqual(rr7[1].startMonth, 2, '5rapid-e3: row 2 back to Jun (month 2)');

/* ═══════════════════════════════════════════════════════
   6. Edge cases
   ═══════════════════════════════════════════════════════ */
section('Edge cases');

// 6a. Override with empty string acts like clearing
localStorage.clear();
setStartDateOverride(1, '');
const ov = getStartDateOverrides();
assert(!('1' in ov), '6a: empty string clears override (falsy check)');

// 6b. Project with no rowNumber is skipped by applyStartDateOverrides
const noRowProjs = [{ rowNumber: null, requestedStartDate: 'Jun 2026' }];
setStartDateOverride('null', '2027-01-01');
applyStartDateOverrides(noRowProjs);
assertEqual(noRowProjs[0].requestedStartDate, 'Jun 2026', '6b: null rowNumber → untouched');

// 6c. Corrupt localStorage → returns empty
localStorage.setItem(START_DATE_OVERRIDES_KEY, 'not-json{{{');
assertEqual(getStartDateOverrides(), {}, '6c: corrupt JSON → empty overrides');

// 6d. Array in localStorage → returns empty
localStorage.setItem(START_DATE_OVERRIDES_KEY, '[1,2,3]');
assertEqual(getStartDateOverrides(), {}, '6d: array → empty overrides');

/* ═══════════════════════════════════════════════════════
   Results
   ═══════════════════════════════════════════════════════ */
console.log(`\n${'═'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  • ${f}`);
  process.exit(1);
} else {
  console.log('All tests passed!');
  process.exit(0);
}
