/**
 * Two modes: (1) Fixed FTEs, fluid timeline (2) Fixed timeline, fluid FTEs.
 * Single Gantt; Commitment and Priority filters apply to both.
 */

import { packWithCapacity, getScheduleEnd, findMinCapacityToFit, orderByDependencyAndSize, getLongPoles, packWithCapacityAndDeadline } from './bin-packing.js';
import { renderGantt, renderTimelineAxis } from './gantt.js';
import { csvToProjects, detectResourceGroups } from './csv-parser.js';

const DEFAULT_START = '2026-04-01';
const DEFAULT_END = '2027-01-30';
const DEFAULT_NUM_FTES = 100;
const DEFAULT_CAPACITY_PCT = 60;
const UPLOAD_STORAGE_KEY = 'ndb-projects-upload';

let projects = [];
let pendingUploadProjects = null;

function parseDate(str) {
  const [y, m, d] = str.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function formatDate(d) {
  if (!d) return '—';
  return d.toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' });
}

function getState() {
  const mode = document.querySelector('input[name="mode"]:checked')?.value || 'fixedFTE';
  const commitment = (document.getElementById('commitment')?.value || '').trim();
  const priority = (document.getElementById('priority')?.value || '').trim();
  const reservedFTE = 0;

  if (mode === 'fixedFTE') {
    const numFTEsRaw = document.getElementById('numFTEs')?.value?.trim();
    const numFTEs = Math.max(1, Math.min(500, parseInt(numFTEsRaw, 10) || DEFAULT_NUM_FTES));
    const capacityPctRaw = (document.getElementById('capacityPerFte')?.value ?? '').trim();
    const capacityPct = Math.max(0.1, Math.min(100, parseFloat(capacityPctRaw) || DEFAULT_CAPACITY_PCT));
    const capacity = (numFTEs * capacityPct) / 100;
    const startStr = document.getElementById('startDate1')?.value ?? DEFAULT_START;
    const effectiveCapacity = Math.max(0, capacity - reservedFTE);
    return {
      mode: 'fixedFTE',
      startDate: parseDate(startStr),
      endDate: null,
      capacity: effectiveCapacity,
      totalCapacity: capacity,
      numFTEs,
      capacityPct,
      reservedFTE,
      commitment,
      priority,
    };
  } else {
    const numFTEsRaw = document.getElementById('numFTEs')?.value?.trim();
    const numFTEs = Math.max(1, Math.min(500, parseInt(numFTEsRaw, 10) || DEFAULT_NUM_FTES));
    const capacityPctRaw = (document.getElementById('capacityPerFte')?.value ?? '').trim();
    const capacityPct = Math.max(0.1, Math.min(100, parseFloat(capacityPctRaw) || DEFAULT_CAPACITY_PCT));
    const capacity = (numFTEs * capacityPct) / 100;
    const startStr = document.getElementById('startDate2')?.value ?? DEFAULT_START;
    const endStr = document.getElementById('endDate2')?.value ?? DEFAULT_END;
    return {
      mode: 'fixedTimeline',
      startDate: parseDate(startStr),
      endDate: parseDate(endStr),
      capacity,
      numFTEs,
      capacityPct,
      reservedFTE,
      commitment,
      priority,
    };
  }
}

function getRankCounts(projectList) {
  const list = projectList || [];
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
      if (blockers.has(depRow)) {
        devBlockerDependentsCount.set(depRow, (devBlockerDependentsCount.get(depRow) || 0) + 1);
      } else {
        plainDependentsCount.set(depRow, (plainDependentsCount.get(depRow) || 0) + 1);
      }
    }
  }
  return { devBlockerDependentsCount, plainDependentsCount };
}

