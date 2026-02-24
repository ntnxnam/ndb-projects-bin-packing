/**
 * Renders a Gantt chart: bar length = duration, bar thickness = people allocated.
 * (1 = no parallelization, >1 = team chose to parallelize within the project.)
 */

import { totalResources } from './sizing.js';

const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

function escapeHtmlLabel(s) {
  if (s == null) return '';
  const div = document.createElement('div');
  div.textContent = String(s);
  return div.innerHTML;
}

/**
 * @param {HTMLElement} container
 * @param {Array<{ project, startDate, endDate }>} schedule - display order (e.g. capacity-flow order)
 * @param {{ startDate: Date, endDate: Date }} timeline
 * @param {{ minBarHeightPx?: number, maxBarHeightPx?: number, dependentsByProject?: Map, childToParent?: Map, capacity?: number, capacityPct?: number, labelsContainer?: HTMLElement }} options
 *   labelsContainer = element for Column B (group) / Column C (project) labels. If set, header and rows are rendered there.
 */
export function renderGantt(container, schedule, timeline, options = {}) {
  const labelsContainer = options.labelsContainer ?? null;
  const minH = options.minBarHeightPx ?? 12;
  const maxH = options.maxBarHeightPx ?? 56;
  const dependentsByProject = options.dependentsByProject;
  const childToParent = options.childToParent ?? new Map();
  const resolveDep = (depRow) => childToParent.has(depRow) ? childToParent.get(depRow) : depRow;
  const headcount = options.capacity ?? 0;
  const capacityPct = options.capacityPct ?? 100;
  const pctFactor = capacityPct > 0 && capacityPct <= 100 ? capacityPct / 100 : 1;
  const rangeStart = timeline.startDate.getTime();
  const rangeEnd = timeline.endDate.getTime();
  const totalMs = Math.max(rangeEnd - rangeStart, 1);

  /* Bar thickness = allocated FTE; non-linear scale + cap so 2 vs 5 FTE are clearly distinct */
  const allocatedFte = (e) => e.isResourceGroupChild ? 0 : (e.fte ?? totalResources(e.project));
  const rawMaxFte = Math.max(1, ...schedule.map(allocatedFte));
  const maxFte = Math.min(rawMaxFte, 24);
  const scaleFte = (fte) => {
    if (maxFte <= 0 || fte <= 0) return minH;
    const t = Math.sqrt(Math.min(1, fte / maxFte));
    return minH + t * (maxH - minH);
  };

  function tooltipWhy(deps) {
    if (!deps || (!deps.devBlockerFor?.length && !deps.plainDepFor?.length)) return '';
    const parts = [];
    if (deps.devBlockerFor?.length) parts.push(`Dev-blocker for: ${deps.devBlockerFor.join(', ')}`);
    if (deps.plainDepFor?.length) parts.push(`Plain dependency for: ${deps.plainDepFor.join(', ')}`);
    return parts.length ? '\n' + parts.join('\n') : '';
  }

  container.innerHTML = '';

  const track = document.createElement('div');
  track.className = 'gantt-track';

  /* Build remaining-by-entry in display (schedule) order so "available before allocation"
     matches rank: rank 1 gets full headcount, then we subtract as we go down the list. */
  const timelineStartMs = timeline.startDate.getTime();
  function toMonthIdx(d) {
    return Math.round((d.getTime() - timelineStartMs) / MONTH_MS);
  }
  const usageAtMonth = new Map();
  const remainingByEntry = new Map();
  schedule.forEach(e => {
    if (e.isResourceGroupChild) remainingByEntry.set(e, null);
  });
  const balanceEntries = schedule.filter(e => !e.isResourceGroupChild);
  /* Outstanding = remaining people (headcount), not calculated capacity. */
  for (const entry of balanceEntries) {
    const fte = entry.fte ?? totalResources(entry.project);
    const startMo = toMonthIdx(entry.startDate);
    const endMo = toMonthIdx(entry.endDate);
    const usedPeopleBefore = usageAtMonth.get(startMo) ?? 0;
    const remaining = headcount > 0 ? Math.max(0, Math.round(headcount - usedPeopleBefore)) : null;
    remainingByEntry.set(entry, remaining);
    for (let m = startMo; m < endMo; m++) {
      usageAtMonth.set(m, (usageAtMonth.get(m) ?? 0) + fte);
    }
  }

  /* Pool order: 1-based within each bucket by rowNumber (59=#1, 60=#2, …) so numbering is stable regardless of display order. */
  const bucketEntries = new Map();
  for (const e of schedule) {
    const bucketKey = e.isResourceGroupChild && e.project?.resourceGroupParentRow != null
      ? e.project.resourceGroupParentRow
      : (!e.isResourceGroupChild && e.project?.resourceGroupChildRows?.length ? e.project.rowNumber : null);
    if (bucketKey == null) continue;
    if (!bucketEntries.has(bucketKey)) bucketEntries.set(bucketKey, []);
    bucketEntries.get(bucketKey).push(e);
  }
  for (const entries of bucketEntries.values()) {
    entries.sort((a, b) => (a.project?.rowNumber ?? 0) - (b.project?.rowNumber ?? 0));
    entries.forEach((e, i) => { e._poolOrder = i + 1; });
  }

  /* Per-group date range: min start and max end of all entries in each resource group (for main group bar) */
  const groupRangeByName = new Map();
  for (const e of schedule) {
    const name = e.project?.resourceGroupName;
    if (!name) continue;
    const startMs = e.startDate.getTime();
    const endMs = e.endDate.getTime();
    const existing = groupRangeByName.get(name);
    if (!existing) {
      groupRangeByName.set(name, { minStartMs: startMs, maxEndMs: endMs });
    } else {
      existing.minStartMs = Math.min(existing.minStartMs, startMs);
      existing.maxEndMs = Math.max(existing.maxEndMs, endMs);
    }
  }

  let topOffset = 0;
  const rowGap = 4;
  const rowData = []; /* { top, height, colB, colC, isGroup } for labels panel */

  const groupBarHeight = Math.max(minH * 0.8, 18);
  const narrowBarHeight = Math.max(minH * 0.65, 10);
  const drawnBucketSummary = new Set();

  for (const entry of schedule) {
    const { project, startDate, endDate, rotated, rotatedFteCount, inProgress } = entry;
    const isChild = !!entry.isResourceGroupChild;
    const remaining = remainingByEntry.get(entry) ?? null;
    const left = ((startDate.getTime() - rangeStart) / totalMs) * 100;
    const width = ((endDate.getTime() - startDate.getTime()) / totalMs) * 100;
    const effectiveFte = isChild ? 0 : (entry.fte ?? totalResources(project));
    const bucketName = project.resourceGroupName || '';
    const isBucketParent = !isChild && bucketName && project.resourceGroupChildRows?.length;
    const inBucket = isChild || isBucketParent;
    const height = inBucket ? narrowBarHeight : scaleFte(effectiveFte);

    /* When first entry of a bucket has a real date range: draw one wide summary bar, then bucket rows below. */
    if (bucketName && (isBucketParent || isChild)) {
      const groupRange = groupRangeByName.get(bucketName);
      const useMainGroupBar = groupRange && (groupRange.maxEndMs - groupRange.minStartMs) > 0;
      if (useMainGroupBar && !drawnBucketSummary.has(bucketName)) {
        drawnBucketSummary.add(bucketName);
        const gLeft = ((groupRange.minStartMs - rangeStart) / totalMs) * 100;
        const gWidth = ((groupRange.maxEndMs - groupRange.minStartMs) / totalMs) * 100;
        rowData.push({ top: topOffset, height: groupBarHeight, colB: bucketName, colC: bucketName, isGroup: true });
        const groupBar = document.createElement('div');
        groupBar.className = 'gantt-bar gantt-bar--grouping';
        groupBar.style.left = `${Math.max(0, gLeft)}%`;
        groupBar.style.width = `${Math.min(100 - gLeft, gWidth)}%`;
        groupBar.style.height = `${groupBarHeight}px`;
        groupBar.style.top = `${topOffset}px`;
        const groupLabel = document.createElement('span');
        groupLabel.className = 'gantt-bar-label';
        groupLabel.textContent = bucketName.length > 50 ? bucketName.slice(0, 50).trim() + '…' : bucketName;
        groupBar.appendChild(groupLabel);
        track.appendChild(groupBar);
        topOffset += groupBarHeight + rowGap;
      }
    }

    /* Bucket parent without main group bar: draw small group bar (legacy path). */
    if (isBucketParent) {
      const groupRange = groupRangeByName.get(bucketName);
      const useMainGroupBar = groupRange && (groupRange.maxEndMs - groupRange.minStartMs) > 0;
      if (!useMainGroupBar) {
        const noCapRight = remaining === 0 && headcount > 0;
        const gLeft = noCapRight ? Math.max(0, 100 - width) : left;
        const gWidth = Math.min(noCapRight ? 100 - gLeft : 100 - left, width);
        const slNoPrefixGrp = project.rowNumber != null ? `${project.rowNumber} - ` : '';
        const summaryGrp = (project.summary || '').slice(0, 40) + ((project.summary || '').length > 40 ? '…' : '') || '—';
        rowData.push({ top: topOffset, height: groupBarHeight, colB: bucketName, colC: slNoPrefixGrp + summaryGrp, isGroup: true });
        const groupBar = document.createElement('div');
        groupBar.className = 'gantt-bar gantt-bar--grouping' + (rotated ? ' gantt-bar--rotated' : '');
        groupBar.style.left = `${Math.max(0, gLeft)}%`;
        groupBar.style.width = `${gWidth}%`;
        groupBar.style.height = `${groupBarHeight}px`;
        groupBar.style.top = `${topOffset}px`;
        const groupLabel = document.createElement('span');
        groupLabel.className = 'gantt-bar-label';
        if (remaining != null) {
          const groupBal = document.createElement('span');
          groupBal.className = 'gantt-bar-balance';
          groupBal.textContent = `[${remaining}] `;
          groupLabel.appendChild(groupBal);
        }
        const groupLabelText = bucketName.length > 50 ? bucketName.slice(0, 50).trim() + '…' : bucketName;
        groupLabel.appendChild(document.createTextNode(groupLabelText));
        groupBar.appendChild(groupLabel);
        track.appendChild(groupBar);
        topOffset += groupBarHeight + rowGap;
      }
    }

    const slNoPrefix = project.rowNumber != null ? `${project.rowNumber} - ` : '';
    const summary = project.summary || '';
    const bucketNameForColB = bucketName || (project.feat && project.feat.trim()) || '—';
    const bar = document.createElement('div');
    let barClass = 'gantt-bar';
    if (entry.pastDeadline) barClass += ' gantt-bar--past-deadline';
    if (isChild) barClass += ' gantt-bar--group-child';
    else if (inProgress) barClass += ' gantt-bar--in-progress';
    else if (rotated) barClass += ' gantt-bar--rotated';
    if (project.resourceGroupChildRows?.length && !project.resourceGroupName) barClass += ' gantt-bar--group-parent';
    if (!isChild && remaining === 0 && headcount > 0) barClass += ' gantt-bar--no-capacity';
    bar.className = barClass;
    const noCapacityRight = !isChild && remaining === 0 && headcount > 0;
    const barLeft = noCapacityRight ? Math.max(0, 100 - width) : left;
    const barWidth = Math.min(noCapacityRight ? 100 - barLeft : 100 - left, width);
    bar.style.left = `${Math.max(0, barLeft)}%`;
    bar.style.width = `${barWidth}%`;
    bar.style.height = `${height}px`;
    bar.style.top = `${topOffset}px`;
    const people = effectiveFte || totalResources(project);
    const deps = project.rowNumber != null ? dependentsByProject?.get(project.rowNumber) : null;
    const whyLine = tooltipWhy(deps);
    const blockers = new Set(project.dependencyDevBlockers || []);
    const depRows = (project.dependencyRowNumbers || []).filter(r => r !== project.rowNumber);
    const dependsOnLine = depRows.length
      ? '\nDepends on (cannot complete until checked in): ' + [...new Set(depRows.map(r => resolveDep(r)))].map(resolved => {
          const isBlocker = depRows.some(d => resolveDep(d) === resolved && blockers.has(d));
          return isBlocker ? `${resolved} (Dev-blocker)` : `${resolved}`;
        }).join(', ')
      : '';
    const rotationNote = rotated ? `\n↻ Rotated: ${rotatedFteCount} people (reused from completed projects)` : '';
    const completedPct = Math.min(100, Math.max(0, project.completedPct ?? 0));
    const inProgressNote = completedPct > 0 ? `\n⏳ ${completedPct}% completed (${100 - completedPct}% remaining of ${project.durationMonths ?? '—'} mo total)` : '';

    const balanceNote = remaining != null ? `\nAvailable before allocation: ${remaining} headcount` : '';
    const groupNote = isChild
      ? `\n📦 Part of ${bucketName ? `bucket "${bucketName}"` : 'resource group'} (shares parent Sl No ${project.resourceGroupParentRow}'s people — no additional headcount)`
      : '';
    const parentNote = project.resourceGroupChildRows?.length
      ? `\n📦 Bucket "${bucketName || project.rowNumber}" (${project.resourceGroupChildRows.length} sub-projects share these ${people.toFixed(1)} people)`
      : '';
    const poolOrder = entry._poolOrder;
    const poolDependsOn = [...new Set(entry.poolDependsOn || [])];
    const poolOrderNote = (isChild || isBucketParent) && poolOrder != null
      ? (poolDependsOn.length > 0
          ? `\n📦 Order in pool: ${poolOrder} (after #${poolDependsOn.join(', #')})`
          : `\n📦 Order in pool: ${poolOrder}`)
      : '';

    const deadlineNote = entry.pastDeadline ? `\n⚠️ Extends past target date` : '';
    bar.title = `${slNoPrefix}${project.summary || '—'}\n${project.feat || ''} · ${project.durationMonths ?? '—'} mo · ${isChild ? '0 (shared)' : people.toFixed(1)} people${!isChild && people <= 1 ? ' (no parallelization)' : !isChild ? ' (parallelization chosen)' : ''}${balanceNote}${dependsOnLine}${whyLine}${rotationNote}${inProgressNote}${groupNote}${parentNote}${poolOrderNote}${deadlineNote}`;
    bar.dataset.fte = effectiveFte.toFixed(1);

    const maxBucketLabelLen = 50;
    const shortBucketName = bucketName && bucketName.length > maxBucketLabelLen
      ? bucketName.slice(0, maxBucketLabelLen).trim() + '…' : (bucketName || '');
    const truncLen = isChild ? 35 : 40;
    let summaryText = summary.slice(0, truncLen) + (summary.length > truncLen ? '…' : '') || '—';
    if ((isChild || isBucketParent) && (bucketName || poolOrder != null) && poolOrder != null) {
      if (poolDependsOn.length > 0) {
        summaryText = `#${poolOrder} in pool (after #${poolDependsOn.join(', #')}) · ${summaryText}`;
      } else {
        summaryText = `#${poolOrder} in pool · ${summaryText}`;
      }
    }
    const parentLabelRaw = !isChild && bucketName && !isBucketParent ? `${shortBucketName || bucketName} · ` : '';
    const hasMainGroupBar = isBucketParent && (() => {
      const gr = groupRangeByName.get(bucketName);
      return gr && (gr.maxEndMs - gr.minStartMs) > 0;
    })();
    const barLabelText = (hasMainGroupBar || isBucketParent)
      ? slNoPrefix + summaryText
      : (parentLabelRaw || slNoPrefix) + summaryText;
    rowData.push({ top: topOffset, height, colB: bucketNameForColB, colC: barLabelText, isGroup: false });

    const label = document.createElement('span');
    label.className = 'gantt-bar-label';
    if (!isChild && remaining != null && !isBucketParent) {
      const balSpan = document.createElement('span');
      balSpan.className = 'gantt-bar-balance';
      balSpan.textContent = `[${remaining}] `;
      label.appendChild(balSpan);
    }
    label.appendChild(document.createTextNode(barLabelText));
    bar.appendChild(label);

    track.appendChild(bar);
    topOffset += height + rowGap;
  }

  track.style.height = `${topOffset}px`;
  track.style.minHeight = `${Math.max(topOffset, 200)}px`;

  /* Column B (group/FEAT) and Column C (project) labels */
  if (labelsContainer) {
    labelsContainer.innerHTML = '';
    if (rowData.length === 0) labelsContainer.style.display = 'none';
    else {
      labelsContainer.style.display = '';
    const header = document.createElement('div');
    header.className = 'gantt-labels-header';
    header.innerHTML = '<span class="gantt-col-b">Column B (group)</span><span class="gantt-col-c">Column C (project)</span>';
    labelsContainer.appendChild(header);
    const rowsWrap = document.createElement('div');
    rowsWrap.className = 'gantt-labels-rows';
    rowsWrap.style.height = `${topOffset}px`;
    rowsWrap.style.minHeight = `${Math.max(topOffset, 200)}px`;
    for (const row of rowData) {
      const rowEl = document.createElement('div');
      rowEl.className = 'gantt-label-row' + (row.isGroup ? ' gantt-label-row--group' : '');
      rowEl.style.top = `${row.top}px`;
      rowEl.style.height = `${row.height + rowGap}px`;
      rowEl.innerHTML = `<span class="gantt-col-b">${escapeHtmlLabel(row.colB)}</span><span class="gantt-col-c">${escapeHtmlLabel(row.colC)}</span>`;
      rowsWrap.appendChild(rowEl);
    }
    labelsContainer.appendChild(rowsWrap);
    }
  }

  /* Viewport: user's start/end fill the visible area; rest is horizontal scroll */
  const visibleRange = options.visibleRange;
  let widthPct = 100;
  if (visibleRange) {
    const visibleMs = Math.max(visibleRange.endDate.getTime() - visibleRange.startDate.getTime(), 1);
    widthPct = Math.max(100, (totalMs / visibleMs) * 100);
  }
  container.style.width = `${widthPct}%`;
  track.style.width = '100%';

  const trackHeight = track.style.height;
  const grid = document.createElement('div');
  grid.className = 'gantt-grid';
  grid.style.height = trackHeight;
  grid.style.width = '100%';
  const rangeStartAxis = timeline.startDate.getTime();
  const rangeEndAxis = timeline.endDate.getTime();
  const totalMsAxis = Math.max(rangeEndAxis - rangeStartAxis, 1);
  const start = new Date(timeline.startDate);
  const end = new Date(timeline.endDate);
  const totalMonthsAxis = Math.ceil((end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth()) + 1);
  const maxTicks = Math.min(24, Math.max(14, totalMonthsAxis));
  const interval = Math.max(1, Math.floor(totalMonthsAxis / maxTicks));
  const tickMonths = [];
  for (let i = 0; i < totalMonthsAxis; i += interval) tickMonths.push(i);
  if (totalMonthsAxis > 0 && tickMonths[tickMonths.length - 1] !== totalMonthsAxis - 1) tickMonths.push(totalMonthsAxis - 1);
  for (const monthIndex of tickMonths) {
    const d = new Date(start.getFullYear(), start.getMonth() + monthIndex, 1);
    if (d > end) break;
    const posMs = d.getTime() - rangeStartAxis;
    const leftPct = (posMs / totalMsAxis) * 100;
    const line = document.createElement('div');
    line.className = 'gantt-grid-line';
    line.style.left = `${Math.max(0, Math.min(100, leftPct))}%`;
    grid.appendChild(line);
  }
  container.appendChild(grid);
  container.appendChild(track);

  /* Deadline marker: vertical line at target end date */
  const deadlineDate = options.deadlineDate;
  if (deadlineDate && deadlineDate.getTime() > rangeStart && deadlineDate.getTime() < rangeEnd) {
    const deadlinePct = ((deadlineDate.getTime() - rangeStart) / totalMs) * 100;
    const line = document.createElement('div');
    line.className = 'gantt-deadline-line';
    line.style.left = `${Math.max(0, Math.min(100, deadlinePct))}%`;
    line.style.height = track.style.height;
    container.appendChild(line);
  }
}

