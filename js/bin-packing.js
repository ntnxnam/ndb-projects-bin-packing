/**
 * Bin packing for project scheduling.
 * Assumption: 1 person works on 1 project at a time (whole people). Duration = effort ÷ people when set.
 * Dependencies block completion/check-in: a project cannot finish before its dependency is checked in.
 * Ranking tiers: 0 = In-progress, 1 = Dev-blocker deps (more dependents first), 2 = Plain deps, 3 = Longest duration first.
 * Capacity is in effective FTE; we reserve ceil(people) per project so the schedule is realistic.
 * @module bin-packing
 */

import { durationMonths, remainingDurationMonths, totalResources, SIZING_MONTHS } from './sizing.js';
import { logger } from './logger.js';

/** When duration is missing and no sizing label: assume 1 FTE → long bar (months). */
const DEFAULT_DURATION_WHEN_UNKNOWN = 12;

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
 * For each project row: how many others list it as dev-blocker vs plain dependency.
 * @param {Array<object>} projects
 * @returns {{ devBlockerDependentsCount: Map<number, number>, plainDependentsCount: Map<number, number> }}
 */
export function getDependentsCounts(projects) {
  const list = projects || [];
  const childToParent = buildChildToParentMap(list);
  const byRowNumber = new Map(list.map((p, i) => [p.rowNumber ?? i + 1, p]));
  const devBlockerSet = (p) => new Set(p.dependencyDevBlockers || []);
  const devBlockerDependentsCount = new Map();
  const plainDependentsCount = new Map();
  for (const p of list) {
    const row = p.rowNumber ?? list.indexOf(p) + 1;
    devBlockerDependentsCount.set(row, 0);
    plainDependentsCount.set(row, 0);
  }
  for (const p of list) {
    const blockers = devBlockerSet(p);
    const internalDeps = (p.dependencyRowNumbers || []).filter(depRow => depRow !== p.rowNumber && byRowNumber.has(depRow));
    for (const depRow of internalDeps) {
      const resolved = resolveDepRow(depRow, childToParent);
      if (blockers.has(depRow)) {
        devBlockerDependentsCount.set(resolved, (devBlockerDependentsCount.get(resolved) || 0) + 1);
      } else {
        plainDependentsCount.set(resolved, (plainDependentsCount.get(resolved) || 0) + 1);
      }
    }
  }
  return { devBlockerDependentsCount, plainDependentsCount };
}

/**
 * Order: respect dependencies (all deps scheduled before a dependent). Among ready projects,
 * rank by: (1) dev-blockers first, (2) plain dependencies next, (3) longest duration first (reverse order).
 * Resource-group children are placed immediately after their parent (they don't independently consume capacity).
 */