function renderUploadTable(projectList) {
  const container = document.getElementById('uploadTableContainer');
  if (!container) return;
  const ordered = orderByDependencyAndSize(projectList || []);
  const { devBlockerDependentsCount, plainDependentsCount } = getRankCounts(projectList || []);
  container.innerHTML = '';
  const table = document.createElement('table');
  table.className = 'verify-table';
  table.setAttribute('role', 'table');
  const devBlockerSet = (p) => new Set(p.dependencyDevBlockers || []);
  table.innerHTML = `
    <thead>
      <tr>
        <th scope="col">Sl No</th>
        <th scope="col">Rank</th>
        <th scope="col">Status</th>
        <th scope="col">Summary</th>
        <th scope="col">Priority</th>
        <th scope="col">3.0 Commitment Status</th>
        <th scope="col">Total Months Needed for 1 person by Dev (Everything from start to finish)</th>
        <th scope="col">Dev Resources required for max parallization</th>
        <th scope="col">Num of QA required(rule: 3:1, 1 QA for 3 dev)</th>
        <th scope="col">Number of Months (Dev)</th>
        <th scope="col">sizing (refer sheet 2 for guidance)</th>
        <th scope="col">Additional Resources</th>
        <th scope="col">Sizing Comment</th>
        <th scope="col">Dependency Numbers (Comma Separated List)</th>
      </tr>
    </thead>
    <tbody></tbody>
  `;
  const tbody = table.querySelector('tbody');
  ordered.forEach((p) => {
    const summaryVal = (p.summary || '').trim() || '—';
    const slNo = p.rowNumber != null ? p.rowNumber : '—';
    const totalPersonMonthsVal = (p.totalPersonMonths !== undefined && p.totalPersonMonths !== '') ? String(p.totalPersonMonths).trim() : '—';
    const internalDeps = (p.dependencyRowNumbers || []).filter(r => r !== p.rowNumber);
    const blockers = devBlockerSet(p);
    const depParts = internalDeps.map(r => blockers.has(r) ? `${r} (Dev-blocker)` : `${r}`);
    const depText = depParts.length === 0 ? '—' : depParts.join(', ');
    const blockCount = devBlockerDependentsCount.get(p.rowNumber) ?? 0;
    const plainCount = plainDependentsCount.get(p.rowNumber) ?? 0;
    const isInProgress = !!p.inProgress;
    const isChild = !!p.isResourceGroupChild;
    const isParent = !!(p.resourceGroupChildRows?.length);
    const rankText = isInProgress ? '0 (In Progress)' : blockCount > 0 ? `1 (${blockCount})` : plainCount > 0 ? `2 (${plainCount})` : '3';
    const groupNote = isChild ? ` [↳ group of ${p.resourceGroupParentRow}]` : isParent ? ` [📦 group: ${p.resourceGroupChildRows.length} sub]` : '';
    const statusText = (p.status || '').trim() || '—';
    const tr = document.createElement('tr');
    if (isInProgress) tr.style.background = 'rgba(210, 153, 34, 0.10)';
    if (isChild) tr.style.background = 'rgba(130, 160, 200, 0.08)';
    tr.innerHTML = `
      <td>${escapeHtml(String(slNo))}</td>
      <td>${escapeHtml(rankText + groupNote)}</td>
      <td>${escapeHtml(statusText)}</td>
      <td>${escapeHtml(summaryVal)}</td>
      <td>${escapeHtml((p.priority || 'P0').trim() || '—')}</td>
      <td>${escapeHtml((p.commitment || '').trim() || '—')}</td>
      <td>${escapeHtml(totalPersonMonthsVal)}</td>
      <td>${formatNum(p.totalResources)}</td>
      <td>${formatNum(p.qaResources)}</td>
      <td>${formatNum(p.durationMonths)}</td>
      <td>${escapeHtml((p.sizingLabel || '').trim() || '—')}</td>
      <td>${escapeHtml((p.additionalResources || '').trim() || '—')}</td>
      <td>${escapeHtml((p.sizingComment || '').trim() || '—')}</td>
      <td>${escapeHtml(depText)}</td>
    `;
    tbody.appendChild(tr);
  });
  container.appendChild(table);
}

