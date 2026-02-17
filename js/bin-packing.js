/**
 * Bin packing for project scheduling.
 * - Sequential: sort by duration (largest first), place one after another.
 * - Capacity: same order, place each project at earliest slot where FTE capacity is not exceeded.
 * Time is discretized by month; capacity is total FTE per month.
 */

import { durationMonths, totalResources } from './sizing.js';

/**
 * Sort projects by duration descending (largest first), then by total resources descending.
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
 * Sequential pack: one project after another from startDate.
 * Returns array of { project, startDate (Date), endDate (Date) }.
 */
export function packSequential(projects, startDate) {
  const sorted = sortByLargestFirst(projects);
  const result = [];
  let cursor = new Date(startDate);

  for (const p of sorted) {
    const months = durationMonths(p);
    if (months <= 0) continue;
    const end = new Date(cursor);
    end.setMonth(end.getMonth() + months);
    result.push({
      project: p,
      startDate: new Date(cursor),
      endDate: end,
    });
    cursor = end;
  }
  return result;
}

/**
 * Capacity pack: place each project at earliest month where adding its FTE
 * does not exceed capacity in any month of its duration.
 * startDate/endDate define the allowed window; projects can extend past endDate.
 */
export function packWithCapacity(projects, startDate, endDate, capacityFTE) {
  const sorted = sortByLargestFirst(projects);
  const result = [];
  // Monthly usage: map monthKey (YYYY-MM) -> total FTE used that month.
  const usage = new Map();

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

  let cursor = new Date(startDate);

  for (const p of sorted) {
    const months = durationMonths(p);
    const fte = totalResources(p);
    if (months <= 0 || fte <= 0) continue;

    // Find earliest start that fits (from cursor onward).
    let start = new Date(cursor);
    while (!canFit(start, months, fte)) {
      start.setMonth(start.getMonth() + 1);
    }

    const end = new Date(start);
    end.setMonth(end.getMonth() + months);
    addUsage(start, months, fte);
    result.push({
      project: p,
      startDate: new Date(start),
      endDate: end,
    });

    // Advance cursor if this project started at cursor (so next project doesn't start before).
    if (start.getTime() === cursor.getTime()) {
      cursor = new Date(end);
    }
  }
  return result;
}
