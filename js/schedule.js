/**
 * Schedule page: Gantt chart, spare capacity, long poles, past-deadline list.
 * Loads projects from state or data/projects.json; respects filters and capacity.
 * @module schedule
 */

import { getEl, formatDate } from './utils.js';
import {
  DEFAULT_START,
  DEFAULT_END,
  DEFAULT_NUM_FTES,
  DEFAULT_CAPACITY_PCT,
  NUM_FTES_MIN,
  NUM_FTES_MAX,
  CAPACITY_PCT_MIN,
  CAPACITY_PCT_MAX,
} from './config.js';
import { logger } from './logger.js';
import { getScheduleData, setScheduleData, getProjects, getFilters, setFilters } from './state.js';
import { filterByPriority, tagPriorityTiers } from './filters.js';
import { prepareScheduleData } from './prepare-schedule.js';
import { packWithCapacity, getScheduleEnd, getLongPoles } from './bin-packing.js';

const MONTH_MS = 30 * 24 * 60 * 60 * 1000;
import { orderByDependencyAndSize, getDependentsByProject, orderScheduleByBlockersFirst } from './ranking.js';
import { renderGantt, renderTimelineAxis } from './gantt.js';
import { totalResources } from './sizing.js';
import { detectResourceGroups } from './resource-groups.js';
import { generateExecReport } from './exec-report.js';

/** Projects list for this page (from state or data/projects.json). */
let projects = [];

/** Last schedule context for export. */
let lastScheduleCtx = null;

/**
 * Parse YYYY-MM-DD string to Date at start of day.
 * @param {string} str
 * @returns {Date}
 */