/**
 * Renders the timeline axis above the chart.
 * Uses spaced ticks (max ~12–15 labels) so labels don't overlap on long ranges.
 * If options.visibleRange is set, axis width is scaled so viewport matches user start/end.
 */
export function renderTimelineAxis(container, timeline, options = {}) {
  container.innerHTML = '';
  const start = new Date(timeline.startDate);
  const end = new Date(timeline.endDate);
  const rangeStartMs = start.getTime();
  const rangeEndMs = end.getTime();
  const totalMs = Math.max(rangeEndMs - rangeStartMs, 1);

  let widthPct = 100;
  const visibleRange = options.visibleRange;
  if (visibleRange) {
    const visibleMs = Math.max(visibleRange.endDate.getTime() - visibleRange.startDate.getTime(), 1);
    widthPct = Math.max(100, (totalMs / visibleMs) * 100);
  }

  const totalMonths = Math.ceil((end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth()) + 1);
  const maxTicks = Math.min(24, Math.max(14, totalMonths));
  const interval = Math.max(1, Math.floor(totalMonths / maxTicks));
  const tickMonths = [];
  for (let i = 0; i < totalMonths; i += interval) tickMonths.push(i);
  if (totalMonths > 0 && tickMonths[tickMonths.length - 1] !== totalMonths - 1) tickMonths.push(totalMonths - 1);

  container.style.width = `${widthPct}%`;
  const axis = document.createElement('div');
  axis.className = 'gantt-axis';
  for (const monthIndex of tickMonths) {
    const d = new Date(start.getFullYear(), start.getMonth() + monthIndex, 1);
    if (d > end) break;
    const label = `${d.toLocaleString('default', { month: 'short' })} ${d.getFullYear()}`;
    const posMs = d.getTime() - rangeStartMs;
    const leftPct = (posMs / totalMs) * 100;

    const tick = document.createElement('div');
    tick.className = 'gantt-axis-tick';
    tick.style.left = `${Math.max(0, Math.min(100, leftPct))}%`;
    tick.textContent = label;
    axis.appendChild(tick);
  }
  container.appendChild(axis);
}
