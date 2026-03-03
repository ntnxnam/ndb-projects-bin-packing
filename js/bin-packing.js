/**
 * Bin packing for project scheduling.
 * Assumption: 1 person works on 1 project at a time (whole people). Duration = effort ÷ people when set.
 * Dependencies block completion/check-in: a project cannot finish before its dependency is checked in.
 * Capacity-constrained: each project is placed at the earliest month where (a) all dependencies
 * have ended and (b) its people fit within remaining headcount. No month may exceed capacityFTE
 * (raw headcount, e.g. 85 — NOT effective FTE). The capacityPct only stretches bar duration.
 * @module bin-packing
 */

import { durationMonths, remainingDurationMonths, totalResources, hasDurationData, SIZING_MONTHS, monthsFromSizingBand } from './sizing.js';
import { logger } from './logger.js';

/** When duration is missing and no sizing label: assume 1 FTE → long bar (months). */
const DEFAULT_DURATION_WHEN_UNKNOWN = 12;

const MONTH_NAMES = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];

/**
 * Parse a requested start date string into a Date (1st of that month).
 * Accepts: YYYY-MM-DD, YYYY-MM, "Jun 2026", "June 2026", "2026-06", month number (1–12),
 * or Excel serial numbers. Returns null if unparseable.
 * @param {string} raw
 * @param {Date} timelineStart - schedule start, used to infer year when only month is given
 * @returns {Date|null}
 */
function parseRequestedStartDate(raw, timelineStart) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;

  const isoMatch = s.match(/^(\d{4})-(\d{1,2})(?:-\d{1,2})?$/);
  if (isoMatch) return new Date(+isoMatch[1], +isoMatch[2] - 1, 1);

  /* D/Mon/YY or D/Mon/YYYY — month as 3-letter abbreviation, 2- or 4-digit year */
  const abbrevMatch = s.match(/^(\d{1,2})\/([A-Za-z]{3,})\/(\d{2,4})$/);
  if (abbrevMatch) {
    const day = +abbrevMatch[1];
    const mi = MONTH_NAMES.indexOf(abbrevMatch[2].slice(0, 3).toLowerCase());
    let y = +abbrevMatch[3];
    if (y < 100) y += 2000;
    if (mi >= 0 && day >= 1 && day <= 31) return new Date(y, mi, 1);
  }

  /* Flexible: M/D/YYYY or D/M/YYYY — auto-detect by checking which part > 12 */
  const slashMatch = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/);
  if (slashMatch) {
    const a = +slashMatch[1], b = +slashMatch[2];
    let y = +slashMatch[3];
    if (y < 100) y += 2000;
    let month, day;
    if (a > 12 && b <= 12)      { day = a; month = b; }
    else if (b > 12 && a <= 12) { month = a; day = b; }
    else                        { month = a; day = b; } /* ambiguous → M/D/YYYY */
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31)
      return new Date(y, month - 1, 1);
  }

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

  const serial = parseFloat(s);
  if (!Number.isNaN(serial) && serial > 40000) {
    const d = new Date(Math.round((serial - 25569) * 86400000));
    if (!Number.isNaN(d.getTime())) return new Date(d.getFullYear(), d.getMonth(), 1);
  }

  return null;
}

/**
 * Build a map: child rowNumber → parent rowNumber, for resource groups.
 * When a project depends on a child, treat it as depending on the parent.
 */
function buildChildToParentMap(projects) {
  const map = new Map();
  for (const p of projects) {
    if (p.isResourceGroupChild && p.resourceGroupParentRow != null) {
      map.set(p.rowNumber, p.resourceGroupParentRow);
    }
  }
  return map;
}

/**
 * Resolve a dependency row number: if it points to a resource-group child,
 * redirect to the parent (since the child shares the parent's FTE pool).
 */
function resolveDepRow(depRow, childToParent) {
  return childToParent.has(depRow) ? childToParent.get(depRow) : depRow;
}

