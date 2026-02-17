/**
 * Bin packing for project scheduling.
 * - Order: dependency-first (dependencies before dependents), then by size (largest first).
 * - Sequential: one after another from startDate; each project starts after its dependencies end.
 * - Capacity: same order; each project starts at earliest month where dependencies are met and FTE fits.
 * Timeline starts 01 Apr 2026; capacity = 100 FTEs (Dev + QA) by default.
 */

import { durationMonths, totalResources } from './sizing.js';

/**
 * Sort by duration descending (largest first), then by total resources descending.
 */
export function sortByLargestFirst(projects) {
  return [...projects].sort((a, b) => {
    const dmA = durationMonths(a);
    const dmB = durationMonths(b);
    if (dmB !== dmA) return dmB - dmA;
    return totalResources(b) - totalResources(a);
  });
}

/**
 * Order so dependencies come first. Within each "ready" batch: prefer projects that
 * block others (e.g. SMSP, then Hermes) so they get done first; then by size (largest first).
 */
export function orderByDependencyAndSize(projects) {
  const list = projects || [];
  const byRowNumber = new Map(list.map((p, i) => [p.rowNumber ?? i + 1, p]));

  const dependentsCount = new Map();
  for (const p of list) {
    const row = p.rowNumber ?? list.indexOf(p) + 1;
    dependentsCount.set(row, 0);
  }
  for (const p of list) {
    for (const depRow of p.dependencyRowNumbers || []) {
      if (depRow !== p.rowNumber && byRowNumber.has(depRow)) {
        dependentsCount.set(depRow, (dependentsCount.get(depRow) || 0) + 1);
      }
    }
  }

  const result = [];
  const added = new Set();

  while (result.length < list.length) {
    const ready = list.filter(
      p => !added.has(p) &&
        (p.dependencyRowNumbers || []).every(depRow => {
          if (depRow === p.rowNumber) return true;
          const dep = byRowNumber.get(depRow);
          return !dep || added.has(dep);
        })
    );
    if (ready.length === 0) {
      result.push(...list.filter(p => !added.has(p)));
      break;
    }
    const sorted = [...ready].sort((a, b) => {
      const blockA = dependentsCount.get(a.rowNumber) ?? 0;
      const blockB = dependentsCount.get(b.rowNumber) ?? 0;
      if (blockB !== blockA) return blockB - blockA;
      const dmA = durationMonths(a);
      const dmB = durationMonths(b);
      if (dmB !== dmA) return dmB - dmA;
      return totalResources(b) - totalResources(a);
    });
    sorted.forEach(p => { result.push(p); added.add(p); });
  }
  return result;
}

/**
 * Sequential pack: dependency order + size; each project starts after its dependencies end.
 */
export function packSequential(projects, startDate) {
  const sorted = orderByDependencyAndSize(projects);
  const result = [];
  const endByRow = new Map();

  for (const p of sorted) {
    const months = durationMonths(p);
    if (months <= 0) continue;

    const depEnds = (p.dependencyRowNumbers || []).map(depRow => endByRow.get(depRow)).filter(Boolean);
    let cursor = new Date(startDate);
    if (depEnds.length > 0) {
      const maxEnd = new Date(Math.max(...depEnds.map(d => d.getTime())));
      if (maxEnd.getTime() > cursor.getTime()) cursor = maxEnd;
    }

    const end = new Date(cursor);
    end.setMonth(end.getMonth() + months);
    result.push({ project: p, startDate: new Date(cursor), endDate: end });
    if (p.rowNumber != null) endByRow.set(p.rowNumber, end);
  }
  return result;
}

/**
 * Capacity pack: dependency order + size; each project starts at earliest month where
 * (1) all dependencies have ended and (2) FTE fits within capacity for its duration.
 */
export function packWithCapacity(projects, startDate, endDate, capacityFTE) {
  const sorted = orderByDependencyAndSize(projects);
  const result = [];
  const usage = new Map();
  const endByRow = new Map();

  function monthKey(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }

  function canFit(start, durationMonths, fte) {
    const d = new Date(start);
    for (let i = 0; i < durationMonths; i++) {
      const key = monthKey(d);
      const used = usage.get(key) || 0;
      if (used + fte > capacityFTE) return false;
      d.setMonth(d.getMonth() + 1);
    }
    return true;
  }

  function addUsage(start, durationMonths, fte) {
    const d = new Date(start);
    for (let i = 0; i < durationMonths; i++) {
      const key = monthKey(d);
      usage.set(key, (usage.get(key) || 0) + fte);
      d.setMonth(d.getMonth() + 1);
    }
  }

  const timelineStart = new Date(startDate);

  for (let i = 0; i < sorted.length; i++) {
    const p = sorted[i];
    const months = durationMonths(p);
    const fte = totalResources(p);
    if (months <= 0 || fte <= 0) continue;

    const depEnds = (p.dependencyRowNumbers || []).map(depRow => endByRow.get(depRow)).filter(Boolean);
    let earliestStart = new Date(timelineStart);
    if (depEnds.length > 0) {
      const maxEnd = Math.max(...depEnds.map(d => d.getTime()));
      if (maxEnd > earliestStart.getTime()) earliestStart = new Date(maxEnd);
    }

    let start = new Date(earliestStart);
    while (!canFit(start, months, fte)) {
      start.setMonth(start.getMonth() + 1);
    }

    const end = new Date(start);
    end.setMonth(end.getMonth() + months);
    addUsage(start, months, fte);
    result.push({ project: p, startDate: new Date(start), endDate: end });
    if (p.rowNumber != null) endByRow.set(p.rowNumber, end);
  }
  return result;
}

/**
 * Returns the latest end date in a schedule (for fluid timeline).
 */
export function getScheduleEnd(schedule) {
  if (!schedule?.length) return null;
  return new Date(Math.max(...schedule.map(s => s.endDate.getTime())));
}

/**
 * Find minimum FTE capacity such that packWithCapacity fits entirely before deadline.
 */
export function findMinCapacityToFit(projects, startDate, endDate) {
  const deadline = endDate.getTime();
  let lo = 1;
  let hi = 1000;
  let best = null;
  let bestSchedule = null;

  for (const p of projects || []) {
    const r = totalResources(p);
    if (r > 0) hi = Math.max(hi, Math.ceil(r) * 2);
  }

  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const farEnd = new Date(endDate);
    farEnd.setFullYear(farEnd.getFullYear() + 2);
    const schedule = packWithCapacity(projects, startDate, farEnd, mid);
    const maxEnd = getScheduleEnd(schedule);
    const fits = maxEnd && maxEnd.getTime() <= deadline;

    if (fits) {
      best = mid;
      bestSchedule = schedule;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return { minCapacity: best, schedule: bestSchedule };
}
