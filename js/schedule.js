/**
 * Schedule page: Gantt chart, spare capacity, long poles, past-deadline list.
 * Loads projects from state or data/projects.json; respects filters and capacity.
 * @module schedule
 */

import { getEl, formatDate, norm } from './utils.js';
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
import { getProjects, setProjects, getFilters, setFilters } from './state.js';
import { filterByCommitment, filterByPriority, tagPriorityTiers } from './filters.js';
import { packWithCapacity, getScheduleEnd, getLongPoles } from './bin-packing.js';
import { orderByDependencyAndSize, getDependentsByProject, orderScheduleByBlockersFirst } from './ranking.js';
import { renderGantt, renderTimelineAxis } from './gantt.js';
import { totalResources } from './sizing.js';
import { detectResourceGroups } from './resource-groups.js';

/** Projects list for this page (from state or data/projects.json). */
let projects = [];

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
 * @returns {{ startDate: Date, endDate: Date, capacity: number, numFTEs: number, capacityPct: number, commitment: string, priority: string }}
 */
function getScheduleState() {
  const numFTEsRaw = getEl('numFTEs')?.value?.trim();
  const numFTEs = Math.max(NUM_FTES_MIN, Math.min(NUM_FTES_MAX, parseInt(numFTEsRaw, 10) || DEFAULT_NUM_FTES));
  const capacityPctRaw = (getEl('capacityPerFte')?.value ?? '').trim();
  const capacityPct = Math.max(CAPACITY_PCT_MIN, Math.min(CAPACITY_PCT_MAX, parseFloat(capacityPctRaw) || DEFAULT_CAPACITY_PCT));
  const capacity = (numFTEs * capacityPct) / 100;
  const startStr = getEl('startDate')?.value ?? DEFAULT_START;
  const endStr = getEl('endDate')?.value ?? DEFAULT_END;
  const commitment = (getEl('commitment')?.value || '').trim();
  const priority = (getEl('priority')?.value || '').trim();
  return {
    startDate: parseDate(startStr),
    endDate: parseDate(endStr),
    capacity,
    numFTEs,
    capacityPct,
    commitment,
    priority,
  };
}

/**
 * Render spare capacity section: month-by-month used vs spare and notable months.
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
  const monthIndex = (d) => (d.getFullYear() - tsStart.getFullYear()) * 12 + (d.getMonth() - tsStart.getMonth());
  const dateFromMonth = (idx) => new Date(tsStart.getFullYear(), tsStart.getMonth() + idx, 1);

  const endMo = endDate ? monthIndex(endDate) : 0;
  const totalMonths = Math.max(endMo + 1, 1);
  let visibleMonths = totalMonths;
  if (visibleRange) {
    const ve = monthIndex(visibleRange.endDate);
    const vs = monthIndex(visibleRange.startDate);
    visibleMonths = Math.min(totalMonths, Math.max(1, ve - vs + 1));
  }

  const usage = new Map();
  for (const entry of schedule) {
    if (entry.isResourceGroupChild) continue;
    const fte = entry.fte ?? totalResources(entry.project);
    const sMo = monthIndex(entry.startDate);
    const eMo = monthIndex(entry.endDate);
    for (let m = sMo; m < eMo; m++) usage.set(m, (usage.get(m) ?? 0) + fte);
  }

  const headcount = numFTEs || Math.round(capacity);
  const pctFactor = (capacityPct && capacityPct < 100) ? capacityPct / 100 : 1;
  const months = [];
  let totalSpare = 0;
  let peakUsed = 0;
  for (let m = 0; m < totalMonths; m++) {
    const effectiveUsed = usage.get(m) ?? 0;
    const usedHC = Math.round(effectiveUsed / pctFactor);
    const spareHC = Math.max(0, headcount - usedHC);
    peakUsed = Math.max(peakUsed, usedHC);
    totalSpare += spareHC;
    const d = dateFromMonth(m);
    months.push({ month: m, date: d, used: usedHC, spare: spareHC, label: d.toLocaleString('default', { month: 'short', year: '2-digit' }) });
  }

  const avgSpare = totalMonths > 0 ? totalSpare / totalMonths : 0;
  descEl.textContent = `${headcount} headcount (${capacityPct}% capacity each) · Peak allocated: ${peakUsed} · Avg available: ${Math.round(avgSpare)}/month · Total spare: ${totalSpare} person-months over ${totalMonths} months`;

  chartEl.innerHTML = '';
  const inner = document.createElement('div');
  inner.className = 'spare-capacity-inner';
  const widthPct = visibleRange && totalMonths > visibleMonths ? (totalMonths / visibleMonths) * 100 : 100;
  inner.style.width = `${widthPct}%`;
  const maxVal = headcount;
  for (const m of months) {
    const col = document.createElement('div');
    col.className = 'spare-col';
    col.style.flex = `0 0 ${100 / totalMonths}%`;
    const usedPct = Math.min(100, (m.used / maxVal) * 100);
    const sparePct = Math.min(100 - usedPct, (m.spare / maxVal) * 100);
    const usedBar = document.createElement('div');
    usedBar.className = 'spare-bar spare-bar--used';
    usedBar.style.height = `${usedPct}%`;
    const spareBar = document.createElement('div');
    spareBar.className = 'spare-bar spare-bar--spare';
    spareBar.style.height = `${sparePct}%`;
    const lbl = document.createElement('div');
    lbl.className = 'spare-label';
    lbl.textContent = m.label;
    col.title = `${m.label}: ${m.used} allocated, ${m.spare} available (of ${headcount})`;
    col.appendChild(spareBar);
    col.appendChild(usedBar);
    col.appendChild(lbl);
    inner.appendChild(col);
  }
  chartEl.appendChild(inner);

  const threshold = headcount * 0.2;
  const notable = months.filter(m => m.spare >= threshold);
  if (notable.length > 0) {
    listEl.innerHTML = notable.map(m => `<li><strong>${m.label}</strong>: ${m.used} allocated, <strong>${m.spare} available</strong> (of ${headcount})</li>`).join('');
  } else {
    listEl.innerHTML = '<li>No months with significant spare capacity (>20% unused).</li>';
  }
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
 * Main render: filter, pack, render Gantt and insight sections.
 */