/**
 * Build dependents-count maps for ranking display and comparison.
 * For each project row: how many others list it as dev-blocker, rel-blocker, or plain dependency.
 * @param {Array<object>} projects
 * @returns {{ devBlockerDependentsCount: Map<number, number>, relBlockerDependentsCount: Map<number, number>, plainDependentsCount: Map<number, number> }}
 */
export function getDependentsCounts(projects) {
  const list = projects || [];
  const childToParent = buildChildToParentMap(list);
  const byRowNumber = new Map(list.map((p, i) => [p.rowNumber ?? i + 1, p]));
  const devBlockerSet = (p) => new Set(p.dependencyDevBlockers || []);
  const relBlockerSet = (p) => new Set(p.dependencyRelBlockers || []);
  const devBlockerDependentsCount = new Map();
  const relBlockerDependentsCount = new Map();
  const plainDependentsCount = new Map();
  for (const p of list) {
    const row = p.rowNumber ?? list.indexOf(p) + 1;
    devBlockerDependentsCount.set(row, 0);
    relBlockerDependentsCount.set(row, 0);
    plainDependentsCount.set(row, 0);
  }
  for (const p of list) {
    const devBlockers = devBlockerSet(p);
    const relBlockers = relBlockerSet(p);
    const internalDeps = (p.dependencyRowNumbers || []).filter(depRow => depRow !== p.rowNumber && byRowNumber.has(depRow));
    for (const depRow of internalDeps) {
      const resolved = resolveDepRow(depRow, childToParent);
      if (devBlockers.has(depRow)) {
        devBlockerDependentsCount.set(resolved, (devBlockerDependentsCount.get(resolved) || 0) + 1);
      } else if (relBlockers.has(depRow)) {
        relBlockerDependentsCount.set(resolved, (relBlockerDependentsCount.get(resolved) || 0) + 1);
      } else {
        plainDependentsCount.set(resolved, (plainDependentsCount.get(resolved) || 0) + 1);
      }
    }
  }
  return { devBlockerDependentsCount, relBlockerDependentsCount, plainDependentsCount };
}

/**
 * Assign display tiers to projects based on their properties (before packing).
 *   0 = In Progress
 *   1 = Ready to Start (no deps, or all deps are on in-progress projects)
 *   2 = Waiting on Dependencies (has dep on a non-in-progress project)
 *
 * Resource-group children inherit their parent's tier.
 */
export function assignDisplayTiers(projects, timelineStart) {
  const list = projects || [];
  const byRow = new Map(list.map(p => [p.rowNumber, p]));
  const childToParent = buildChildToParentMap(list);
  const tsMs = timelineStart ? new Date(timelineStart).getTime() : 0;

  for (const p of list) {
    if (p.isResourceGroupChild) continue;
    if (p.inProgress) { p._displayTier = 0; continue; }

    /* Check if this project has a requested start date after the timeline start */
    let isDeferred = false;
    if (p.requestedStartDate && tsMs > 0) {
      const parsed = parseRequestedStartDate(p.requestedStartDate, new Date(timelineStart));
      if (parsed && parsed.getTime() > tsMs) {
        isDeferred = true;
      }
    }

    const deps = (p.dependencyRowNumbers || []).filter(d => d !== p.rowNumber);
    let waitingOnNonIP = false;
    if (deps.length > 0) {
      for (const depRow of deps) {
        const resolved = childToParent.has(depRow) ? childToParent.get(depRow) : depRow;
        const dep = byRow.get(resolved);
        if (!dep || !dep.inProgress) { waitingOnNonIP = true; break; }
      }
    }

    if (waitingOnNonIP) {
      p._displayTier = 3;
    } else if (isDeferred) {
      p._displayTier = 2;
    } else {
      p._displayTier = 1;
    }
  }
  for (const p of list) {
    if (!p.isResourceGroupChild) continue;
    const parent = byRow.get(p.resourceGroupParentRow);
    p._displayTier = parent?._displayTier ?? 1;
  }
}