function formatNum(n) {
  if (n == null || Number.isNaN(n)) return '—';
  return Number(n) % 1 === 0 ? String(n) : Number(n).toFixed(2);
}

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

function norm(s) {
  return (s || '').trim().toLowerCase();
}

function filterByCommitment(projects, commitment) {
  if (!commitment) return projects;
  const c = norm(commitment);
  return projects.filter(p => norm(p.commitment) === c);
}

function filterByPriority(projects, priority) {
  if (!priority) return projects;
  const pr = norm(priority);
  return projects.filter(p => norm(p.priority || 'P0') === pr);
}

/** Map rowNumber -> { devBlockerFor: number[], plainDepFor: number[] } for tooltips. */
function getDependentsByProject(projectList) {
  const map = new Map();
  const list = projectList || [];
  for (const p of list) {
    const r = p.rowNumber;
    if (r == null) continue;
    map.set(r, { devBlockerFor: [], plainDepFor: [] });
  }
  for (const p of list) {
    const r = p.rowNumber;
    if (r == null) continue;
    const blockers = new Set(p.dependencyDevBlockers || []);
    const deps = p.dependencyRowNumbers || [];
    for (const depRow of deps) {
      if (depRow === r || !map.has(depRow)) continue;
      const entry = map.get(depRow);
      const slNo = (p.rowNumber != null ? p.rowNumber : null);
      if (slNo == null) continue;
      if (blockers.has(depRow)) {
        if (!entry.devBlockerFor.includes(slNo)) entry.devBlockerFor.push(slNo);
      } else {
        if (!entry.plainDepFor.includes(slNo)) entry.plainDepFor.push(slNo);
      }
    }
  }
  return map;
}

function renderLongPoles(longPolesSchedule, timelineEnd) {
  const section = document.getElementById('longPolesSection');
  const listEl = document.getElementById('longPolesList');
  if (!section || !listEl) return;
  if (!longPolesSchedule?.length) {
    section.style.display = 'none';
    return;
  }
  listEl.innerHTML = longPolesSchedule.map(s => {
    const p = s.project;
    const summary = (p.summary || '').slice(0, 60) + ((p.summary || '').length > 60 ? '…' : '');
    const slNo = p.rowNumber != null ? p.rowNumber : '—';
    return `<li><strong>Sl No ${slNo}</strong> · ${escapeHtml(summary)} · ends ${formatDate(s.endDate)}</li>`;
  }).join('');
  section.style.display = 'block';
}

function renderConsiderDropping(dropped, endDate, capacityLimit) {
  const section = document.getElementById('considerDroppingSection');
  const descEl = document.getElementById('considerDroppingDesc');
  const listEl = document.getElementById('considerDroppingList');
  if (!section || !descEl || !listEl) return;
  if (!dropped?.length) {
    section.style.display = 'none';
    return;
  }
  descEl.textContent = `With a capacity limit of ${capacityLimit} people, ${dropped.length} project(s) cannot fit by ${formatDate(endDate)}. Consider dropping or delaying these to meet the date.`;
  listEl.innerHTML = dropped.map(p => {
    const summary = (p.summary || '').slice(0, 60) + ((p.summary || '').length > 60 ? '…' : '');
    const slNo = p.rowNumber != null ? p.rowNumber : '—';
    return `<li><strong>Sl No ${slNo}</strong> · ${escapeHtml(summary)}</li>`;
  }).join('');
  section.style.display = 'block';
}

/**
 * Compute and render spare capacity over the timeline.
 * Shows a month-by-month bar chart of used vs spare FTEs plus a summary list
 * highlighting months with significant slack.
 */