function render() {
  const state = getScheduleState();
  setFilters({ commitment: state.commitment, priority: state.priority });

  let filtered = filterByCommitment(projects, state.commitment);
  filtered = filterByPriority(filtered, state.priority);
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
  const schedule = packWithCapacity(filtered, state.startDate, farEnd, state.capacity, state.capacityPct);
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
    const countText = (state.commitment || state.priority) && projects.length > 0
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
  const displaySchedule = orderScheduleByBlockersFirst(schedule, dependentsByProject);

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
  });

  const effectiveEnd = timelineEnd && timelineEnd.getTime() > state.endDate.getTime() ? timelineEnd : state.endDate;
  const scheduleCommitted = schedule.filter(e => e.project && norm(e.project.commitment) === 'committed');
  renderSpareCapacity(scheduleCommitted, state.startDate, effectiveEnd, state.capacity, state.numFTEs, state.capacityPct, visibleRange);
  const longPoles = getLongPoles(scheduleCommitted, effectiveEnd, 0.25);
  renderLongPoles(longPoles, effectiveEnd);
  renderPastDeadline(scheduleCommitted, state.endDate);

  const statusEl = getEl('status');
  if (statusEl) { statusEl.textContent = ''; statusEl.className = ''; }
  logger.info('schedule.render: done', filtered.length, 'projects', schedule.length, 'schedule entries');
}

/**
 * Load projects: prefer data/projects.json (all projects), then fall back to state/localStorage.
 * @returns {Promise<void>}
 */
async function loadProjects() {
  const statusEl = getEl('status');
  try {
    const res = await fetch('data/projects.json');
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) {
        detectResourceGroups(data);
        projects = data;
        setProjects(data);
        if (statusEl) { statusEl.textContent = ''; statusEl.className = ''; }
        render();
        return;
      }
    }
    projects = getProjects();
    if (projects.length > 0) {
      logger.debug('schedule.loadProjects: from state', projects.length);
      render();
      return;
    }
  } catch (e) {
    logger.warn('schedule.loadProjects: fetch failed', e);
    projects = getProjects();
    if (projects.length > 0) {
      render();
      return;
    }
  }
  if (statusEl) {
    statusEl.textContent = 'No project data. Upload a CSV or JSON on 1. Refresh CSV, or add data/projects.json.';
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

  const commitmentEl = getEl('commitment');
  const priorityEl = getEl('priority');
  if (commitmentEl) commitmentEl.addEventListener('change', scheduleUpdate);
  if (priorityEl) priorityEl.addEventListener('change', scheduleUpdate);

  const submitBtn = getEl('submitBtn');
  if (submitBtn) {
    submitBtn.addEventListener('click', (e) => {
      e.preventDefault();
      try {
        scheduleUpdate();
        const ganttSection = getEl('ganttSection');
        if (ganttSection) {
          ganttSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
          ganttSection.scrollTop = 0;
        }
        const chart = getEl('ganttChart');
        const wrapper = chart?.closest('.gantt-wrapper') || chart?.parentElement;
        if (wrapper) wrapper.scrollLeft = 0;
      } catch (err) {
        logger.error('schedule.submit', err);
        const statusEl = getEl('status');
        if (statusEl) { statusEl.textContent = `Error: ${err.message}`; statusEl.className = 'error'; }
      }
    });
  }
}

/**
 * Apply last-used filters from state to form (optional).
 */
function applyStoredFilters() {
  const f = getFilters();
  const commitmentEl = getEl('commitment');
  const priorityEl = getEl('priority');
  if (commitmentEl && f.commitment) commitmentEl.value = f.commitment;
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
