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
 * @param {{ minBarHeightPx?: number, maxBarHeightPx?: number }} options
 */
export function renderGantt(container, schedule, timeline, options = {}) {
  const minH = options.minBarHeightPx ?? 12;
  const maxH = options.maxBarHeightPx ?? 56;

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

  container.innerHTML = '';

  const track = document.createElement('div');
  track.className = 'gantt-track';

  let topOffset = 0;
  const rowGap = 4;

  for (const { project, startDate, endDate } of schedule) {
    const left = ((startDate.getTime() - rangeStart) / totalMs) * 100;
    const width = ((endDate.getTime() - startDate.getTime()) / totalMs) * 100;
    const height = scaleFte(totalResources(project));

    const bar = document.createElement('div');
    bar.className = 'gantt-bar';
    bar.style.left = `${Math.max(0, left)}%`;
    bar.style.width = `${Math.min(100 - left, width)}%`;
    bar.style.height = `${height}px`;
    bar.style.top = `${topOffset}px`;
    const people = totalResources(project);
bar.title = `${project.summary}\n${project.feat || ''} · ${project.durationMonths} mo · ${people.toFixed(1)} people allocated${people <= 1 ? ' (no parallelization)' : ' (parallelization chosen)'}`;
    bar.dataset.fte = totalResources(project).toFixed(1);

    const label = document.createElement('span');
    label.className = 'gantt-bar-label';
    label.textContent = project.summary.slice(0, 40) + (project.summary.length > 40 ? '…' : '');
    bar.appendChild(label);

    track.appendChild(bar);
    topOffset += height + rowGap;
  }

  track.style.height = `${topOffset}px`;
  track.style.minHeight = `${Math.max(topOffset, 200)}px`;
  container.appendChild(track);
}

/**
 * Renders the timeline axis (months) above the chart.
 */
export function renderTimelineAxis(container, timeline) {
  container.innerHTML = '';
  const start = new Date(timeline.startDate);
  const end = new Date(timeline.endDate);
  const labels = [];
  const d = new Date(start);
  d.setDate(1);
  while (d <= end) {
    labels.push({ date: new Date(d), label: `${d.toLocaleString('default', { month: 'short' })} ${d.getFullYear()}` });
    d.setMonth(d.getMonth() + 1);
  }
  const totalMonths = (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth()) + 1;
  const step = 100 / totalMonths;

  const axis = document.createElement('div');
  axis.className = 'gantt-axis';
  labels.forEach((l, i) => {
    const tick = document.createElement('div');
    tick.className = 'gantt-axis-tick';
    tick.style.left = `${i * step}%`;
    tick.textContent = l.label;
    axis.appendChild(tick);
  });
  container.appendChild(axis);
}