/**
 * Order: respect dependencies (all deps scheduled before a dependent). Among ready projects,
 * rank by: (0) display tier, (1) fund-first, (2) priority tier, (3) blocker count, (4–6) sub-blocker types, (7) duration, (8) row number.
 * Resource-group children are placed immediately after their parent (they don't independently consume capacity).
 */
export function orderByDependencyAndSize(projects, timelineStart) {
  const list = projects || [];
  assignDisplayTiers(list, timelineStart);
  const childToParent = buildChildToParentMap(list);
  const mainProjects = list.filter(p => !p.isResourceGroupChild);
  const childrenByParent = new Map();
  for (const p of list) {
    if (p.isResourceGroupChild && p.resourceGroupParentRow != null) {
      if (!childrenByParent.has(p.resourceGroupParentRow)) childrenByParent.set(p.resourceGroupParentRow, []);
      childrenByParent.get(p.resourceGroupParentRow).push(p);
    }
  }

  const byRowNumber = new Map(list.map((p, i) => [p.rowNumber ?? i + 1, p]));
  const { devBlockerDependentsCount, relBlockerDependentsCount, plainDependentsCount } = getDependentsCounts(list);

  const rankCompare = (a, b) => {
    /* 0. Display tier: In Progress (0) → Ready (1) → Deferred (2) → Waiting (3) */
    const dtA = a._displayTier ?? 3;
    const dtB = b._displayTier ?? 3;
    if (dtA !== dtB) return dtA - dtB;

    /* 1. Fund First: user-pinned projects always schedule before others */
    const ffA = a._fundFirst ? 1 : 0;
    const ffB = b._fundFirst ? 1 : 0;
    if (ffB !== ffA) return ffB - ffA;

    /* 2. Priority tier: 1=P0+Committed, 2=P1 Committed, 3=P0 Approved, 4=P1 Approved, 5=rest */
    const tierA = a._tier ?? 5;
    const tierB = b._tier ?? 5;
    if (tierA !== tierB) return tierA - tierB;

    /* 3. Total projects I block (more first): dev + rel + plain dependents */
    const blockA = devBlockerDependentsCount.get(a.rowNumber) ?? 0;
    const blockB = devBlockerDependentsCount.get(b.rowNumber) ?? 0;
    const relA = relBlockerDependentsCount.get(a.rowNumber) ?? 0;
    const relB = relBlockerDependentsCount.get(b.rowNumber) ?? 0;
    const plainA = plainDependentsCount.get(a.rowNumber) ?? 0;
    const plainB = plainDependentsCount.get(b.rowNumber) ?? 0;
    const totalA = blockA + relA + plainA;
    const totalB = blockB + relB + plainB;
    if (totalB !== totalA) return totalB - totalA;

    /* 4. Dev-blocker dependents (more first) */
    if (blockB !== blockA) return blockB - blockA;

    /* 5. Rel-blocker dependents (more first) */
    if (relB !== relA) return relB - relA;

    /* 6. Plain dependents (more first) */
    if (plainB !== plainA) return plainB - plainA;

    /* 7. Duration (longest first) */
    const dmA = durationMonths(a);
    const dmB = durationMonths(b);
    if (dmB !== dmA) return dmB - dmA;

    /* 8. Row number */
    const slA = a.rowNumber ?? 999999;
    const slB = b.rowNumber ?? 999999;
    return slA - slB;
  };

  /* Only rank and order main (non-child) projects */
  const rankOrdered = [...mainProjects].sort(rankCompare);
  const result = [];
  const added = new Set();

  while (result.length < mainProjects.length) {
    let chosen = null;
    for (const p of rankOrdered) {
      if (added.has(p)) continue;
      const internalDeps = (p.dependencyRowNumbers || [])
        .map(depRow => resolveDepRow(depRow, childToParent))
        .filter(depRow => byRowNumber.has(depRow) && depRow !== p.rowNumber);
      if (p.inProgress) {
        const inProgressDeps = internalDeps.filter(depRow => byRowNumber.get(depRow)?.inProgress);
        if (!inProgressDeps.every(depRow => added.has(byRowNumber.get(depRow)))) continue;
      } else {
        if (!internalDeps.every(depRow => added.has(byRowNumber.get(depRow)))) continue;
      }
      chosen = p;
      break;
    }
    if (chosen) {
      result.push(chosen);
      added.add(chosen);
    } else {
      result.push(...mainProjects.filter(p => !added.has(p)));
      break;
    }
  }

  /* Insert resource-group children after their parent, ordered by dependency within the pool */
  function orderChildrenByDependency(parent, children) {
    const siblingRows = new Set(parent.resourceGroupChildRows || []);
    siblingRows.add(parent.rowNumber);
    const depsInPool = (proj) => (proj.dependencyRowNumbers || []).filter(
      dep => dep === parent.rowNumber || siblingRows.has(dep)
    );
    const sorted = [];
    const added = new Set();
    let remaining = [...children];
    while (remaining.length > 0) {
      const ready = remaining.filter(c => depsInPool(c).every(d => added.has(d)));
      if (ready.length === 0) {
        sorted.push(...remaining.sort((a, b) => (a.rowNumber ?? 0) - (b.rowNumber ?? 0)));
        break;
      }
      ready.sort((a, b) => (a.rowNumber ?? 0) - (b.rowNumber ?? 0));
      for (const c of ready) {
        sorted.push(c);
        added.add(c.rowNumber);
      }
      remaining = remaining.filter(c => !added.has(c.rowNumber));
    }
    return sorted;
  }

  const finalResult = [];
  for (const p of result) {
    finalResult.push(p);
    const children = childrenByParent.get(p.rowNumber);
    if (children?.length) {
      finalResult.push(...orderChildrenByDependency(p, children));
    }
  }
  return finalResult;
}