function parseDate(str) {
  const [y, m, d] = str.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/**
 * Read schedule form state and apply config bounds.
 * @returns {{ startDate: Date, endDate: Date, capacity: number, numFTEs: number, capacityPct: number, priority: string }}
 */
function getScheduleState() {
  const numFTEsRaw = getEl('numFTEs')?.value?.trim();
  const numFTEs = Math.max(NUM_FTES_MIN, Math.min(NUM_FTES_MAX, parseInt(numFTEsRaw, 10) || DEFAULT_NUM_FTES));
  const capacityPctRaw = (getEl('capacityPerFte')?.value ?? '').trim();
  const capacityPct = Math.max(CAPACITY_PCT_MIN, Math.min(CAPACITY_PCT_MAX, parseFloat(capacityPctRaw) || DEFAULT_CAPACITY_PCT));
  const capacity = (numFTEs * capacityPct) / 100;
  const startStr = getEl('startDate')?.value ?? DEFAULT_START;
  const endStr = getEl('endDate')?.value ?? DEFAULT_END;
  const priority = (getEl('priority')?.value || '').trim();
  return {
    startDate: parseDate(startStr),
    endDate: parseDate(endStr),
    capacity,
    numFTEs,
    capacityPct,
    priority,
  };
}

/**
 * Render spare capacity: SVG area chart with capacity ceiling line,
 * color-coded utilization columns, hover tooltip, and actionable insights.
 */
function renderSpareCapacity(schedule, startDate, endDate, capacity, numFTEs, capacityPct, visibleRange) {
  const section = getEl('spareCapacitySection');
  const descEl = getEl('spareCapacityDesc');
  const chartEl = getEl('spareCapacityChart');
  const listEl = getEl('spareCapacityList');
  if (!section || !descEl || !chartEl || !listEl) return;

  if (!schedule?.length || capacity <= 0) {
    section.style.display = 'none';
    return;
  }

  const tsStart = new Date(startDate);
  tsStart.setDate(1);
  const monthIdx = (d) => (d.getFullYear() - tsStart.getFullYear()) * 12 + (d.getMonth() - tsStart.getMonth());
  const dateFromMonth = (idx) => new Date(tsStart.getFullYear(), tsStart.getMonth() + idx, 1);

  const endMo = endDate ? monthIdx(endDate) : 0;
  const totalMonths = Math.max(endMo + 1, 1);

  const usage = new Map();
  for (const entry of schedule) {
    if (entry.isResourceGroupChild) continue;
    const fte = entry.fte ?? totalResources(entry.project);
    const sMo = monthIdx(entry.startDate);
    const eMo = monthIdx(entry.endDate);
    for (let m = sMo; m < eMo; m++) usage.set(m, (usage.get(m) ?? 0) + fte);
  }

  const headcount = numFTEs || Math.round(capacity);
  const months = [];
  let totalSpare = 0;
  let peakUsed = 0;
  for (let m = 0; m < totalMonths; m++) {
    const usedHC = Math.ceil(usage.get(m) ?? 0);
    const spareHC = Math.max(0, headcount - usedHC);
    peakUsed = Math.max(peakUsed, usedHC);
    totalSpare += spareHC;
    const d = dateFromMonth(m);
    const utilPct = headcount > 0 ? Math.round((usedHC / headcount) * 100) : 0;
    months.push({ month: m, date: d, used: usedHC, spare: spareHC, utilPct, label: d.toLocaleString('default', { month: 'short', year: '2-digit' }) });
  }

  /* --- Actionable summary line --- */
  const peakMonth = months.reduce((best, m) => m.used > best.used ? m : best, months[0]);
  const avgUtil = months.length > 0 ? Math.round(months.reduce((s, m) => s + m.utilPct, 0) / months.length) : 0;
  const firstLowMonth = months.find(m => m.utilPct < 50);
  const summaryParts = [
    `${headcount} people at ${capacityPct}% capacity`,
    `Peak: ${peakUsed} in ${peakMonth.label} (${peakMonth.utilPct}%)`,
    `Avg utilization: ${avgUtil}%`,
  ];
  if (firstLowMonth) summaryParts.push(`>50% spare from ${firstLowMonth.label}`);
  descEl.textContent = summaryParts.join('  ·  ');

  /* --- SVG area chart --- */
  const chartH = 130;
  const labelH = 18;
  const padTop = 12;
  const padRight = 4;
  const svgH = chartH + labelH + padTop;
  const maxVal = Math.max(headcount, peakUsed, 1);
  const colW = Math.max(20, 800 / totalMonths);
  const svgW = colW * totalMonths + padRight;
  const yScale = (val) => padTop + chartH - (val / maxVal) * chartH;
  const baselineY = padTop + chartH;

  chartEl.innerHTML = '';
  const wrapper = document.createElement('div');
  wrapper.className = 'spare-chart-wrapper';

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${svgW} ${svgH}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.classList.add('spare-svg');

  /* Horizontal grid lines at 25%, 50%, 75% of capacity */
  for (const frac of [0.25, 0.5, 0.75]) {
    const gy = yScale(headcount * frac);
    const gl = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    gl.setAttribute('x1', 0); gl.setAttribute('y1', gy);
    gl.setAttribute('x2', svgW); gl.setAttribute('y2', gy);
    gl.setAttribute('stroke', 'rgba(110,118,129,0.12)');
    gl.setAttribute('stroke-width', '0.5');
    svg.appendChild(gl);
  }

  /* Capacity ceiling line */
  const capY = yScale(headcount);
  const capLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  capLine.setAttribute('x1', 0); capLine.setAttribute('y1', capY);
  capLine.setAttribute('x2', svgW); capLine.setAttribute('y2', capY);
  capLine.setAttribute('stroke', 'rgba(63,185,80,0.5)');
  capLine.setAttribute('stroke-width', '1.5');
  capLine.setAttribute('stroke-dasharray', '6,3');
  svg.appendChild(capLine);

  /* Capacity label */
  const capLabel = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  capLabel.setAttribute('x', svgW - 6);
  capLabel.setAttribute('y', capY - 5);
  capLabel.setAttribute('text-anchor', 'end');
  capLabel.setAttribute('fill', 'rgba(63,185,80,0.65)');
  capLabel.setAttribute('font-size', '9');
  capLabel.textContent = `${headcount} cap`;
  svg.appendChild(capLabel);

  /* Area fill (gradient from allocated color to transparent at baseline) */
  const gradId = 'spare-area-grad';
  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  const grad = document.createElementNS('http://www.w3.org/2000/svg', 'linearGradient');
  grad.setAttribute('id', gradId);
  grad.setAttribute('x1', '0'); grad.setAttribute('y1', '0');
  grad.setAttribute('x2', '0'); grad.setAttribute('y2', '1');
  const stop1 = document.createElementNS('http://www.w3.org/2000/svg', 'stop');
  stop1.setAttribute('offset', '0%'); stop1.setAttribute('stop-color', '#d29922'); stop1.setAttribute('stop-opacity', '0.35');
  const stop2 = document.createElementNS('http://www.w3.org/2000/svg', 'stop');
  stop2.setAttribute('offset', '100%'); stop2.setAttribute('stop-color', '#d29922'); stop2.setAttribute('stop-opacity', '0.03');
  grad.appendChild(stop1); grad.appendChild(stop2);
  defs.appendChild(grad);
  svg.appendChild(defs);

  let areaD = `M 0 ${baselineY}`;
  for (let i = 0; i < months.length; i++) {
    const x = i * colW;
    const y = yScale(months[i].used);
    areaD += ` L ${x} ${y} L ${x + colW} ${y}`;
  }
  areaD += ` L ${months.length * colW} ${baselineY} Z`;
  const areaPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  areaPath.setAttribute('d', areaD);
  areaPath.setAttribute('fill', `url(#${gradId})`);
  svg.appendChild(areaPath);

  /* Allocated step-line */
  let lineD = '';
  for (let i = 0; i < months.length; i++) {
    const x = i * colW;
    const y = yScale(months[i].used);
    lineD += (i === 0 ? `M ${x} ${y}` : ` L ${x} ${y}`) + ` L ${x + colW} ${y}`;
  }
  const allocLine = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  allocLine.setAttribute('d', lineD);
  allocLine.setAttribute('fill', 'none');
  allocLine.setAttribute('stroke', '#d29922');
  allocLine.setAttribute('stroke-width', '2');
  svg.appendChild(allocLine);

  /* Color-coded column overlays + hover interactivity */
  const tooltip = document.createElement('div');
  tooltip.className = 'spare-tooltip';

  const labelInterval = totalMonths > 30 ? 4 : totalMonths > 18 ? 3 : totalMonths > 10 ? 2 : 1;

  for (let i = 0; i < months.length; i++) {
    const m = months[i];
    const x = i * colW;
    const y = yScale(m.used);

    let fillColor;
    if (m.utilPct > 85) fillColor = 'rgba(248,81,73,0.18)';
    else if (m.utilPct > 70) fillColor = 'rgba(210,153,34,0.12)';
    else fillColor = 'rgba(63,185,80,0.06)';

    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', x); rect.setAttribute('y', y);
    rect.setAttribute('width', colW); rect.setAttribute('height', baselineY - y);
    rect.setAttribute('fill', fillColor);
    rect.classList.add('spare-col-rect');
    svg.appendChild(rect);

    /* Full-height invisible hit area */
    const hit = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    hit.setAttribute('x', x); hit.setAttribute('y', padTop);
    hit.setAttribute('width', colW); hit.setAttribute('height', chartH + labelH);
    hit.setAttribute('fill', 'transparent');
    hit.style.cursor = 'pointer';

    const hoverFill = m.utilPct > 85 ? 'rgba(248,81,73,0.35)' : m.utilPct > 70 ? 'rgba(210,153,34,0.28)' : 'rgba(63,185,80,0.2)';

    hit.addEventListener('mouseenter', () => {
      rect.setAttribute('fill', hoverFill);
      tooltip.innerHTML = `<strong>${m.label}</strong><br>${m.used} allocated · ${m.spare} spare<br><span class="spare-tooltip-util" style="color:${m.utilPct > 85 ? '#f85149' : m.utilPct > 70 ? '#d29922' : '#3fb950'}">${m.utilPct}% utilization</span>`;
      tooltip.style.display = 'block';
      const pct = ((x + colW / 2) / svgW) * 100;
      tooltip.style.left = `calc(${pct}%)`;
    });
    hit.addEventListener('mouseleave', () => {
      rect.setAttribute('fill', fillColor);
      tooltip.style.display = 'none';
    });
    svg.appendChild(hit);

    /* X-axis month labels */
    if (i % labelInterval === 0) {
      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      text.setAttribute('x', x + colW / 2);
      text.setAttribute('y', baselineY + 13);
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('fill', 'rgba(200,210,225,0.45)');
      text.setAttribute('font-size', '8.5');
      text.textContent = m.label;
      svg.appendChild(text);
    }

    /* Utilization % inside high-usage columns */
    if (m.utilPct >= 70 && (baselineY - y) > 16) {
      const pctText = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      pctText.setAttribute('x', x + colW / 2);
      pctText.setAttribute('y', y + 13);
      pctText.setAttribute('text-anchor', 'middle');
      pctText.setAttribute('fill', m.utilPct > 85 ? 'rgba(248,81,73,0.85)' : 'rgba(210,153,34,0.75)');
      pctText.setAttribute('font-size', '8.5');
      pctText.setAttribute('font-weight', '600');
      pctText.textContent = `${m.utilPct}%`;
      svg.appendChild(pctText);
    }
  }

  wrapper.appendChild(svg);
  wrapper.appendChild(tooltip);
  chartEl.appendChild(wrapper);

  /* --- Actionable insights list --- */
  const insights = [];

  const highMonths = months.filter(m => m.utilPct > 85);
  if (highMonths.length > 0) {
    const names = highMonths.map(m => m.label).join(', ');
    insights.push(`<li class="spare-insight spare-insight--red"><span class="spare-insight-dot"></span>High utilization (&gt;85%): <strong>${names}</strong> — consider deferring work or adding people</li>`);
  }

  const amberMonths = months.filter(m => m.utilPct > 70 && m.utilPct <= 85);
  if (amberMonths.length > 0) {
    const names = amberMonths.map(m => m.label).join(', ');
    insights.push(`<li class="spare-insight spare-insight--amber"><span class="spare-insight-dot"></span>Moderate utilization (70–85%): <strong>${names}</strong> — limited room for new work</li>`);
  }

  const lowMonths = months.filter(m => m.utilPct < 50 && m.used > 0);
  if (lowMonths.length > 0) {
    const range = lowMonths.length === 1 ? lowMonths[0].label : `${lowMonths[0].label} – ${lowMonths[lowMonths.length - 1].label}`;
    insights.push(`<li class="spare-insight spare-insight--green"><span class="spare-insight-dot"></span>Capacity available: <strong>${range}</strong> — can absorb new projects or accelerate existing ones</li>`);
  }

  const rampIdx = months.findIndex((m, i) => i > 0 && m.used < months[i - 1].used && m.utilPct < 60);
  if (rampIdx > 0) {
    insights.push(`<li class="spare-insight spare-insight--blue"><span class="spare-insight-dot"></span>People free up from <strong>${months[rampIdx].label}</strong> (${months[rampIdx].spare} available) — plan next-phase work here</li>`);
  }

  if (insights.length === 0) {
    insights.push(`<li class="spare-insight">Steady utilization at ~${avgUtil}% across ${totalMonths} months. Total spare: ${totalSpare} person-months.</li>`);
  }

  listEl.innerHTML = insights.join('');
  section.style.display = 'block';
}

/**
 * Render long poles list (projects ending in last 25% of timeline).
 */
function renderLongPoles(longPolesSchedule, timelineEnd) {
  const section = getEl('longPolesSection');
  const listEl = getEl('longPolesList');
  if (!section || !listEl) return;
  if (!longPolesSchedule?.length) {
    section.style.display = 'none';
    return;
  }
  const escapeHtml = (s) => {
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  };
  listEl.innerHTML = longPolesSchedule.map(s => {
    const p = s.project;
    const summary = (p.summary || '').slice(0, 60) + ((p.summary || '').length > 60 ? '…' : '');
    const slNo = p.rowNumber != null ? p.rowNumber : '—';
    return `<li><strong>Sl No ${slNo}</strong> · ${escapeHtml(summary)} · ends ${formatDate(s.endDate)}</li>`;
  }).join('');
  section.style.display = 'block';
}

/**
 * Render past-deadline list.
 */
function renderPastDeadline(schedule, endDate) {
  const section = getEl('pastDeadlineSection');
  const descEl = getEl('pastDeadlineDesc');
  const listEl = getEl('pastDeadlineList');
  if (!section || !descEl || !listEl) return;
  if (!endDate) { section.style.display = 'none'; return; }

  const deadlineMs = endDate.getTime();
  const past = schedule.filter(e => !e.isResourceGroupChild && e.endDate.getTime() > deadlineMs);
  if (past.length === 0) { section.style.display = 'none'; return; }

  const escapeHtml = (s) => {
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  };
  descEl.textContent = `${past.length} project(s) extend past ${formatDate(endDate)}.`;
  listEl.innerHTML = past.map(e => {
    const p = e.project;
    const summary = (p.summary || '').slice(0, 60) + ((p.summary || '').length > 60 ? '…' : '');
    const slNo = p.rowNumber != null ? p.rowNumber : '—';
    return `<li><strong>Sl No ${slNo}</strong> · ${escapeHtml(summary)} · finishes ${formatDate(e.endDate)}</li>`;
  }).join('');
  section.style.display = 'block';
}

/**
 * Compute "needed people" and "extra people" for a past-deadline entry (same logic as gantt tooltip).
 * @returns {{ neededPeople: number, extraPeople: number } | null }
 */
function getPastDeadlineRecommendation(entry, deadlineDate, capacityPct) {
  const project = entry.project;
  const completedPct = Number(project.completedPct) || 0;
  const totalPM = project.totalPersonMonthsNum;
  const remainFrac = (100 - completedPct) / 100;
  const remainPM = totalPM > 0 ? totalPM * remainFrac : 0;
  const availMonths = deadlineDate && entry.startDate
    ? Math.max(1, Math.round((deadlineDate.getTime() - entry.startDate.getTime()) / MONTH_MS))
    : 0;
  const pctFactor = (capacityPct || 100) / 100;
  if (remainPM <= 0 || availMonths <= 0 || pctFactor <= 0) return null;
  const neededPeople = Math.ceil(remainPM / (availMonths * pctFactor));
  const currentPeople = Math.ceil(entry.fte ?? totalResources(project));
  const extraPeople = neededPeople - currentPeople;
  return { neededPeople, extraPeople };
}

/**
 * Render recommendations: fit release (add people to x, y, z) or move release out.
 */
function renderRecommendations(schedule, endDate, capacityPct, numFTEs, longPoles, timelineEnd) {
  const section = getEl('recommendationsSection');
  const contentEl = getEl('recommendationsContent');
  if (!section || !contentEl) return;

  const escapeHtml = (s) => {
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  };

  const deadlineMs = endDate ? endDate.getTime() : 0;
  const pastDeadline = schedule.filter(e => !e.isResourceGroupChild && e.endDate.getTime() > deadlineMs);

  const parts = [];

  if (pastDeadline.length > 0) {
    const addPeople = [];
    let latestEnd = endDate;
    for (const entry of pastDeadline) {
      const rec = getPastDeadlineRecommendation(entry, endDate, capacityPct);
      const p = entry.project;
      const summary = (p.summary || '').slice(0, 50) + ((p.summary || '').length > 50 ? '…' : '');
      const slNo = p.rowNumber != null ? p.rowNumber : '—';
      if (rec && rec.extraPeople > 0) {
        addPeople.push({ slNo, summary: escapeHtml(summary), extra: rec.extraPeople, needed: rec.neededPeople });
      }
      if (entry.endDate.getTime() > latestEnd.getTime()) latestEnd = entry.endDate;
    }

    if (addPeople.length > 0) {
      parts.push(
        '<div class="rec-block">',
        '<strong>Fit release into timeline</strong>',
        ' Add more people so work finishes by ' + escapeHtml(formatDate(endDate)) + ':',
        '<ul>' + addPeople.map(a => `<li><strong>Sl No ${a.slNo}</strong> (${a.summary}): add +${a.extra} people → ${a.needed} total</li>`).join('') + '</ul>',
        '</div>'
      );
    }
    parts.push(
      '<div class="rec-block">',
      '<strong>Or move release out</strong>',
      ' Set target date to ' + escapeHtml(formatDate(latestEnd)) + ' so the current plan finishes by then.',
      '</div>'
    );
  } else if (longPoles.length > 0) {
    parts.push(
      '<div class="rec-block">',
      '<strong>Long poles drive the timeline</strong>',
      ' Schedule fits within target date. To shorten the schedule, add people to the long-pole projects above; spare capacity in earlier months could be shifted to them.',
      '</div>'
    );
  } else {
    section.style.display = 'none';
    return;
  }

  contentEl.innerHTML = parts.join('');
  section.style.display = 'block';
}

/**
 * Main render: filter, pack, render Gantt and insight sections.
 */
function render() {
  const state = getScheduleState();
  setFilters({ priority: state.priority });

  let filtered = filterByPriority(projects, state.priority);
  detectResourceGroups(filtered);
  tagPriorityTiers(filtered);

  const ganttSection = getEl('ganttSection');
  const submitHint = getEl('submitHint');
  const scheduleSummary = getEl('scheduleSummary');
  const ganttTitle = getEl('ganttTitle');
  const capacityLegend = getEl('capacityLegend');

  if (ganttSection) ganttSection.style.display = 'block';
  if (submitHint) submitHint.style.display = 'none';

  const farEnd = new Date(state.startDate);
  farEnd.setFullYear(farEnd.getFullYear() + 5);
  const schedule = packWithCapacity(filtered, state.startDate, farEnd, state.numFTEs, state.capacityPct);
  const timelineEnd = getScheduleEnd(schedule);
  const timeline = { startDate: state.startDate, endDate: timelineEnd || state.startDate };

  const deadlineMs = state.endDate.getTime();
  for (const entry of schedule) {
    entry.pastDeadline = !entry.isResourceGroupChild && entry.endDate.getTime() > deadlineMs;
  }

  const visibleRange = { startDate: state.startDate, endDate: state.endDate };

  if (scheduleSummary) {
    const rangeText = timelineEnd
      ? `Timeline: ${formatDate(state.startDate)} → ${formatDate(timelineEnd)} · Viewport: ${formatDate(state.startDate)} → ${formatDate(state.endDate)}`
      : 'No projects in range.';
    const extendedNote = timelineEnd && timelineEnd.getTime() > state.endDate.getTime()
      ? ' (bar chart extends to actual finish — dependencies and capacity serialize work)'
      : '';
    const countText = state.priority && projects.length > 0
      ? ` Showing ${filtered.length} of ${projects.length} projects.`
      : '';
    scheduleSummary.textContent = rangeText + extendedNote + countText;
    scheduleSummary.style.display = 'block';
  }
  if (ganttTitle) ganttTitle.textContent = 'Schedule';
  if (capacityLegend) capacityLegend.textContent = `${state.numFTEs} headcount × ${state.capacityPct}% capacity each`;

  const dependentsByProject = getDependentsByProject(filtered);
  const childToParent = new Map();
  filtered.forEach(p => {
    if (p.isResourceGroupChild && p.resourceGroupParentRow != null) childToParent.set(p.rowNumber, p.resourceGroupParentRow);
  });
  const { schedule: displaySchedule, tierBreaks } = orderScheduleByBlockersFirst(schedule, dependentsByProject);

  const ax = getEl('ganttAxis');
  const chart = getEl('ganttChart');
  if (ax) renderTimelineAxis(ax, timeline, { visibleRange });
  if (chart) renderGantt(chart, displaySchedule, timeline, {
    dependentsByProject,
    childToParent,
    capacity: state.numFTEs,
    capacityPct: state.capacityPct,
    visibleRange,
    deadlineDate: state.endDate,
    labelsContainer: getEl('ganttLabels'),
    tierBreaks,
  });

  const effectiveEnd = timelineEnd && timelineEnd.getTime() > state.endDate.getTime() ? timelineEnd : state.endDate;
  renderSpareCapacity(schedule, state.startDate, effectiveEnd, state.capacity, state.numFTEs, state.capacityPct, visibleRange);
  const longPoles = getLongPoles(schedule, effectiveEnd, 0.25);
  renderLongPoles(longPoles, effectiveEnd);
  renderPastDeadline(schedule, state.endDate);
  renderRecommendations(schedule, state.endDate, state.capacityPct, state.numFTEs, longPoles, timelineEnd);

  lastScheduleCtx = {
    schedule,
    projects: filtered,
    startDate: state.startDate,
    endDate: state.endDate,
    numFTEs: state.numFTEs,
    capacityPct: state.capacityPct,
    capacity: state.capacity,
  };

  const statusEl = getEl('status');
  if (statusEl) { statusEl.textContent = ''; statusEl.className = ''; }
  logger.info('schedule.render: done', filtered.length, 'projects', schedule.length, 'schedule entries');
}

/**
 * Load projects: prefer state/localStorage (user's upload) so navigating away and back keeps data; fall back to data/projects.json when empty.
 * @returns {Promise<void>}
 */
async function loadProjects() {
  const statusEl = getEl('status');
  try {
    projects = getScheduleData();
    if (projects.length > 0) {
      logger.debug('schedule.loadProjects: from schedule data', projects.length);
      if (statusEl) { statusEl.textContent = ''; statusEl.className = ''; }
      render();
      return;
    }
    /* Legacy: upgrade from old UPLOAD_STORAGE_KEY */
    const raw = getProjects();
    if (raw.length > 0) {
      const { projects: scheduled } = prepareScheduleData(raw);
      if (scheduled.length > 0) {
        projects = scheduled;
        setScheduleData(scheduled);
        if (statusEl) { statusEl.textContent = ''; statusEl.className = ''; }
        render();
        return;
      }
    }
    /* Fallback: pre-built committed-schedule.json */
    for (const path of ['data/committed-schedule.json', 'data/projects.json']) {
      try {
        const res = await fetch(path);
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data) && data.length > 0) {
            const { projects: scheduled } = path.includes('committed') ? { projects: data } : prepareScheduleData(data);
            if (scheduled.length > 0) {
              projects = scheduled;
              setScheduleData(projects);
              if (statusEl) { statusEl.textContent = ''; statusEl.className = ''; }
              render();
              return;
            }
          }
        }
      } catch (_) {}
    }
  } catch (e) {
    logger.warn('schedule.loadProjects: failed', e);
  }
  if (statusEl) {
    statusEl.textContent = 'No project data. Upload a CSV, XLSX, or JSON on the Refresh data tab.';
    statusEl.className = 'error';
  }
}

