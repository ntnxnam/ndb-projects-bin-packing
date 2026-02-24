/**
 * Bottom-up page: table juxtaposing CSV claims with schedule logic; challenges mismatches.
 * Uses default capacity and timeline for scheduling (same logic as Schedule page).
 * @module bottom-up
 */

import { getEl, escapeHtml, formatDate, formatNum, monthDiff } from './utils.js';
import { logger } from './logger.js';
import {
  DEFAULT_START,
  DEFAULT_NUM_FTES,
  DEFAULT_CAPACITY_PCT,
} from './config.js';
import { getScheduleData, getFilters, setFilters } from './state.js';
import { filterByPriority, tagPriorityTiers } from './filters.js';
import { orderByDependencyAndSize, packWithCapacity, getScheduleEnd } from './bin-packing.js';
import { renderGantt, renderTimelineAxis } from './gantt.js';
import { totalResources, SIZING_MONTHS, effectiveDurationMonths } from './sizing.js';
import { detectResourceGroups } from './resource-groups.js';

/**
 * Load project list (state or localStorage fallback with detectResourceGroups).
 * @returns {Array<object>}
 */
function getProjectList() {
  return getScheduleData();
}

function parseDate(str) {
  const [y, m, d] = str.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/**
 * Render bottom-up table: CSV vs schedule with challenge column.
 * Implied duration uses productivity (capacity %): effort ÷ (people × capacity%).
 * @param {Array<object>} projectList
 * @param {Array<object>} schedule - From packWithCapacity.
 * @param {number} [capacityPct] - Capacity per FTE (0–100). Default from config.
 */
function renderBottomUpTable(projectList, schedule, capacityPct = DEFAULT_CAPACITY_PCT) {
  const container = getEl('bottomUpTableContainer');
  if (!container) return;

  const ordered = orderByDependencyAndSize(projectList || []);
  const scheduleByRow = new Map();
  if (schedule && schedule.length) {
    for (const entry of schedule) {
      const p = entry.project;
      if (p && p.rowNumber != null) scheduleByRow.set(p.rowNumber, entry);
    }
  }

  const capLabel = capacityPct > 0 && capacityPct <= 100 ? ` at ${capacityPct}%` : '';
  container.innerHTML = '';
  const table = document.createElement('table');
  table.className = 'verify-table bottom-up-table';
  table.setAttribute('role', 'table');
  table.innerHTML = `
    <caption class="bottom-up-table-caption">CSV vs schedule: what you said vs what logic says</caption>
    <thead>
      <tr>
        <th scope="col">Sl No</th>
        <th scope="col">Summary</th>
        <th scope="col">Total Months (1p)</th>
        <th scope="col">Dev (people)</th>
        <th scope="col">Implied duration (effort÷people÷productivity)${capLabel}</th>
        <th scope="col">Blocked by</th>
        <th scope="col">Scheduled start</th>
        <th scope="col">Scheduled end</th>
        <th scope="col">Schedule duration</th>
        <th scope="col">Challenge</th>
      </tr>
    </thead>
    <tbody></tbody>
  `;
  const tbody = table.querySelector('tbody');

  for (const p of ordered) {
    const totalPersonMonthsNum = p.totalPersonMonthsNum != null
      ? p.totalPersonMonthsNum
      : (p.totalPersonMonths && String(p.totalPersonMonths).trim()) ? parseFloat(String(p.totalPersonMonths).replace(/,/g, '')) : null;
    const devR = totalResources(p);
    const realisticDuration = (totalPersonMonthsNum != null && totalPersonMonthsNum > 0 && devR > 0)
      ? effectiveDurationMonths(p, capacityPct)
      : null;
    const monthsFromSizing = (p.sizingLabel && SIZING_MONTHS[p.sizingLabel] != null) ? SIZING_MONTHS[p.sizingLabel] : null;
    const minPeopleFromSizing = (totalPersonMonthsNum != null && totalPersonMonthsNum > 0 && monthsFromSizing != null && monthsFromSizing > 0)
      ? Math.ceil(totalPersonMonthsNum / monthsFromSizing)
      : null;

    const depRows = (p.dependencyRowNumbers || []).filter(r => r !== p.rowNumber);
    const devBlockers = new Set(p.dependencyDevBlockers || []);
    const relBlockers = new Set(p.dependencyRelBlockers || []);
    const blockedBy = depRows.length === 0 ? '—' : depRows.map(r => devBlockers.has(r) ? `${r} (dev-blocker)` : relBlockers.has(r) ? `${r} (rel-blocker)` : String(r)).join(', ');

    const entry = scheduleByRow.get(p.rowNumber);
    const scheduledStart = entry ? formatDate(entry.startDate) : '—';
    const scheduledEnd = entry ? formatDate(entry.endDate) : '—';
    const scheduledDuration = entry ? monthDiff(entry.startDate, entry.endDate) : null;

    const challenges = [];
    if (scheduledDuration != null && realisticDuration != null && scheduledDuration > realisticDuration) {
      challenges.push(`Implied ${realisticDuration} mo (effort÷people÷productivity). Schedule gives ${scheduledDuration} mo — delayed by deps or capacity. Plan for ${scheduledDuration}.`);
    }
    if (realisticDuration != null && monthsFromSizing != null && monthsFromSizing > 0 && realisticDuration > monthsFromSizing) {
      challenges.push(`Implied duration ${realisticDuration} mo; sizing says up to ${monthsFromSizing} mo. Scope grew or sizing wrong.`);
    }
    if (scheduledDuration != null && monthsFromSizing != null && monthsFromSizing > 0 && scheduledDuration > monthsFromSizing) {
      challenges.push(`Schedule runs ${scheduledDuration} mo; sizing says up to ${monthsFromSizing} mo. Sizing too optimistic.`);
    }
    if (minPeopleFromSizing != null && devR > 0 && devR < minPeopleFromSizing) {
      challenges.push(`To hit sizing (${monthsFromSizing} mo) need ≥${minPeopleFromSizing} people; you have ${devR}. Understaffed?`);
    }
    const challengeText = challenges.length > 0 ? challenges.join(' ') : '—';
    const challengeClass = challenges.length > 0 ? 'bottom-up-challenge' : '';

    const tr = document.createElement('tr');
    if (challenges.length > 0) tr.classList.add('bottom-up-row-warn');
    if (p.isResourceGroupChild) tr.style.background = 'rgba(130, 160, 200, 0.08)';
    tr.innerHTML = `
      <td>${escapeHtml(String(p.rowNumber ?? '—'))}</td>
      <td>${escapeHtml((p.summary || '').slice(0, 70) + ((p.summary || '').length > 70 ? '…' : ''))}</td>
      <td>${formatNum(totalPersonMonthsNum)}</td>
      <td>${formatNum(devR)}</td>
      <td>${realisticDuration != null ? realisticDuration + ' mo' : '—'}</td>
      <td>${escapeHtml(blockedBy)}</td>
      <td>${escapeHtml(scheduledStart)}</td>
      <td>${escapeHtml(scheduledEnd)}</td>
      <td>${scheduledDuration != null ? scheduledDuration + ' mo' : '—'}</td>
      <td class="${challengeClass}" title="${escapeHtml(challengeText)}">${escapeHtml(challenges.length > 0 ? challenges[0] + (challenges.length > 1 ? ' …' : '') : '—')}</td>
    `;
    tbody.appendChild(tr);
  }
  container.appendChild(table);
  logger.debug('bottom-up.renderBottomUpTable: rendered', ordered.length, 'rows');
}

/**
 * Order schedule entries to match the Bottom Up table (dependency + size order).
 * Used only for the Bottom Up Gantt so it does not use Schedule page's "blockers first" order.
 * @param {Array<object>} schedule - From packWithCapacity.
 * @param {Array<object>} orderedProjects - orderByDependencyAndSize(filtered).
 * @returns {Array<object>} Schedule entries in table order.
 */
function orderScheduleLikeBottomUpTable(schedule, orderedProjects) {
  if (!schedule?.length || !orderedProjects?.length) return schedule || [];
  const rowOrder = orderedProjects.map(p => p.rowNumber);
  return [...schedule].sort((a, b) => {
    const ia = rowOrder.indexOf(a.project?.rowNumber);
    const ib = rowOrder.indexOf(b.project?.rowNumber);
    return (ia === -1 ? 9999 : ia) - (ib === -1 ? 9999 : ib);
  });
}

/**
 * Get filter state from page selects.
 * @returns {{ commitment: string, priority: string }}
 */
function getFilterState() {
  const priority = (getEl('bottomUpPriority')?.value || '').trim();
  return { priority };
}

/**
 * Run schedule with default capacity/dates and render bottom-up table.
 */
function runRender() {
  const listToUse = getProjectList();
  const { priority } = getFilterState();
  setFilters({ priority });

  let filtered = filterByPriority(listToUse, priority);
  detectResourceGroups(filtered);
  tagPriorityTiers(filtered);

  const startDate = parseDate(DEFAULT_START);
  const farEnd = new Date(startDate);
  farEnd.setFullYear(farEnd.getFullYear() + 5);

  const schedule = packWithCapacity(filtered, startDate, farEnd, DEFAULT_NUM_FTES, DEFAULT_CAPACITY_PCT);
  renderBottomUpTable(filtered, schedule);

  /* Logic's actual predictions: same schedule as a Gantt */
  const ganttSection = getEl('bottomUpGanttSection');
  const chartEl = getEl('bottomUpGanttChart');
  const axisEl = getEl('bottomUpGanttAxis');
  const labelsEl = getEl('bottomUpGanttLabels');
  if (ganttSection && chartEl && axisEl) {
    if (!schedule || schedule.length === 0) {
      ganttSection.style.display = 'none';
    } else {
      ganttSection.style.display = 'block';
      const timelineEnd = getScheduleEnd(schedule);
      const timeline = { startDate: startDate, endDate: timelineEnd || startDate };
      const dependentsByProject = getDependentsByProject(filtered);
      const childToParent = new Map();
      filtered.forEach(p => {
        if (p.isResourceGroupChild && p.resourceGroupParentRow != null) childToParent.set(p.rowNumber, p.resourceGroupParentRow);
      });
      const { schedule: displaySchedule, tierBreaks } = orderScheduleByBlockersFirst(schedule, dependentsByProject);
      if (axisEl) renderTimelineAxis(axisEl, timeline, {});
      if (chartEl) renderGantt(chartEl, displaySchedule, timeline, {
        dependentsByProject,
        childToParent,
        capacity,
        capacityPct: DEFAULT_CAPACITY_PCT,
        labelsContainer: labelsEl || null,
        tierBreaks,
      });
    }
  }

  logger.info('bottom-up.runRender: done', filtered.length, 'projects');
}

function bindControls() {
  const priorityEl = getEl('bottomUpPriority');
  if (priorityEl) priorityEl.addEventListener('change', runRender);
}

function applyStoredFilters() {
  const f = getFilters();
  const priorityEl = getEl('bottomUpPriority');
  if (priorityEl && f.priority) priorityEl.value = f.priority;
}

function init() {
  bindControls();
  applyStoredFilters();
  runRender();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