/**
 * Topological sort of sub-projects within a pool, respecting only intra-pool dependencies.
 * Falls back to rowNumber order for sub-projects with no internal deps.
 */
function topoSortSubProjects(subProjects, siblingRows) {
  const sorted = [];
  const added = new Set();
  let remaining = [...subProjects];
  while (remaining.length > 0) {
    const ready = remaining.filter(p => {
      const deps = (p.dependencyRowNumbers || []).filter(
        d => d !== p.rowNumber && siblingRows.has(d)
      );
      return deps.every(d => added.has(d));
    });
    if (ready.length === 0) {
      remaining.sort((a, b) => (a.rowNumber ?? 0) - (b.rowNumber ?? 0));
      sorted.push(...remaining);
      break;
    }
    ready.sort((a, b) => (a.rowNumber ?? 0) - (b.rowNumber ?? 0));
    for (const p of ready) {
      sorted.push(p);
      added.add(p.rowNumber);
    }
    remaining = remaining.filter(p => !added.has(p.rowNumber));
  }
  return sorted;
}

/**
 * Capacity pack: projects ordered by ranking; each placed one after the other.
 * When a project is allocated, X people (raw headcount) are blocked for Y months.
 * The capacityPct stretches duration (bar width) but does NOT shrink the people pool.
 * Each project starts at the earliest month where
 * (1) all dependencies have ended and (2) X people fit within remaining capacity for Y months.
 *
 * Resource-group children: don't consume capacity independently. They are positioned within
 * their parent's time window and share the parent's FTE allocation.
 * @param {number} [capacityPct] - Capacity per FTE (0–100). When set, duration = totalPersonMonths / (devResources × capacityPct/100).
 */