function renderSpareCapacity(schedule, startDate, endDate, capacity, numFTEs, capacityPct) {
  const section = document.getElementById('spareCapacitySection');
  const descEl = document.getElementById('spareCapacityDesc');
  const chartEl = document.getElementById('spareCapacityChart');
  const listEl = document.getElementById('spareCapacityList');
  if (!section || !descEl || !chartEl || !listEl) return;

  if (!schedule?.length || capacity <= 0) {
    section.style.display = 'none';
    return;
  }

  const tsStart = new Date(startDate);
  tsStart.setDate(1);
  function monthIndex(d) {
    return (d.getFullYear() - tsStart.getFullYear()) * 12 + (d.getMonth() - tsStart.getMonth());
  }
  function dateFromMonth(idx) {
    return new Date(tsStart.getFullYear(), tsStart.getMonth() + idx, 1);
  }

  const endMo = endDate ? monthIndex(endDate) : 0;
  const totalMonths = Math.max(endMo, 1);

  /* Build per-month usage (skip resource-group children) */
  const usage = new Map();
  for (const entry of schedule) {
    if (entry.isResourceGroupChild) continue;
    const fte = entry.fte ?? 0;
    const sMo = monthIndex(entry.startDate);
    const eMo = monthIndex(entry.endDate);
    for (let m = sMo; m < eMo; m++) {
      usage.set(m, (usage.get(m) ?? 0) + fte);
    }
  }

  /* Build spare array */
  const months = [];
  let totalSpare = 0;
  let peakUsed = 0;
  for (let m = 0; m < totalMonths; m++) {
    const used = usage.get(m) ?? 0;
    const spare = Math.max(0, capacity - used);
    peakUsed = Math.max(peakUsed, used);
    totalSpare += spare;
    const d = dateFromMonth(m);
    months.push({ month: m, date: d, used, spare, label: d.toLocaleString('default', { month: 'short', year: '2-digit' }) });
  }

  const avgSpare = totalMonths > 0 ? (totalSpare / totalMonths) : 0;
  const capExplain = (numFTEs && capacityPct && capacityPct < 100)
    ? `Effective capacity: ${capacity.toFixed(0)} (${numFTEs} FTEs × ${capacityPct}%)`
    : `Effective capacity: ${capacity.toFixed(0)} FTEs`;
  descEl.textContent = `${capExplain} · Peak allocated: ${peakUsed.toFixed(0)} people · Avg spare: ${avgSpare.toFixed(1)} people/month · Total spare: ${totalSpare.toFixed(0)} person-months over ${totalMonths} months`;

  const capLabel = (numFTEs && capacityPct && capacityPct < 100)
    ? `${numFTEs} FTEs × ${capacityPct}% = ${capacity.toFixed(0)} effective`
    : `${capacity.toFixed(0)} FTEs`;

  /* Mini bar chart */
  chartEl.innerHTML = '';
  const maxVal = capacity;
  for (const m of months) {
    const col = document.createElement('div');
    col.className = 'spare-col';
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

    col.title = `${m.label}: ${m.used.toFixed(0)} allocated, ${m.spare.toFixed(0)} available (${capLabel})`;
    col.appendChild(spareBar);
    col.appendChild(usedBar);
    col.appendChild(lbl);
    chartEl.appendChild(col);
  }

  /* List notable months with high spare capacity (> 20% of total) */
  const threshold = capacity * 0.2;
  const notable = months.filter(m => m.spare >= threshold);
  if (notable.length > 0) {
    listEl.innerHTML = notable.map(m => {
      return `<li><strong>${m.label}</strong>: ${m.used.toFixed(0)} of ${capLabel} allocated — <strong>${m.spare.toFixed(0)} people available</strong></li>`;
    }).join('');
  } else {
    listEl.innerHTML = '<li>No months with significant spare capacity (>20% unused).</li>';
  }
  section.style.display = 'block';
}

