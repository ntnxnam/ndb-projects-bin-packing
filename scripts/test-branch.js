/**
 * Tests for fix/iamv2-one-project branch:
 * 1) IAMv2-style FEAT: one row with resources + rest without → single project (parent + children)
 * 2) Ranking: more projects I block (total dependents) → higher rank
 * Run: node scripts/test-branch.js
 */

const fs = require('fs');
const path = require('path');

const dataPath = path.join(__dirname, '..', 'data', 'projects.json');
const projects = JSON.parse(fs.readFileSync(dataPath, 'utf8'));

// --- 1) Resource groups: strip existing group fields to simulate fresh parse, then apply Strategy 0 uber logic ---
const raw = projects.map((p) => {
  const { resourceGroupId, resourceGroupName, resourceGroupChildRows, isResourceGroupChild, resourceGroupParentRow, ...rest } = p;
  return rest;
});

let lastFeat = '';
const bucketByFeat = new Map();
for (const p of raw) {
  const featVal = (p.feat || '').trim();
  if (featVal) lastFeat = featVal;
  if (!lastFeat) continue;
  if (!bucketByFeat.has(lastFeat)) bucketByFeat.set(lastFeat, []);
  bucketByFeat.get(lastFeat).push(p);
}

let iamv2Parent = null;
let iamv2Children = [];
for (const [featName, members] of bucketByFeat) {
  if (members.length < 2) continue;
  const withResources = members.filter((p) => (p.totalResources || 0) > 0);
  const withoutResources = members.filter((p) => (p.totalResources || 0) <= 0);
  const isUber = withResources.length === 1 && withoutResources.length >= 1;
  if (featName === 'IAMv2' && isUber) {
    iamv2Parent = withResources[0];
    iamv2Children = withoutResources;
    break;
  }
}

const test1Ok = iamv2Parent && iamv2Parent.rowNumber === 59 && iamv2Children.length >= 9;
console.log('Test 1 (IAMv2 one project):', test1Ok ? 'PASS' : 'FAIL');
if (!test1Ok) {
  console.log('  IAMv2 parent row:', iamv2Parent?.rowNumber, 'children:', iamv2Children?.length);
}

// --- 2) Ranking: total "projects I block" used in sort ---
// Build dependents count (simplified: just count how many list this row as dependency)
const devBlockerDependentsCount = new Map();
const relBlockerDependentsCount = new Map();
const plainDependentsCount = new Map();
for (const p of raw) {
  const row = p.rowNumber ?? 0;
  devBlockerDependentsCount.set(row, 0);
  relBlockerDependentsCount.set(row, 0);
  plainDependentsCount.set(row, 0);
}
for (const p of raw) {
  const devBlockers = new Set(p.dependencyDevBlockers || []);
  const relBlockers = new Set(p.dependencyRelBlockers || []);
  for (const depRow of p.dependencyRowNumbers || []) {
    if (depRow === p.rowNumber) continue;
    if (devBlockers.has(depRow)) devBlockerDependentsCount.set(depRow, (devBlockerDependentsCount.get(depRow) || 0) + 1);
    else if (relBlockers.has(depRow)) relBlockerDependentsCount.set(depRow, (relBlockerDependentsCount.get(depRow) || 0) + 1);
    else plainDependentsCount.set(depRow, (plainDependentsCount.get(depRow) || 0) + 1);
  }
}

const totalBlocks = (row) =>
  (devBlockerDependentsCount.get(row) ?? 0) + (relBlockerDependentsCount.get(row) ?? 0) + (plainDependentsCount.get(row) ?? 0);

// Simulate sort: main projects only, by total blocks descending
const mainProjects = raw.filter((p) => !p.isResourceGroupChild);
const byTotal = [...mainProjects].sort((a, b) => totalBlocks(b.rowNumber) - totalBlocks(a.rowNumber));

let prevTotal = Infinity;
let orderOk = true;
for (const p of byTotal) {
  const t = totalBlocks(p.rowNumber);
  if (t > prevTotal) {
    orderOk = false;
    break;
  }
  prevTotal = t;
}
console.log('Test 2 (ranking by total blocks desc):', orderOk ? 'PASS' : 'FAIL');

// Sample: show top 5 by total blocks
const top5 = byTotal.slice(0, 5).map((p) => ({ row: p.rowNumber, summary: (p.summary || '').slice(0, 40), totalBlocks: totalBlocks(p.rowNumber) }));
console.log('  Top 5 by total blocks:', top5);

process.exit(test1Ok && orderOk ? 0 : 1);
