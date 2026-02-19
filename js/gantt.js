/**
 * Renders a Gantt chart: bar length = duration, bar thickness = people allocated.
 * (1 = no parallelization, >1 = team chose to parallelize within the project.)
 */

import { totalResources } from './sizing.js';

const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * @param {HTMLElement} container
 * @param {Array<{ project, startDate, endDate }>} schedule - display order (e.g. capacity-flow order)
 * @param {{ startDate: Date, endDate: Date }} timeline
 * @param {{ minBarHeightPx?: number, maxBarHeightPx?: number, dependentsByProject?: Map, childToParent?: Map, capacity?: number, capacityPct?: number }} options
 *   childToParent = resource-group child rowNumber → parent rowNumber for resolving deps. Remaining balance is computed in display (schedule) order so rank 1 gets full headcount.
 */
export function renderGantt(container, schedule, timeline, options = {}) {
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

  const maxFte = Math.max(1, ...schedule.map(s => totalResources(s.project)));
  const scaleFte = (fte) => {
    if (maxFte <= 0) return minH;
    const t = fte / maxFte;
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
  for (const entry of balanceEntries) {
    const fte = entry.fte ?? totalResources(entry.project);
    const startMo = toMonthIdx(entry.startDate);
    const endMo = toMonthIdx(entry.endDate);
    const usedEffectiveBefore = usageAtMonth.get(startMo) ?? 0;
    const usedHeadcountBefore = pctFactor > 0 ? usedEffectiveBefore / pctFactor : 0;
    const remaining = headcount > 0 ? Math.max(0, Math.round(headcount - usedHeadcountBefore)) : null;
    remainingByEntry.set(entry, remaining);
    for (let m = startMo; m < endMo; m++) {
      usageAtMonth.set(m, (usageAtMonth.get(m) ?? 0) + fte);
    }
  }

  let topOffset = 0;
  const rowGap = 4;

  for (const entry of schedule) {
    const { project, startDate, endDate, rotated, rotatedFteCount, inProgress } = entry;
    const isChild = !!entry.isResourceGroupChild;
    const left = ((startDate.getTime() - rangeStart) / totalMs) * 100;
    const width = ((endDate.getTime() - startDate.getTime()) / totalMs) * 100;
    const effectiveFte = isChild ? 0 : totalResources(project);
    const height = isChild ? Math.max(minH * 0.65, 10) : scaleFte(totalResources(project));

    const bar = document.createElement('div');
    let barClass = 'gantt-bar';
    if (entry.pastDeadline) barClass += ' gantt-bar--past-deadline';
    if (isChild) barClass += ' gantt-bar--group-child';
    else if (inProgress) barClass += ' gantt-bar--in-progress';
    else if (rotated) barClass += ' gantt-bar--rotated';
    if (project.resourceGroupChildRows?.length) barClass += ' gantt-bar--group-parent';
    bar.className = barClass;
    bar.style.left = `${Math.max(0, left)}%`;
    bar.style.width = `${Math.min(100 - left, width)}%`;
    bar.style.height = `${height}px`;
    bar.style.top = `${topOffset}px`;
    const people = totalResources(project);
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
    const slNoPrefix = project.rowNumber != null ? `${project.rowNumber} - ` : '';
    const rotationNote = rotated ? `\n↻ Rotated: ${rotatedFteCount} people (reused from completed projects)` : '';
    const completedPct = Math.min(100, Math.max(0, project.completedPct ?? 0));
    const inProgressNote = completedPct > 0 ? `\n⏳ ${completedPct}% completed (${100 - completedPct}% remaining of ${project.durationMonths ?? '—'} mo total)` : '';

    const remaining = remainingByEntry.get(entry) ?? null;
    const balanceNote = remaining != null ? `\nAvailable before allocation: ${remaining} headcount` : '';
    const groupNote = isChild ? `\n📦 Part of resource group (shares parent Sl No ${project.resourceGroupParentRow}'s people — no additional headcount)` : '';
    const parentNote = project.resourceGroupChildRows?.length ? `\n📦 Resource group parent (${project.resourceGroupChildRows.length} sub-projects share these ${people.toFixed(1)} people)` : '';

    const deadlineNote = entry.pastDeadline ? `\n⚠️ Extends past target date` : '';
    bar.title = `${slNoPrefix}${project.summary || '—'}\n${project.feat || ''} · ${project.durationMonths ?? '—'} mo · ${isChild ? '0 (shared)' : people.toFixed(1)} people${!isChild && people <= 1 ? ' (no parallelization)' : !isChild ? ' (parallelization chosen)' : ''}${balanceNote}${dependsOnLine}${whyLine}${rotationNote}${inProgressNote}${groupNote}${parentNote}${deadlineNote}`;
    bar.dataset.fte = effectiveFte.toFixed(1);

    const label = document.createElement('span');
    label.className = 'gantt-bar-label';
    if (!isChild && remaining != null) {
      const balSpan = document.createElement('span');
      balSpan.className = 'gantt-bar-balance';
      balSpan.textContent = `[${remaining}] `;
      label.appendChild(balSpan);
    }
    const summary = project.summary || '';
    const truncLen = isChild ? 35 : 40;
    const childPrefix = isChild ? '  ↳ ' : '';
    const summaryText = summary.slice(0, truncLen) + (summary.length > truncLen ? '…' : '') || '—';
    label.appendChild(document.createTextNode(childPrefix + slNoPrefix + summaryText));
    bar.appendChild(label);

    track.appendChild(bar);
    topOffset += height + rowGap;
  }

  track.style.height = `${topOffset}px`;
  track.style.minHeight = `${Math.max(topOffset, 200)}px`;

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