function render() {
  const state = getState();
  let filtered = filterByCommitment(projects, state.commitment);
  filtered = filterByPriority(filtered, state.priority);

  const ganttSection = document.getElementById('ganttSection');
  const submitHint = document.getElementById('submitHint');
  const mode1Controls = document.getElementById('mode1Controls');
  const mode2Controls = document.getElementById('mode2Controls');
  const mode1Summary = document.getElementById('mode1Summary');
  const mode2Summary = document.getElementById('mode2Summary');
  const ganttTitle = document.getElementById('ganttTitle');
  const capacityLegend = document.getElementById('capacityLegend');

  if (ganttSection) ganttSection.style.display = 'block';
  if (submitHint) submitHint.style.display = 'none';

  if (state.mode === 'fixedFTE') {
    if (mode1Controls) mode1Controls.style.display = '';
    if (mode2Controls) mode2Controls.style.display = 'none';
    if (mode1Summary) mode1Summary.style.display = 'block';
    if (mode2Summary) mode2Summary.style.display = 'none';

    const farEnd = new Date(state.startDate);
    farEnd.setFullYear(farEnd.getFullYear() + 5);
    const schedule = packWithCapacity(filtered, state.startDate, farEnd, state.capacity);
    const timelineEnd = getScheduleEnd(schedule);
    const timeline = { startDate: state.startDate, endDate: timelineEnd || state.startDate };

    if (mode1Summary) {
      const rangeText = timelineEnd
        ? `Timeline: ${formatDate(state.startDate)} → ${formatDate(timelineEnd)} (fluid)`
        : 'No projects in range.';
      const countText = (state.commitment || state.priority) && projects.length > 0
        ? ` Showing ${filtered.length} of ${projects.length} projects.`
        : '';
      mode1Summary.textContent = rangeText + countText;
    }
    if (ganttTitle) ganttTitle.textContent = '1. Fixed FTEs, fluid timeline';
    if (capacityLegend) {
      capacityLegend.textContent = `Capacity = ${state.capacity.toFixed(0)} people (${state.numFTEs} × ${state.capacityPct}%)`;
    }

    const dependentsByProject = getDependentsByProject(filtered);
    const ax = document.getElementById('ganttAxis');
    const chart = document.getElementById('ganttChart');
    if (ax) renderTimelineAxis(ax, timeline);
    if (chart) renderGantt(chart, schedule, timeline, { dependentsByProject, capacity: state.numFTEs });

    renderSpareCapacity(schedule, state.startDate, timelineEnd || state.startDate, state.capacity, state.numFTEs, state.capacityPct);
    const longPoles = getLongPoles(schedule, timelineEnd || state.startDate, 0.25);
    renderLongPoles(longPoles, timelineEnd || state.startDate);
    renderConsiderDropping([], null, null);
  } else {
    if (mode1Controls) mode1Controls.style.display = 'none';
    if (mode2Controls) mode2Controls.style.display = '';
    if (mode1Summary) mode1Summary.style.display = 'none';
    if (mode2Summary) mode2Summary.style.display = 'block';

    let timelineEnd = state.endDate;
    let dropped = [];

    const result = packWithCapacityAndDeadline(filtered, state.startDate, state.endDate, state.capacity);
    const schedule = result.schedule;
    dropped = result.dropped || [];
    if (mode2Summary) {
      const countNote = (state.commitment || state.priority) && projects.length > 0 ? ` (${filtered.length} of ${projects.length} projects)` : '';
      const capNote = `${state.numFTEs} FTEs × ${state.capacityPct}% = ${state.capacity.toFixed(0)} effective`;
      if (dropped.length === 0) {
        mode2Summary.textContent = `All ${filtered.length} projects fit by ${formatDate(state.endDate)} (${capNote}).${countNote}`;
      } else {
        mode2Summary.textContent = `${schedule.length} projects fit, ${dropped.length} cannot fit by ${formatDate(state.endDate)} (${capNote}). See "Consider dropping" below.${countNote}`;
      }
    }

    const timeline = { startDate: state.startDate, endDate: state.endDate };
    if (ganttTitle) ganttTitle.textContent = '2. Fixed timeline, fluid FTEs';
    if (capacityLegend) {
      capacityLegend.textContent = `Capacity = ${state.capacity.toFixed(0)} people (${state.numFTEs} × ${state.capacityPct}%)`;
    }

    const dependentsByProject = getDependentsByProject(filtered);
    const ax = document.getElementById('ganttAxis');
    const chart = document.getElementById('ganttChart');
    if (ax) renderTimelineAxis(ax, timeline);
    if (chart) renderGantt(chart, schedule, timeline, { dependentsByProject, capacity: state.numFTEs });

    const longPoles = getLongPoles(schedule, timelineEnd, 0.25);
    renderSpareCapacity(schedule, state.startDate, timelineEnd, state.capacity, state.numFTEs, state.capacityPct);
    renderLongPoles(longPoles, timelineEnd);
    if (dropped.length > 0) {
      renderConsiderDropping(dropped, state.endDate, state.capacity);
    } else {
      renderConsiderDropping([], null, null);
    }
  }
}