export function packWithCapacity(projects, startDate, endDate, capacityFTE, capacityPct) {
  const sorted = orderByDependencyAndSize(projects, startDate);
  /* Bar width = remaining person-months ÷ (dev resources × capacity %). Single formula for all. */
  const durationFor = (p) => remainingDurationMonths(p, capacityPct);
  const childToParent = buildChildToParentMap(sorted);
  const result = [];
  const usage = new Map();
  const endByRow = new Map();

  const timelineStart = new Date(startDate);
  timelineStart.setDate(1);

  function monthIndex(d) {
    return (d.getFullYear() - timelineStart.getFullYear()) * 12 + (d.getMonth() - timelineStart.getMonth());
  }

  function dateFromMonthIndex(idx) {
    const d = new Date(timelineStart.getFullYear(), timelineStart.getMonth() + idx, 1);
    return d;
  }

  function addUsage(startMonthIndex, durationMonths, people) {
    const reserved = Math.ceil(people);
    for (let i = 0; i < durationMonths; i++) {
      const key = startMonthIndex + i;
      usage.set(key, (usage.get(key) ?? 0) + reserved);
    }
  }

  function canFit(startMonthIndex, durationMonths, people) {
    const reserved = Math.ceil(people);
    if (reserved <= 0) return true;
    for (let i = 0; i < durationMonths; i++) {
      const key = startMonthIndex + i;
      if ((usage.get(key) ?? 0) + reserved > capacityFTE) return false;
    }
    return true;
  }

  /* Collect children by parent row for second pass */
  const childrenByParentRow = new Map();
  for (const p of sorted) {
    if (p.isResourceGroupChild && p.resourceGroupParentRow != null) {
      const pr = p.resourceGroupParentRow;
      if (!childrenByParentRow.has(pr)) childrenByParentRow.set(pr, []);
      childrenByParentRow.get(pr).push(p);
    }
  }

  /* Place a single project into the schedule, updating usage and endByRow.
     Returns the schedule entry, or null if the project is a resource-group child. */
  function placeProject(p) {
    if (p.isResourceGroupChild) return null;

    const isPoolParent = p.resourceGroupRole === 'pool-parent' && p._pool;
    let rawMonths, rawFte, missingDurationData;

    if (isPoolParent) {
      const pool = p._pool;
      const pct = capacityPct > 0 && capacityPct <= 100 ? capacityPct / 100 : 1;
      const poolFte = pool.totalResources || 0;
      const poolPM = pool.totalPersonMonthsNum;

      let budgetMonths = 0;
      if (poolPM > 0 && poolFte > 0 && pct > 0) {
        budgetMonths = Math.max(1, Math.ceil(poolPM / (poolFte * pct)));
      } else if (pool.durationMonths > 0) {
        budgetMonths = pool.durationMonths;
      }

      const children = childrenByParentRow.get(p.rowNumber) || [];
      const allSubProjects = [p, ...children];
      const siblingRows = new Set(allSubProjects.map(s => s.rowNumber));

      const poolBlockCount = new Map();
      for (const sub of allSubProjects) {
        let count = 0;
        for (const other of allSubProjects) {
          if (other.rowNumber === sub.rowNumber) continue;
          if ((other.dependencyRowNumbers || []).includes(sub.rowNumber)) count++;
        }
        poolBlockCount.set(sub.rowNumber, count);
      }

      const subEndByRow = new Map();
      const subSchedule = [];
      const poolUsage = new Map();
      const poolSlots = Math.max(1, poolFte);

      const poolUsedAt = (month) => poolUsage.get(month) ?? 0;
      const addPoolUsage = (start, dur) => {
        for (let m = start; m < start + dur; m++) poolUsage.set(m, (poolUsage.get(m) ?? 0) + 1);
      };
      const canFitPoolLocal = (start, dur) => {
        for (let m = start; m < start + dur; m++) {
          if (poolUsedAt(m) >= poolSlots) return false;
        }
        return true;
      };

      const ranked = [...allSubProjects].sort((a, b) => {
        const ba = poolBlockCount.get(a.rowNumber) ?? 0;
        const bb = poolBlockCount.get(b.rowNumber) ?? 0;
        if (bb !== ba) return bb - ba;
        const da = monthsFromSizingBand(a.sizingLabel) || durationFor(a) || 1;
        const db = monthsFromSizingBand(b.sizingLabel) || durationFor(b) || 1;
        if (db !== da) return db - da;
        return (a.rowNumber ?? 0) - (b.rowNumber ?? 0);
      });

      const scheduled = new Set();
      const remaining = [...ranked];
      while (remaining.length > 0) {
        let placed = false;
        for (let idx = 0; idx < remaining.length; idx++) {
          const sub = remaining[idx];
          const subDeps = (sub.dependencyRowNumbers || []).filter(
            dep => dep !== sub.rowNumber && siblingRows.has(dep)
          );
          if (!subDeps.every(d => scheduled.has(d))) continue;

          const subMonths = monthsFromSizingBand(sub.sizingLabel) || durationFor(sub) || 1;
          let subStart = 0;
          for (const depRow of subDeps) {
            const depEnd = subEndByRow.get(depRow);
            if (depEnd != null) subStart = Math.max(subStart, depEnd);
          }
          while (!canFitPoolLocal(subStart, subMonths)) subStart++;

          subEndByRow.set(sub.rowNumber, subStart + subMonths);
          addPoolUsage(subStart, subMonths);
          subSchedule.push({ project: sub, startMonthOffset: subStart, months: subMonths, poolDependsOn: subDeps });
          scheduled.add(sub.rowNumber);
          remaining.splice(idx, 1);
          placed = true;
          break;
        }
        if (!placed) {
          for (const sub of remaining) {
            const subMonths = monthsFromSizingBand(sub.sizingLabel) || durationFor(sub) || 1;
            const subDeps = (sub.dependencyRowNumbers || []).filter(
              dep => dep !== sub.rowNumber && siblingRows.has(dep)
            );
            let subStart = 0;
            for (const depRow of subDeps) {
              const depEnd = subEndByRow.get(depRow);
              if (depEnd != null) subStart = Math.max(subStart, depEnd);
            }
            subEndByRow.set(sub.rowNumber, subStart + subMonths);
            subSchedule.push({ project: sub, startMonthOffset: subStart, months: subMonths, poolDependsOn: subDeps });
            scheduled.add(sub.rowNumber);
          }
          break;
        }
      }

      const chainDuration = Math.max(0, ...Array.from(subEndByRow.values()));
      rawMonths = Math.max(budgetMonths, chainDuration, 1);
      rawFte = poolFte;
      missingDurationData = budgetMonths <= 0;
      p._poolSchedule = subSchedule;
      p._poolBudgetMonths = budgetMonths;
      p._poolChainMonths = chainDuration;
    } else {
      rawMonths = durationFor(p);
      rawFte = totalResources(p);
      missingDurationData = !hasDurationData(p);
    }

    const months = rawMonths > 0 ? rawMonths : 1;
    const fte = rawFte <= 0 ? 0 : rawFte;
    const isInProgress = !!p.inProgress;

    let earliestStartMonth = 0;
    if (p.requestedStartDate) {
      const reqDate = parseRequestedStartDate(p.requestedStartDate, timelineStart);
      if (reqDate) {
        earliestStartMonth = Math.max(earliestStartMonth, monthIndex(reqDate));
      }
    }
    if (!isInProgress) {
      const internalDepRows = (p.dependencyRowNumbers || [])
        .map(depRow => resolveDepRow(depRow, childToParent))
        .filter(depRow => endByRow.has(depRow));
      for (const resolved of internalDepRows) {
        const depEnd = endByRow.get(resolved);
        if (!depEnd) continue;
        earliestStartMonth = Math.max(earliestStartMonth, monthIndex(depEnd));
      }
    }

    let startMonth = earliestStartMonth;
    if (isPoolParent && p._poolSchedule) {
      const poolUsageByMonth = new Map();
      for (const sub of p._poolSchedule) {
        for (let m = sub.startMonthOffset; m < sub.startMonthOffset + sub.months; m++) {
          poolUsageByMonth.set(m, (poolUsageByMonth.get(m) ?? 0) + 1);
        }
      }
      const canFitPoolGlobal = (offset) => {
        for (const [relMonth, slotsUsed] of poolUsageByMonth) {
          const absMonth = offset + relMonth;
          if ((usage.get(absMonth) ?? 0) + slotsUsed > capacityFTE) return false;
        }
        return true;
      };
      while (!canFitPoolGlobal(startMonth)) startMonth++;
      for (const [relMonth, slotsUsed] of poolUsageByMonth) {
        const absMonth = startMonth + relMonth;
        usage.set(absMonth, (usage.get(absMonth) ?? 0) + slotsUsed);
      }
      p._poolStartMonth = startMonth;
    } else {
      while (!canFit(startMonth, months, fte)) {
        startMonth++;
      }
      addUsage(startMonth, months, fte);
    }

    const startDateObj = dateFromMonthIndex(startMonth);
    const endDateObj = dateFromMonthIndex(startMonth + months);
    const remainingBefore = capacityFTE - (usage.get(startMonth) ?? 0);
    const entry = {
      project: p, startDate: startDateObj, endDate: endDateObj, fte,
      rotated: false, rotatedFteCount: 0, inProgress: isInProgress,
      releasedFromIndex: undefined, missingDurationData: !!missingDurationData,
      isPoolContainer: !!isPoolParent,
      _displayTier: p._displayTier ?? 1,
      _remainingAtPlacement: capacityFTE > 0 ? Math.max(0, remainingBefore) : null,
    };
    result.push(entry);
    if (p.rowNumber != null) {
      endByRow.set(p.rowNumber, endDateObj);
    }
    return entry;
  }

  /* --- Main packing loop with gap-fill ---
     Process projects in rank order. After placing each one, try to fill
     capacity gaps with smaller unplaced projects whose deps are met.
     This maximizes utilization: small projects start early rather than
     waiting behind large ones in the rank queue. */
  const placed = new Set();

  function depsMetFor(p) {
    if (p.inProgress) return true;
    const depRows = (p.dependencyRowNumbers || [])
      .map(depRow => resolveDepRow(depRow, childToParent))
      .filter(depRow => depRow !== p.rowNumber);
    return depRows.every(depRow => endByRow.has(depRow));
  }

  for (let i = 0; i < sorted.length; i++) {
    const p = sorted[i];
    if (p.isResourceGroupChild || placed.has(p.rowNumber)) continue;

    placeProject(p);
    placed.add(p.rowNumber);

    /* Gap-fill: try to place unplaced projects that fit, smallest FTE first */
    const candidates = [];
    for (let j = i + 1; j < sorted.length; j++) {
      const c = sorted[j];
      if (c.isResourceGroupChild || placed.has(c.rowNumber)) continue;
      if (!depsMetFor(c)) continue;
      candidates.push(c);
    }
    candidates.sort((a, b) => (totalResources(a) || 0) - (totalResources(b) || 0));

    for (const c of candidates) {
      const isPoolC = c.resourceGroupRole === 'pool-parent' && c._pool;
      const cFte = isPoolC ? (c._pool.totalResources || 0) : (totalResources(c) || 0);
      if (cFte <= 0) continue;
      const cMonths = isPoolC ? 1 : (durationFor(c) || 1); // pool duration determined inside placeProject
      let cStart = 0;
      if (c.requestedStartDate) {
        const reqDate = parseRequestedStartDate(c.requestedStartDate, timelineStart);
        if (reqDate) cStart = Math.max(cStart, monthIndex(reqDate));
      }
      const cDepRows = (c.dependencyRowNumbers || [])
        .map(depRow => resolveDepRow(depRow, childToParent))
        .filter(depRow => endByRow.has(depRow));
      for (const resolved of cDepRows) {
        const depEnd = endByRow.get(resolved);
        if (depEnd) cStart = Math.max(cStart, monthIndex(depEnd));
      }
      /* For non-pool projects, only gap-fill if it fits at its earliest start
         without sliding (otherwise it would be placed in rank order later). */
      if (!isPoolC && canFit(cStart, cMonths, cFte)) {
        placeProject(c);
        placed.add(c.rowNumber);
      }
    }
  }

  /* Second pass: emit sub-project entries for pool containers */
  const newResult = [];
  for (const entry of result) {
    newResult.push(entry);
    const p = entry.project;
    if (!entry.isPoolContainer || !p._poolSchedule) continue;

    const containerStartMo = monthIndex(entry.startDate);

    for (let i = 0; i < p._poolSchedule.length; i++) {
      const sub = p._poolSchedule[i];
      const subStartMo = containerStartMo + sub.startMonthOffset;
      const subEndMo = subStartMo + sub.months;
      const childEntry = {
        project: sub.project,
        startDate: dateFromMonthIndex(subStartMo),
        endDate: dateFromMonthIndex(subEndMo),
        fte: 0,
        rotated: false,
        rotatedFteCount: 0,
        inProgress: entry.inProgress,
        isResourceGroupChild: true,
        isPoolSubProject: true,
        poolDependsOn: sub.poolDependsOn,
        _poolOrder: i + 1,
        missingDurationData: false,
        _displayTier: entry._displayTier,
        _remainingAtPlacement: null,
      };
      newResult.push(childEntry);
      if (sub.project.rowNumber != null) {
        endByRow.set(sub.project.rowNumber, dateFromMonthIndex(subEndMo));
      }
    }
  }

  /* Reorder within each tier by start month so the Remaining column
     decreases coherently. Pool children stay immediately after their parent. */
  const parents = [];
  const childMap = new Map();
  let currentParentRow = null;
  for (const e of newResult) {
    if (e.isResourceGroupChild || e.isPoolSubProject) {
      if (currentParentRow != null) {
        if (!childMap.has(currentParentRow)) childMap.set(currentParentRow, []);
        childMap.get(currentParentRow).push(e);
      }
    } else {
      parents.push(e);
      currentParentRow = e.project?.rowNumber ?? null;
    }
  }

  parents.sort((a, b) => {
    const ta = a._displayTier ?? 1;
    const tb = b._displayTier ?? 1;
    if (ta !== tb) return ta - tb;
    return a.startDate.getTime() - b.startDate.getTime();
  });

  /* Recalculate _remainingAtPlacement in display order using a fresh usage scan */
  const displayUsage = new Map();
  const sortedResult = [];
  for (const entry of parents) {
    const sMo = monthIndex(entry.startDate);
    entry._remainingAtPlacement = capacityFTE > 0
      ? Math.max(0, capacityFTE - (displayUsage.get(sMo) ?? 0))
      : null;
    const fte = entry.fte ?? 0;
    const eMo = monthIndex(entry.endDate);
    if (entry.isPoolContainer && entry.project?._poolSchedule) {
      const poolStartMo = entry.project._poolStartMonth ?? sMo;
      for (const sub of entry.project._poolSchedule) {
        for (let m = sub.startMonthOffset; m < sub.startMonthOffset + sub.months; m++) {
          const abs = poolStartMo + m;
          displayUsage.set(abs, (displayUsage.get(abs) ?? 0) + 1);
        }
      }
    } else {
      const reserved = Math.ceil(fte);
      for (let m = sMo; m < eMo; m++) {
        displayUsage.set(m, (displayUsage.get(m) ?? 0) + reserved);
      }
    }
    sortedResult.push(entry);
    const pRow = entry.project?.rowNumber;
    if (pRow != null && childMap.has(pRow)) {
      sortedResult.push(...childMap.get(pRow));
    }
  }

  logger.debug('bin-packing.packWithCapacity: scheduled', sortedResult.length, 'entries');
  return sortedResult;
}

/**
 * Returns the latest end date in a schedule (for fluid timeline).
 */
export function getScheduleEnd(schedule) {
  if (!schedule?.length) return null;
  return new Date(Math.max(...schedule.map(s => s.endDate.getTime())));
}

/**
 * Projects that end in the last fraction of the timeline (timeline drivers / long poles).
 * fraction e.g. 0.25 = last 25% of the time range.
 */
export function getLongPoles(schedule, timelineEnd, fraction = 0.25) {
  if (!schedule?.length || !timelineEnd) return [];
  const endMs = timelineEnd.getTime();
  const startMs = Math.min(...schedule.map(s => s.startDate.getTime()));
  const rangeMs = Math.max(endMs - startMs, 1);
  const cutoffMs = endMs - fraction * rangeMs;
  return schedule.filter(s => s.endDate.getTime() >= cutoffMs);
}
