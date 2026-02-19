/**
 * Bin packing for project scheduling.
 * Dependencies block completion/check-in: a project can start but cannot complete until
 * its dependency is checked in (so dependent's end >= dependency's end; overlap allowed).
 * Ranking tiers:
 *   0 — In-progress (STATUS = "In Progress"): pinned to start; remaining duration from project.completedPct (CSV "How much is Completed in %").
 *   1 — Dev-blocker dependencies: higher count → higher rank.
 *   2 — Plain dependencies: higher count → higher rank.
 *   3 — Everything else: longest duration first.
 * Timeline starts 01 Apr 2026; capacity is Dev-only (QA not considered).
 */

import { durationMonths, totalResources, SIZING_MONTHS } from './sizing.js';

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

  /* Insert resource-group children immediately after their parent */
  const finalResult = [];
  for (const p of result) {
    finalResult.push(p);
    const children = childrenByParent.get(p.rowNumber);
    if (children?.length) {
      finalResult.push(...children.sort((a, b) => (a.rowNumber ?? 0) - (b.rowNumber ?? 0)));
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
 */
export function packWithCapacity(projects, startDate, endDate, capacityFTE) {
  const sorted = orderByDependencyAndSize(projects);
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

  function canFit(startMonthIndex, durationMonths, fte) {
    for (let i = 0; i < durationMonths; i++) {
      const key = startMonthIndex + i;
      const used = usage.get(key) ?? 0;
      if (used + fte > capacityFTE) return false;
    }
    return true;
  }

  function addUsage(startMonthIndex, durationMonths, fte) {
    for (let i = 0; i < durationMonths; i++) {
      const key = startMonthIndex + i;
      usage.set(key, (usage.get(key) ?? 0) + fte);
    }
  }

  /* Map from parent rowNumber → schedule entry, so children can reference parent's window */
  const parentScheduleEntry = new Map();

  for (let i = 0; i < sorted.length; i++) {
    const p = sorted[i];

    /* --- Resource-group child: no capacity impact, positioned within parent's window --- */
    if (p.isResourceGroupChild) {
      const parentRow = p.resourceGroupParentRow;
      const parentEntry = parentScheduleEntry.get(parentRow);
      if (parentEntry) {
        const parentStartMo = monthIndex(parentEntry.startDate);
        const parentDuration = monthIndex(parentEntry.endDate) - parentStartMo;
        const childRawMonths = durationMonths(p) <= 0 ? 1 : durationMonths(p);
        const cappedMonths = Math.min(childRawMonths, Math.max(parentDuration, 1));
        const childStart = dateFromMonthIndex(parentStartMo);
        const childEnd = dateFromMonthIndex(parentStartMo + cappedMonths);
        result.push({
          project: p, startDate: childStart, endDate: childEnd,
          fte: 0, rotated: false, rotatedFteCount: 0,
          inProgress: parentEntry.inProgress, isResourceGroupChild: true,
        });
        if (p.rowNumber != null) endByRow.set(p.rowNumber, parentEntry.endDate);
      }
      continue;
    }

    /* --- Normal project (including resource-group parents) --- */
    const rawMonths = durationMonths(p);
    const rawFte = totalResources(p);
    let fullMonths = rawMonths > 0 ? rawMonths : null;
    if (fullMonths == null && p.sizingLabel && SIZING_MONTHS[p.sizingLabel] != null) {
      fullMonths = SIZING_MONTHS[p.sizingLabel];
    }
    if (fullMonths == null || fullMonths <= 0) {
      fullMonths = DEFAULT_DURATION_WHEN_UNKNOWN;
    }
    const fte = rawFte <= 0 ? 1 : rawFte;

    const isInProgress = !!p.inProgress;
    const completedPct = Math.min(100, Math.max(0, p.completedPct ?? 0));
    const remainingFraction = (100 - completedPct) / 100;
    const months = remainingFraction <= 0 ? 1 : Math.max(1, Math.ceil(fullMonths * remainingFraction));

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
    if (fte <= capacityFTE) {
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