function toggleModeControls() {
  const mode = document.querySelector('input[name="mode"]:checked')?.value || 'fixedFTE';
  const mode1Controls = document.getElementById('mode1Controls');
  const mode2Controls = document.getElementById('mode2Controls');
  if (mode1Controls) mode1Controls.style.display = mode === 'fixedFTE' ? '' : 'none';
  if (mode2Controls) mode2Controls.style.display = mode === 'fixedTimeline' ? '' : 'none';
}

function bindControls() {
  document.querySelectorAll('input[name="mode"]').forEach(radio => {
    radio.addEventListener('change', () => {
      toggleModeControls();
      render();
    });
  });

  function scheduleUpdate() {
    try {
      render();
      const ganttSection = document.getElementById('ganttSection');
      if (ganttSection) {
        ganttSection.scrollTop = 0;
        const wrapper = document.getElementById('ganttChart')?.closest('.gantt-wrapper');
        if (wrapper) wrapper.scrollLeft = 0;
      }
    } catch (err) {
      console.warn('Schedule update:', err);
    }
  }

  let scheduleUpdateDebounce = null;
  function scheduleUpdateDebounced() {
    if (scheduleUpdateDebounce) clearTimeout(scheduleUpdateDebounce);
    scheduleUpdateDebounce = setTimeout(() => {
      scheduleUpdateDebounce = null;
      scheduleUpdate();
    }, 300);
  }

  const scheduleInputs = ['numFTEs', 'capacityPerFte', 'startDate1', 'startDate2', 'endDate2'];
  scheduleInputs.forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('input', scheduleUpdateDebounced);
      el.addEventListener('change', scheduleUpdate);
    }
  });
  const commitmentEl = document.getElementById('commitment');
  const priorityEl = document.getElementById('priority');
  if (commitmentEl) commitmentEl.addEventListener('change', scheduleUpdate);
  if (priorityEl) priorityEl.addEventListener('change', scheduleUpdate);

  const submitBtn = document.getElementById('submitBtn');
  if (submitBtn) {
      submitBtn.addEventListener('click', (e) => {
      e.preventDefault();
      try {
        render();
        const ganttSection = document.getElementById('ganttSection');
        if (ganttSection) {
          ganttSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
          ganttSection.scrollTop = 0;
        }
        const chart = document.getElementById('ganttChart');
        const wrapper = chart?.closest('.gantt-wrapper') || chart?.parentElement;
        if (wrapper) {
          wrapper.scrollLeft = 0;
        }
      } catch (err) {
        console.error('Submit error:', err);
        const statusEl = document.getElementById('status');
        if (statusEl) {
          statusEl.textContent = `Error: ${err.message}`;
          statusEl.className = 'error';
        }
      }
    });
  }

  const ganttPanel = document.getElementById('ganttPanel');
  const uploadPanel = document.getElementById('uploadPanel');
  if (ganttPanel) ganttPanel.style.display = 'none';
  if (uploadPanel) uploadPanel.style.display = '';
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      document.querySelectorAll('.tab').forEach(b => { b.classList.remove('active'); b.setAttribute('aria-selected', 'false'); });
      btn.classList.add('active');
      btn.setAttribute('aria-selected', 'true');
      if (ganttPanel) {
        ganttPanel.hidden = tab !== 'gantt';
        ganttPanel.style.display = tab === 'gantt' ? '' : 'none';
      }
      if (uploadPanel) {
        uploadPanel.hidden = tab !== 'upload';
        uploadPanel.style.display = tab === 'upload' ? '' : 'none';
      }
    });
  });

  // Upload CSV: accept file → show Submit → on Submit show verification table
  const fileInput = document.getElementById('csvFileInput');
  const uploadStatus = document.getElementById('uploadStatus');
  const uploadSubmitRow = document.getElementById('uploadSubmitRow');
  const uploadSubmitBtn = document.getElementById('uploadSubmitBtn');
  const uploadTableWrap = document.getElementById('uploadTableWrap');

  if (fileInput && uploadStatus) {
    fileInput.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      uploadStatus.textContent = 'Loading…';
      uploadStatus.className = 'upload-status';
      if (uploadSubmitRow) uploadSubmitRow.style.display = 'none';
      if (uploadTableWrap) uploadTableWrap.style.display = 'none';
      try {
        const text = await file.text();
        const { projects: next, error } = csvToProjects(text);
        if (error) {
          uploadStatus.textContent = error;
          uploadStatus.className = 'upload-status error';
          return;
        }
        pendingUploadProjects = next;
        uploadStatus.textContent = `Accepted ${next.length} projects. Click Submit to review.`;
        uploadStatus.className = 'upload-status success';
        if (uploadSubmitRow) uploadSubmitRow.style.display = 'flex';
      } catch (err) {
        uploadStatus.textContent = `Error: ${err.message}`;
        uploadStatus.className = 'upload-status error';
      }
      fileInput.value = '';
    });
  }

  if (uploadSubmitBtn && uploadTableWrap && uploadStatus) {
    uploadSubmitBtn.addEventListener('click', () => {
      if (!pendingUploadProjects || pendingUploadProjects.length === 0) return;
      projects = pendingUploadProjects;
      try {
        localStorage.setItem(UPLOAD_STORAGE_KEY, JSON.stringify(projects));
      } catch (err) {
        console.warn('Could not persist uploaded data:', err);
      }
      renderUploadTable(projects);
      render();
      uploadTableWrap.style.display = 'block';
      uploadStatus.textContent = `${projects.length} projects loaded. Verify the table below, then go to the Schedule tab when ready.`;
      uploadStatus.className = 'upload-status success';
      uploadTableWrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }
}

async function loadProjects() {
  const statusEl = document.getElementById('status');
  try {
    const stored = localStorage.getItem(UPLOAD_STORAGE_KEY);
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed) && parsed.length > 0) {
          detectResourceGroups(parsed);
          projects = parsed;
          statusEl.textContent = '';
          statusEl.className = '';
          render();
          return;
        }
      } catch (parseErr) {
        console.warn('Stored upload data invalid, falling back to file:', parseErr);
      }
    }
    const res = await fetch('data/projects.json');
    if (!res.ok) throw new Error(res.statusText);
    projects = await res.json();
    detectResourceGroups(projects);
    statusEl.textContent = '';
    statusEl.className = '';
    render();
  } catch (e) {
    statusEl.textContent = `Failed to load data: ${e.message}. Use Refresh CSV tab to upload, or run scripts/prepare-data.js.`;
    statusEl.className = 'error';
  }
}

// Bind tabs and controls immediately so the UI is clickable before data loads
toggleModeControls();
bindControls();
loadProjects();