export function orderByDependencyAndSize(projects) {
  const list = projects || [];
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
  const { devBlockerDependentsCount, plainDependentsCount } = getDependentsCounts(list);

  const rankCompare = (a, b) => {
    /* Rank 0: in-progress projects always come first */
    const ipA = a.inProgress ? 1 : 0;
    const ipB = b.inProgress ? 1 : 0;
    if (ipB !== ipA) return ipB - ipA;

    /* Priority tier: Tier 1 (P0 + Committed) scheduled before Tier 2 */
    const tierA = a._tier ?? 2;
    const tierB = b._tier ?? 2;
    if (tierA !== tierB) return tierA - tierB;

    const blockA = devBlockerDependentsCount.get(a.rowNumber) ?? 0;
    const blockB = devBlockerDependentsCount.get(b.rowNumber) ?? 0;
    if (blockB !== blockA) return blockB - blockA;
    const plainA = plainDependentsCount.get(a.rowNumber) ?? 0;
    const plainB = plainDependentsCount.get(b.rowNumber) ?? 0;
    if (plainB !== plainA) return plainB - plainA;
    const dmA = durationMonths(a);
    const dmB = durationMonths(b);
    if (dmB !== dmA) return dmB - dmA;
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
 * Capacity pack: projects ordered by ranking; each placed one after the other.
 * When a project is allocated, X people are blocked for Y months from the calculated capacity
 * (e.g. 100 FTEs × 60% = 60 people). Each project starts at the earliest month where
 * (1) all dependencies have ended and (2) X people fit within remaining capacity for Y months.
 *
 * Resource-group children: don't consume capacity independently. They are positioned within
 * their parent's time window and share the parent's FTE allocation.
 * @param {number} [capacityPct] - Capacity per FTE (0–100). When set, duration = totalPersonMonths / (devResources × capacityPct/100).
 */
export function packWithCapacity(projects, startDate, endDate, capacityFTE, capacityPct) {
  const sorted = orderByDependencyAndSize(projects);
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

  const capacityPeople = Math.floor(capacityFTE);

  function canFit(startMonthIndex, durationMonths, people) {
    const reserved = Math.ceil(people);
    for (let i = 0; i < durationMonths; i++) {
      const key = startMonthIndex + i;
      const used = usage.get(key) ?? 0;
      if (used + reserved > capacityPeople) return false;
    }
    return true;
  }

  function addUsage(startMonthIndex, durationMonths, people) {
    const reserved = Math.ceil(people);
    for (let i = 0; i < durationMonths; i++) {
      const key = startMonthIndex + i;
      usage.set(key, (usage.get(key) ?? 0) + reserved);
    }
  }

  /* Map from parent rowNumber → schedule entry; collect children for second pass */
  const parentScheduleEntry = new Map();
  const childrenByParentRow = new Map();
  for (const p of sorted) {
    if (p.isResourceGroupChild && p.resourceGroupParentRow != null) {
      const pr = p.resourceGroupParentRow;
      if (!childrenByParentRow.has(pr)) childrenByParentRow.set(pr, []);
      childrenByParentRow.get(pr).push(p);
    }
  }

  for (let i = 0; i < sorted.length; i++) {
    const p = sorted[i];

    if (p.isResourceGroupChild) continue;

    /* --- Normal project (including resource-group parents) --- */
    /* Bar width = remainingDurationMonths (already includes completion % and capacity %). */
    const rawMonths = durationFor(p);
    const rawFte = totalResources(p);
    let months = rawMonths > 0 ? rawMonths : (p.sizingLabel && SIZING_MONTHS[p.sizingLabel]) || DEFAULT_DURATION_WHEN_UNKNOWN;
    months = Math.max(1, months);
    const fte = rawFte <= 0 ? 0 : rawFte;

    const isInProgress = !!p.inProgress;

    /* Dependencies block completion/check-in: this project cannot finish before the dependency is "checked in".
       So we require endMonth >= dependency end month, i.e. startMonth >= earliestEndMonth - months.
       That allows work to start earlier (overlap with dependency) while still enforcing check-in order. */
    let earliestStartMonth = 0;
    if (!isInProgress) {
      const internalDepRows = (p.dependencyRowNumbers || [])
        .map(depRow => resolveDepRow(depRow, childToParent))
        .filter(depRow => endByRow.has(depRow));
      const depEnds = internalDepRows.map(depRow => endByRow.get(depRow)).filter(Boolean);
      if (depEnds.length > 0) {
        const maxEnd = new Date(Math.max(...depEnds.map(d => d.getTime())));
        const earliestEndMonth = monthIndex(maxEnd);
        if (earliestEndMonth >= 0) {
          earliestStartMonth = Math.max(0, earliestEndMonth - months);
        }
      }
    }

    let startMonth = earliestStartMonth;
    const MAX_SEARCH_MONTHS = 1200;
    const projectPeople = Math.ceil(fte);
    if (projectPeople > 0 && projectPeople <= capacityPeople) {
      while (!canFit(startMonth, months, fte) && startMonth - earliestStartMonth < MAX_SEARCH_MONTHS) {
        startMonth++;
      }
    }

    const startDateObj = dateFromMonthIndex(startMonth);
    const endDateObj = dateFromMonthIndex(startMonth + months);

    let rotatedFteCount = 0;
    let releasedFromIndex = undefined;
    if (startMonth > 0) {
      let freedAtStart = 0;
      let bestReleaserEnd = -1;
      for (let idx = 0; idx < result.length; idx++) {
        const prev = result[idx];
        if (prev.isResourceGroupChild) continue;
        const prevEnd = monthIndex(prev.endDate);
        if (prevEnd <= startMonth) {
          freedAtStart += prev.fte;
          if (prevEnd > bestReleaserEnd) {
            bestReleaserEnd = prevEnd;
            releasedFromIndex = idx;
          }
        }
      }
      rotatedFteCount = Math.min(fte, freedAtStart);
    }

    addUsage(startMonth, months, fte);
    const entry = { project: p, startDate: startDateObj, endDate: endDateObj, fte, rotated: rotatedFteCount > 0, rotatedFteCount, inProgress: isInProgress, releasedFromIndex };
    result.push(entry);
    if (p.rowNumber != null) {
      endByRow.set(p.rowNumber, endDateObj);
      if (p.resourceGroupChildRows?.length) parentScheduleEntry.set(p.rowNumber, entry);
    }
  }

  /* Defer 0-remaining projects to the end of the timeline (schedule when resources are back) */
  let maxEndMonth = 0;
  for (const e of result) {
    if (e.isResourceGroupChild) continue;
    const endMo = monthIndex(e.endDate);
    if (endMo > maxEndMonth) maxEndMonth = endMo;
  }
  for (const entry of result) {
    if (entry.isResourceGroupChild) continue;
    const startMo = monthIndex(entry.startDate);
    let usedAtStart = 0;
    for (const prev of result) {
      if (prev === entry) break;
      if (prev.isResourceGroupChild) continue;
      const pStart = monthIndex(prev.startDate);
      const pEnd = monthIndex(prev.endDate);
      if (startMo >= pStart && startMo < pEnd) usedAtStart += prev.fte ?? 0;
    }
    if (capacityPeople > 0 && usedAtStart >= capacityPeople) {
      const durationMonths = monthIndex(entry.endDate) - monthIndex(entry.startDate);
      const deferredStart = dateFromMonthIndex(maxEndMonth);
      const deferredEnd = dateFromMonthIndex(maxEndMonth + Math.max(1, durationMonths));
      entry.startDate = deferredStart;
      entry.endDate = deferredEnd;
      maxEndMonth += Math.max(1, durationMonths);
      if (entry.project?.rowNumber != null) endByRow.set(entry.project.rowNumber, deferredEnd);
    }
  }

  /* Second pass: place resource-group children — always serialize by dependency and ranking within parent window */
  const newResult = [];
  for (const entry of result) {
    newResult.push(entry);
    const parentRow = entry.project?.rowNumber;
    if (parentRow == null || !entry.project.resourceGroupChildRows?.length) continue;
    const childProjects = childrenByParentRow.get(parentRow) || [];
    if (childProjects.length === 0) continue;

    const parentStartMo = monthIndex(entry.startDate);
    const parentEndMo = monthIndex(entry.endDate);
    const parentDurationMo = Math.max(1, parentEndMo - parentStartMo);
    const siblingRows = new Set(entry.project.resourceGroupChildRows || []);
    /* Child duration: same bar-width formula (remainingDurationMonths already includes completion %). */
    const withMonths = childProjects.map(p => {
      const months = Math.max(1, durationFor(p) || SIZING_MONTHS[p.sizingLabel] || durationMonths(p) || 1);
      return {
        p,
        months,
        poolDependsOn: [...new Set((p.dependencyRowNumbers || []).filter(
          dep => dep === parentRow || siblingRows.has(dep)
        ))],
      };
    });
    let cursor = parentStartMo;
    const totalMonths = withMonths.reduce((s, x) => s + x.months, 0);
    const scale = totalMonths > 0 ? parentDurationMo / totalMonths : 1;
    for (let i = 0; i < withMonths.length; i++) {
      const { p: child, months: childMonths, poolDependsOn: poolDeps } = withMonths[i];
      const segMonths = Math.max(1, Math.round(scale * childMonths));
      const segEndMo = Math.min(cursor + segMonths, parentEndMo);
      newResult.push({
        project: child,
        startDate: dateFromMonthIndex(cursor),
        endDate: dateFromMonthIndex(segEndMo),
        fte: 0,
        rotated: false,
        rotatedFteCount: 0,
        inProgress: entry.inProgress,
        isResourceGroupChild: true,
        poolDependsOn: poolDeps,
        _poolOrder: i + 1,
      });
      if (child.rowNumber != null) endByRow.set(child.rowNumber, dateFromMonthIndex(segEndMo));
      cursor = segEndMo;
    }
  }

  logger.debug('bin-packing.packWithCapacity: scheduled', newResult.length, 'entries');
  return newResult;
}

/**
 * Returns the latest end date in a schedule (for fluid timeline).
 */
export function getScheduleEnd(schedule) {
  if (!schedule?.length) return null;
  return new Date(Math.max(...schedule.map(s => s.endDate.getTime())));
}

/**
 * Reorder schedule for display so that projects that receive freed capacity
 * appear directly below the project that released them (releaser → receiver).
 * Keeps resource-group parent+children together as blocks.
 */
export function orderByCapacityFlow(schedule) {
  if (!schedule?.length) return schedule;
  const blocks = [];
  for (let i = 0; i < schedule.length; i++) {
    const entry = schedule[i];
    if (entry.isResourceGroupChild) {
      blocks[blocks.length - 1].entries.push(entry);
    } else {
      blocks.push({ mainIndex: i, entries: [entry] });
    }
  }
  const mainIndexToBlockIndex = new Map();
  blocks.forEach((b, bi) => mainIndexToBlockIndex.set(b.mainIndex, bi));
  const displayBlocks = [];
  for (const block of blocks) {
    const mainEntry = block.entries[0];
    const fromIdx = mainEntry.releasedFromIndex;
    if (fromIdx !== undefined && mainEntry.rotated) {
      const releaserBlock = blocks[mainIndexToBlockIndex.get(fromIdx)];
      if (releaserBlock) {
        let insertAfter = displayBlocks.indexOf(releaserBlock);
        while (insertAfter !== -1 && insertAfter + 1 < displayBlocks.length) {
          const next = displayBlocks[insertAfter + 1];
          if (next.entries[0].releasedFromIndex === fromIdx) insertAfter++;
          else break;
        }
        if (insertAfter !== -1) {
          displayBlocks.splice(insertAfter + 1, 0, block);
          continue;
        }
      }
    }
    displayBlocks.push(block);
  }
  return displayBlocks.flatMap(b => b.entries);
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