/**
 * Bind form controls: debounced input for FTE/dates to avoid hang, immediate change for selects, Submit for full update.
 */
function bindControls() {
  function scheduleUpdate() {
    try {
      render();
      const ganttSection = getEl('ganttSection');
      if (ganttSection) {
        ganttSection.scrollTop = 0;
        const wrapper = getEl('ganttChart')?.closest('.gantt-wrapper');
        if (wrapper) wrapper.scrollLeft = 0;
      }
    } catch (err) {
      logger.error('schedule.update', err);
      const statusEl = getEl('status');
      if (statusEl) { statusEl.textContent = `Error: ${err.message}`; statusEl.className = 'error'; }
    }
  }

  let debounceTimer = null;
  const DEBOUNCE_MS = 350;
  function debouncedUpdate() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      scheduleUpdate();
    }, DEBOUNCE_MS);
  }

  ['numFTEs', 'capacityPerFte', 'startDate', 'endDate'].forEach(id => {
    const el = getEl(id);
    if (el) {
      el.addEventListener('input', debouncedUpdate);
      el.addEventListener('change', scheduleUpdate);
    }
  });

  const priorityEl = getEl('priority');
  if (priorityEl) priorityEl.addEventListener('change', scheduleUpdate);

  const exportBtn = getEl('exportBtn');
  if (exportBtn) {
    exportBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      if (!lastScheduleCtx) {
        scheduleUpdate();
      }
      if (!lastScheduleCtx) return;
      exportBtn.disabled = true;
      exportBtn.textContent = 'Generating…';
      try {
        await generateExecReport(lastScheduleCtx);
      } catch (err) {
        logger.error('exec-report', err);
        const statusEl = getEl('status');
        if (statusEl) { statusEl.textContent = `Export error: ${err.message}`; statusEl.className = 'error'; }
      } finally {
        exportBtn.disabled = false;
        exportBtn.textContent = 'Export Exec Report';
      }
    });
  }
}

/**
 * Apply last-used filters from state to form (optional).
 */
function applyStoredFilters() {
  const f = getFilters();
  const priorityEl = getEl('priority');
  if (priorityEl && f.priority) priorityEl.value = f.priority;
}

// --- Init ---
function init() {
  bindControls();
  applyStoredFilters();
  loadProjects();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
