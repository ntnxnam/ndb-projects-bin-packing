/**
 * Renders a Gantt chart: bar length = duration, bar thickness = people allocated.
 * (1 = no parallelization, >1 = team chose to parallelize within the project.)
 */

import { totalResources } from './sizing.js';

const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * @param {HTMLElement} container
 * @param {Array<{ project, startDate, endDate }>} schedule
 * @param {{ startDate: Date, endDate: Date }} timeline
 * @param {{ minBarHeightPx?: number, maxBarHeightPx?: number, dependentsByProject?: Map, capacity?: number }} options
 */
export function renderGantt(container, schedule, timeline, options = {}) {
  const minH = options.minBarHeightPx ?? 12;
  const maxH = options.maxBarHeightPx ?? 56;
  const dependentsByProject = options.dependentsByProject;
  const totalCapacity = options.capacity ?? 0;

  const rangeStart = timeline.startDate.getTime();
  const rangeEnd = timeline.endDate.getTime();
  const totalMs = Math.max(rangeEnd - rangeStart, 1);
  const totalMonths = totalMs / MONTH_MS;

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

  /* Build a per-month usage map so we can show reducing balance per bar.
     Only count headcount from non-child entries (children share parent's allocation). */
  const MONTH_MS_LOCAL = 30 * 24 * 60 * 60 * 1000;
  const timelineStartMs = timeline.startDate.getTime();
  function toMonthIdx(d) {
    return Math.round((d.getTime() - timelineStartMs) / MONTH_MS_LOCAL);
  }
  const usageAtMonth = new Map();
  const remainingBefore = [];
  for (const entry of schedule) {
    if (entry.isResourceGroupChild) {
      remainingBefore.push(null);
      continue;
    }
    const fte = entry.fte ?? totalResources(entry.project);
    const startMo = toMonthIdx(entry.startDate);
    const endMo = toMonthIdx(entry.endDate);
    /* Capture balance BEFORE this project's allocation */
    const usedBefore = usageAtMonth.get(startMo) ?? 0;
    remainingBefore.push(totalCapacity > 0 ? Math.max(0, totalCapacity - usedBefore) : null);
    /* Then record this project's usage */
    for (let m = startMo; m < endMo; m++) {
      usageAtMonth.set(m, (usageAtMonth.get(m) ?? 0) + fte);
    }
  }

  let topOffset = 0;
  const rowGap = 4;
  let schedIdx = 0;

  for (const entry of schedule) {
    const { project, startDate, endDate, rotated, rotatedFteCount, inProgress } = entry;
    const isChild = !!entry.isResourceGroupChild;
    const left = ((startDate.getTime() - rangeStart) / totalMs) * 100;
    const width = ((endDate.getTime() - startDate.getTime()) / totalMs) * 100;
    const effectiveFte = isChild ? 0 : totalResources(project);
    const height = isChild ? Math.max(minH * 0.65, 10) : scaleFte(totalResources(project));

    const bar = document.createElement('div');
    let barClass = 'gantt-bar';
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
    const slNoPrefix = project.rowNumber != null ? `${project.rowNumber} - ` : '';
    const rotationNote = rotated ? `\n↻ Rotated: ${rotatedFteCount} people (reused from completed projects)` : '';
    const inProgressNote = inProgress ? `\n⏳ In Progress — 50% remaining (${project.durationMonths ?? '—'} mo total → showing remaining)` : '';

    const remaining = remainingBefore[schedIdx];
    const balanceNote = remaining != null ? `\nAvailable before allocation: ${Math.round(remaining)} headcount` : '';
    const groupNote = isChild ? `\n📦 Part of resource group (shares parent Sl No ${project.resourceGroupParentRow}'s people — no additional headcount)` : '';
    const parentNote = project.resourceGroupChildRows?.length ? `\n📦 Resource group parent (${project.resourceGroupChildRows.length} sub-projects share these ${people.toFixed(1)} people)` : '';

    bar.title = `${slNoPrefix}${project.summary || '—'}\n${project.feat || ''} · ${project.durationMonths ?? '—'} mo · ${isChild ? '0 (shared)' : people.toFixed(1)} people${!isChild && people <= 1 ? ' (no parallelization)' : !isChild ? ' (parallelization chosen)' : ''}${balanceNote}${whyLine}${rotationNote}${inProgressNote}${groupNote}${parentNote}`;
    bar.dataset.fte = effectiveFte.toFixed(1);

    const label = document.createElement('span');
    label.className = 'gantt-bar-label';
    if (!isChild && remaining != null) {
      const balSpan = document.createElement('span');
      balSpan.className = 'gantt-bar-balance';
      balSpan.textContent = `[${Math.round(remaining)}] `;
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
    schedIdx++;
  }

  track.style.height = `${topOffset}px`;
  track.style.minHeight = `${Math.max(topOffset, 200)}px`;

  const trackHeight = track.style.height;
  const grid = document.createElement('div');
  grid.className = 'gantt-grid';
  grid.style.height = trackHeight;
  const rangeStartAxis = timeline.startDate.getTime();
  const rangeEndAxis = timeline.endDate.getTime();
  const totalMsAxis = Math.max(rangeEndAxis - rangeStartAxis, 1);
  const start = new Date(timeline.startDate);
  const end = new Date(timeline.endDate);
  const totalMonthsAxis = Math.ceil((end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth()) + 1);
  const maxTicks = 14;
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
}

/**
 * Renders the timeline axis above the chart.
 * Uses spaced ticks (max ~12–15 labels) so labels don't overlap on long ranges.
 */
export function renderTimelineAxis(container, timeline) {
  container.innerHTML = '';
  const start = new Date(timeline.startDate);
  const end = new Date(timeline.endDate);
  const rangeStartMs = start.getTime();
  const rangeEndMs = end.getTime();
  const totalMs = Math.max(rangeEndMs - rangeStartMs, 1);

  const totalMonths = Math.ceil((end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth()) + 1);
  const maxTicks = 14;
  const interval = Math.max(1, Math.floor(totalMonths / maxTicks));
  const tickMonths = [];
  for (let i = 0; i < totalMonths; i += interval) tickMonths.push(i);
  if (totalMonths > 0 && tickMonths[tickMonths.length - 1] !== totalMonths - 1) tickMonths.push(totalMonths - 1);

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
