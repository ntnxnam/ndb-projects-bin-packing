/**
 * Resource group detection: identify buckets (groups) and optionally parent/child.
 * Used by CSV parser and scheduling; mutates projects in place with resourceGroup* fields.
 * @module resource-groups
 */

import { logger } from './logger.js';

/**
 * Detect resource groups. Bucket = repeated value in column B (FEAT). All rows in a bucket are peers (no parent/child).
 * Optional legacy strategies can create parent/child only for projects not already in a peer bucket.
 *
 * Strategy 0 — Bucket by column B (FEAT): When the same FEAT value repeats, those rows form one bucket. All are
 * individual projects (peers). Set resourceGroupId and resourceGroupName only; no parent/child.
 *
 * Strategy 1 — Feat-capacity: FEAT contains "~N people/M months"; subsequent empty-feat rows = children. (Skipped if already in a peer bucket.)
 *
 * Strategy 2 — Uber by FEAT: Same FEAT, one with resources = parent, rest children. (Skipped if already in a peer bucket.)
 *
 * Strategy 3 — Summary-prefix: Summary before " - " matches; one parent, rest children.
 *
 * @param {Array<object>} projects - Projects with rowNumber, feat, summary, totalResources, durationMonths, dri.
 */
export function detectResourceGroups(projects) {
  const grouped = new Set();

  /* --- Strategy 0: Bucket by column B (FEAT) — same FEAT value = same bucket, all peers (no parent/child) --- */
  let lastFeat = '';
  const bucketByFeat = new Map();
  for (const p of projects) {
    const featVal = (p.feat || '').trim();
    if (featVal) lastFeat = featVal;
    if (!lastFeat) continue;
    if (!bucketByFeat.has(lastFeat)) bucketByFeat.set(lastFeat, []);
    bucketByFeat.get(lastFeat).push(p);
  }
  for (const [featName, members] of bucketByFeat) {
    if (members.length < 2) continue;
    const groupId = 'bucket-' + featName.replace(/\s+/g, '-').replace(/[^\w\-]/g, '').slice(0, 60) || `bucket-${members[0].rowNumber}`;
    const bucketName = featName;
    for (const p of members) {
      p.resourceGroupId = groupId;
      p.resourceGroupName = bucketName;
      grouped.add(p.rowNumber);
    }
    logger.debug('resource-groups: Strategy 0 (bucket by col B)', bucketName, 'peers', members.length);
  }

  /* --- Strategy 1: feat-capacity groups ("~N people/M months" in feat column) — skip if already in peer bucket --- */
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
      if (grouped.has(projects[j].rowNumber)) break;
      const childDri = (projects[j].dri || '').trim().toLowerCase();
      if (childDri && parentDri && childDri !== parentDri) break;
      children.push(projects[j]);
      j++;
    }
    if (children.length === 0) continue;

    const individualSum = (p.totalResources || 0) + children.reduce((s, c) => s + (c.totalResources || 0), 0);
    if (individualSum === groupFte) continue;

    const groupId = `feat-group-${p.rowNumber}`;
    let bucketName = (p.feat || '').trim().replace(/\s*~.*$/, '').trim() || `#${p.rowNumber}`;
    bucketName = bucketName.replace(/\s+/g, ' ').trim();
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
    logger.debug('resource-groups: Strategy 1', bucketName, 'parent', p.rowNumber, 'children', children.length);
  }

  /* --- Strategy 2: Uber project = column B (FEAT NUMBER); column C = sub-project --- */
  let lastFeatFill = '';
  const byFeat = new Map();
  for (const p of projects) {
    const featVal = (p.feat || '').trim();
    if (featVal) lastFeatFill = featVal;
    if (!lastFeatFill) continue;
    if (!byFeat.has(lastFeatFill)) byFeat.set(lastFeatFill, []);
    byFeat.get(lastFeatFill).push(p);
  }

  for (const [featName, members] of byFeat) {
    if (members.length < 2) continue;
    const ungrouped = members.filter(p => !grouped.has(p.rowNumber));
    if (ungrouped.length < 2) continue;

    const withResources = ungrouped.filter(p => p.totalResources > 0);
    const withoutResources = ungrouped.filter(p => p.totalResources <= 0);
    if (withResources.length !== 1 || withoutResources.length === 0) continue;

    const parent = withResources[0];
    const childList = withoutResources;
    const childRowNumbers = childList.map(c => c.rowNumber);
    const groupId = `feat-uber-${parent.rowNumber}`;
    const bucketName = featName;

    parent.resourceGroupId = groupId;
    parent.resourceGroupName = bucketName;
    parent.resourceGroupChildRows = childRowNumbers;
    grouped.add(parent.rowNumber);

    for (const child of childList) {
      child.resourceGroupId = groupId;
      child.resourceGroupName = bucketName;
      child.isResourceGroupChild = true;
      child.resourceGroupParentRow = parent.rowNumber;
      grouped.add(child.rowNumber);
    }
    logger.debug('resource-groups: Strategy 2', bucketName, 'parent', parent.rowNumber, 'children', childList.length);
  }

  /* --- Strategy 3: summary-prefix groups (fallback when not grouped by FEAT) --- */
  const prefixOf = (summary) => {
    const idx = (summary || '').indexOf(' - ');
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
    logger.debug('resource-groups: Strategy 3', bucketName, 'parent', parent.rowNumber, 'children', children.length);
  }
}
