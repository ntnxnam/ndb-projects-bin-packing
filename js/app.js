/**
 * Single schedule view: fluid timeline from capacity packing. User's start/end dates
 * define the viewport (and target date for past-deadline flagging). Scroll right for overflow.
 */

import { packWithCapacity, getScheduleEnd, orderByDependencyAndSize, getLongPoles } from './bin-packing.js';
import { renderGantt, renderTimelineAxis } from './gantt.js';
import { renderDependencyGraph } from './dependency-graph.js';
import { csvToProjects, detectResourceGroups } from './csv-parser.js';
import { totalResources, SIZING_MONTHS } from './sizing.js';
import {
  DEFAULT_START,
  DEFAULT_END,
  DEFAULT_NUM_FTES,
  DEFAULT_CAPACITY_PCT,
  UPLOAD_STORAGE_KEY,
  NUM_FTES_MIN,
  NUM_FTES_MAX,
} from './config.js';

const _elCache = {};
function getEl(id) {
  if (_elCache[id] != null) return _elCache[id];
  const el = document.getElementById(id);
  if (el) _elCache[id] = el;
  return el;
}

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
  const commitment = (getEl('commitment')?.value || '').trim();
  const priority = (getEl('priority')?.value || '').trim();
  const numFTEsRaw = getEl('numFTEs')?.value?.trim();
  const numFTEs = Math.max(NUM_FTES_MIN, Math.min(NUM_FTES_MAX, parseInt(numFTEsRaw, 10) || DEFAULT_NUM_FTES));
  const capacityPctRaw = (getEl('capacityPerFte')?.value ?? '').trim();
  const capacityPct = Math.max(0.1, Math.min(100, parseFloat(capacityPctRaw) || DEFAULT_CAPACITY_PCT));
  const capacity = (numFTEs * capacityPct) / 100;
  const startStr = getEl('startDate')?.value ?? DEFAULT_START;
  const endStr = getEl('endDate')?.value ?? DEFAULT_END;
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
  const container = getEl('uploadTableContainer');
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
    const bucketName = p.resourceGroupName || '';
    const groupNote = isChild
      ? (bucketName ? ` [↳ ${bucketName}]` : ` [↳ group of ${p.resourceGroupParentRow}]`)
      : isParent
        ? (bucketName ? ` [📦 ${bucketName}: ${p.resourceGroupChildRows.length} sub]` : ` [📦 group: ${p.resourceGroupChildRows.length} sub]`)
        : '';
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

function monthDiff(startDate, endDate) {
  if (!startDate || !endDate) return null;
  const s = startDate.getTime ? startDate : new Date(startDate);
  const e = endDate.getTime ? endDate : new Date(endDate);
  return Math.max(0, (e.getFullYear() - s.getFullYear()) * 12 + (e.getMonth() - s.getMonth()));
}

/**
 * Bottom-up scrutinizer: juxtapose CSV (what you said) with schedule (what logic says) and challenge mismatches.
 */
function renderBottomUpTable(projectList, schedule) {
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

  container.innerHTML = '';
  const table = document.createElement('table');
  table.className = 'verify-table bottom-up-table';
  table.setAttribute('role', 'table');
  table.innerHTML = `
    <thead>
      <tr>
        <th scope="col">Sl No</th>
        <th scope="col">Summary</th>
        <th scope="col">Total Months (1p)</th>
        <th scope="col">Dev (people)</th>
        <th scope="col">CSV implied (effort÷people)</th>
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
      ? Math.ceil(totalPersonMonthsNum / devR)
      : null;
    const monthsFromSizing = (p.sizingLabel && SIZING_MONTHS[p.sizingLabel] != null) ? SIZING_MONTHS[p.sizingLabel] : null;
    const minPeopleFromSizing = (totalPersonMonthsNum != null && totalPersonMonthsNum > 0 && monthsFromSizing != null && monthsFromSizing > 0)
      ? Math.ceil(totalPersonMonthsNum / monthsFromSizing)
      : null;

    const depRows = (p.dependencyRowNumbers || []).filter(r => r !== p.rowNumber);
    const blockers = new Set(p.dependencyDevBlockers || []);
    const blockedBy = depRows.length === 0 ? '—' : depRows.map(r => blockers.has(r) ? `${r} (dev-blocker)` : String(r)).join(', ');

    const entry = scheduleByRow.get(p.rowNumber);
    const scheduledStart = entry ? formatDate(entry.startDate) : '—';
    const scheduledEnd = entry ? formatDate(entry.endDate) : '—';
    const scheduledDuration = entry ? monthDiff(entry.startDate, entry.endDate) : null;

    const challenges = [];
    if (scheduledDuration != null && realisticDuration != null && scheduledDuration > realisticDuration) {
      challenges.push(`You said ${realisticDuration} mo (effort÷people). Schedule gives ${scheduledDuration} mo — delayed by deps or capacity. Plan for ${scheduledDuration}.`);
    }
    if (realisticDuration != null && monthsFromSizing != null && monthsFromSizing > 0 && realisticDuration > monthsFromSizing) {
      challenges.push(`Effort implies ${realisticDuration} mo; sizing says up to ${monthsFromSizing} mo. Scope grew or sizing wrong.`);
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

/**
 * Tag each project with _tier for priority-aware scheduling.
 * Tier 1 = P0 or Committed → front-loaded with all available capacity.
 * Tier 2 = everything else → fills remaining capacity after Tier 1.
 * Resource-group children inherit their parent's tier.
 */
function tagPriorityTiers(projectList) {
  const parentTierByRow = new Map();
  for (const p of projectList) {
    if (p.isResourceGroupChild) continue;
    const isP0 = norm(p.priority || 'P0') === 'p0';
    const isCommitted = norm(p.commitment).includes('committed');
    p._tier = (isP0 || isCommitted) ? 1 : 2;
    parentTierByRow.set(p.rowNumber, p._tier);
  }
  for (const p of projectList) {
    if (!p.isResourceGroupChild) continue;
    p._tier = parentTierByRow.get(p.resourceGroupParentRow) ?? 2;
  }
}

/**
 * Reorder schedule for display so dev-blockers (projects others wait on) appear on top.
 * Keeps resource-group parent+children together as blocks.
 */
function orderScheduleByBlockersFirst(schedule, dependentsByProject) {
  if (!schedule?.length) return schedule;
  const blocks = [];
  for (let i = 0; i < schedule.length; i++) {
    const entry = schedule[i];
    if (entry.isResourceGroupChild) {
      blocks[blocks.length - 1].entries.push(entry);
    } else {
      blocks.push({ entries: [entry] });
    }
  }
  const deps = dependentsByProject || new Map();
  blocks.sort((a, b) => {
    const mainA = a.entries[0]?.project;
    const mainB = b.entries[0]?.project;
    const rowA = mainA?.rowNumber;
    const rowB = mainB?.rowNumber;
    const infoA = rowA != null ? deps.get(rowA) : null;
    const infoB = rowB != null ? deps.get(rowB) : null;
    const blockerCountA = infoA?.devBlockerFor?.length ?? 0;
    const blockerCountB = infoB?.devBlockerFor?.length ?? 0;
    if (blockerCountB !== blockerCountA) return blockerCountB - blockerCountA;
    const plainCountA = infoA?.plainDepFor?.length ?? 0;
    const plainCountB = infoB?.plainDepFor?.length ?? 0;
    return plainCountB - plainCountA;
  });
  return blocks.flatMap(b => b.entries);
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
  const section = getEl('longPolesSection');
  const listEl = getEl('longPolesList');
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

function renderPastDeadline(schedule, endDate) {
  const section = getEl('pastDeadlineSection');
  const descEl = getEl('pastDeadlineDesc');
  const listEl = getEl('pastDeadlineList');
  if (!section || !descEl || !listEl) return;
  if (!endDate) { section.style.display = 'none'; return; }

  const deadlineMs = endDate.getTime();
  const past = schedule.filter(e => !e.isResourceGroupChild && e.endDate.getTime() > deadlineMs);
  if (past.length === 0) { section.style.display = 'none'; return; }

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
 * Compute and render spare capacity over the timeline.
 * Shows a month-by-month bar chart of used vs spare FTEs plus a summary list
 * highlighting months with significant slack.
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
  function monthIndex(d) {
    return (d.getFullYear() - tsStart.getFullYear()) * 12 + (d.getMonth() - tsStart.getMonth());
  }
  function dateFromMonth(idx) {
    return new Date(tsStart.getFullYear(), tsStart.getMonth() + idx, 1);
  }

  /* Include the month containing endDate (range is start..end inclusive by month). */
  const endMo = endDate ? monthIndex(endDate) : 0;
  const totalMonths = Math.max(endMo + 1, 1);
  let visibleMonths = totalMonths;
  if (visibleRange) {
    const vs = monthIndex(visibleRange.startDate);
    const ve = monthIndex(visibleRange.endDate);
    visibleMonths = Math.min(totalMonths, Math.max(1, ve - vs + 1));
  }

  /* Build per-month usage in effective FTE (same source as packer/Gantt). */
  const usage = new Map();
  for (const entry of schedule) {
    if (entry.isResourceGroupChild) continue;
    const fte = entry.fte ?? totalResources(entry.project);
    const sMo = monthIndex(entry.startDate);
    const eMo = monthIndex(entry.endDate);
    for (let m = sMo; m < eMo; m++) {
      usage.set(m, (usage.get(m) ?? 0) + fte);
    }
  }

  /* Convert effective FTEs to headcount.
     usage values are in effective FTE units (capacity pool = numFTEs × capacityPct%).
     To get headcount: divide by (capacityPct / 100).  */
  const headcount = numFTEs || Math.round(capacity);
  const pctFactor = (capacityPct && capacityPct < 100) ? (capacityPct / 100) : 1;
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

  const avgSpare = totalMonths > 0 ? (totalSpare / totalMonths) : 0;
  descEl.textContent = `${headcount} headcount (${capacityPct}% capacity each) · Peak allocated: ${peakUsed} · Avg available: ${Math.round(avgSpare)}/month · Total spare: ${totalSpare} person-months over ${totalMonths} months`;

  /* Mini bar chart — scale against headcount. Use inner wrapper so viewport matches user start/end. */
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

  /* List notable months with high spare capacity (> 20% of headcount) */
  const threshold = headcount * 0.2;
  const notable = months.filter(m => m.spare >= threshold);
  if (notable.length > 0) {
    listEl.innerHTML = notable.map(m => {
      return `<li><strong>${m.label}</strong>: ${m.used} allocated, <strong>${m.spare} available</strong> (of ${headcount})</li>`;
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
  tagPriorityTiers(filtered);

  const ganttSection = getEl('ganttSection');
  const submitHint = getEl('submitHint');
  const scheduleSummary = getEl('scheduleSummary');
  const ganttTitle = getEl('ganttTitle');
  const capacityLegend = getEl('capacityLegend');

  if (ganttSection) ganttSection.style.display = 'block';
  if (submitHint) submitHint.style.display = 'none';

  /* Schedule over a long horizon so bars show actual end dates; user end date is viewport + deadline only */
  const farEnd = new Date(state.startDate);
  farEnd.setFullYear(farEnd.getFullYear() + 5);
  const schedule = packWithCapacity(filtered, state.startDate, farEnd, state.capacity, state.capacityPct);
  const timelineEnd = getScheduleEnd(schedule);
  const timeline = { startDate: state.startDate, endDate: timelineEnd || state.startDate };

  /* Mark entries that extend past user's target end date */
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
  if (capacityLegend) {
    capacityLegend.textContent = `${state.numFTEs} headcount × ${state.capacityPct}% capacity each`;
  }

  const dependentsByProject = getDependentsByProject(filtered);
  const childToParent = new Map();
  filtered.forEach(p => {
    if (p.isResourceGroupChild && p.resourceGroupParentRow != null) {
      childToParent.set(p.rowNumber, p.resourceGroupParentRow);
    }
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

  const depGraphEl = getEl('dependencyGraph');
  if (depGraphEl) renderDependencyGraph(depGraphEl, orderByDependencyAndSize(filtered), {
    childToParent,
  });
}

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

  const scheduleInputs = ['numFTEs', 'capacityPerFte', 'startDate', 'endDate'];
  scheduleInputs.forEach(id => {
    const el = getEl(id);
    if (el) {
      el.addEventListener('input', scheduleUpdateDebounced);
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
        render();
        const ganttSection = getEl('ganttSection');
        if (ganttSection) {
          ganttSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
          ganttSection.scrollTop = 0;
        }
        const chart = getEl('ganttChart');
        const wrapper = chart?.closest('.gantt-wrapper') || chart?.parentElement;
        if (wrapper) {
          wrapper.scrollLeft = 0;
        }
      } catch (err) {
        console.error('Submit error:', err);
        const statusEl = getEl('status');
        if (statusEl) {
          statusEl.textContent = `Error: ${err.message}`;
          statusEl.className = 'error';
        }
      }
    });
  }

  const ganttPanel = getEl('ganttPanel');
  const uploadPanel = getEl('uploadPanel');
  const dependenciesPanel = getEl('dependenciesPanel');
  const bottomUpPanel = getEl('bottomUpPanel');
  if (ganttPanel) ganttPanel.style.display = 'none';
  if (uploadPanel) uploadPanel.style.display = '';
  if (dependenciesPanel) dependenciesPanel.style.display = 'none';
  if (bottomUpPanel) bottomUpPanel.style.display = 'none';
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
        if (tab === 'upload') {
          showExportRow();
          showUploadSubmitRow();
        }
      }
      if (dependenciesPanel) {
        dependenciesPanel.hidden = tab !== 'dependencies';
        dependenciesPanel.style.display = tab === 'dependencies' ? '' : 'none';
        if (tab === 'dependencies') {
          let listToUse = projects && projects.length > 0 ? projects : null;
          if (!listToUse || listToUse.length === 0) {
            try {
              const stored = localStorage.getItem(UPLOAD_STORAGE_KEY);
              if (stored) {
                const parsed = JSON.parse(stored);
                if (Array.isArray(parsed) && parsed.length > 0) {
                  detectResourceGroups(parsed);
                  listToUse = parsed;
                }
              }
            } catch (_) {}
          }
          const state = getState();
          let filtered = listToUse ? filterByCommitment(listToUse, state.commitment) : [];
          filtered = filterByPriority(filtered, state.priority);
          const childToParent = new Map();
          filtered.forEach(p => {
            if (p.isResourceGroupChild && p.resourceGroupParentRow != null) {
              childToParent.set(p.rowNumber, p.resourceGroupParentRow);
            }
          });
          const depGraphEl = getEl('dependencyGraph');
          if (depGraphEl) renderDependencyGraph(depGraphEl, orderByDependencyAndSize(filtered), {
            childToParent,
          });
          setTimeout(showErrorLog, 100);
        }
      }
      if (bottomUpPanel) {
        bottomUpPanel.hidden = tab !== 'bottomup';
        bottomUpPanel.style.display = tab === 'bottomup' ? '' : 'none';
        if (tab === 'bottomup') {
          const state = getState();
          const buCommit = getEl('bottomUpCommitment');
          const buPriority = getEl('bottomUpPriority');
          if (buCommit && buCommit.value !== state.commitment) buCommit.value = state.commitment || '';
          if (buPriority && buPriority.value !== state.priority) buPriority.value = state.priority || '';
          runBottomUpRender();
        }
      }
    });
  });

  function getBottomUpFilterState() {
    const commitment = (getEl('bottomUpCommitment')?.value || '').trim();
    const priority = (getEl('bottomUpPriority')?.value || '').trim();
    return { commitment, priority };
  }

  function runBottomUpRender() {
    let listToUse = projects && projects.length > 0 ? projects : null;
    if (!listToUse || listToUse.length === 0) {
      try {
        const stored = localStorage.getItem(UPLOAD_STORAGE_KEY);
        if (stored) {
          const parsed = JSON.parse(stored);
          if (Array.isArray(parsed) && parsed.length > 0) {
            detectResourceGroups(parsed);
            listToUse = parsed;
          }
        }
      } catch (_) {}
    }
    const { commitment, priority } = getBottomUpFilterState();
    let filtered = listToUse ? filterByCommitment(listToUse, commitment) : [];
    filtered = filterByPriority(filtered, priority);

    const state = getState();
    tagPriorityTiers(filtered);
    const farEnd = new Date(state.startDate);
    farEnd.setFullYear(farEnd.getFullYear() + 5);
    const schedule = packWithCapacity(filtered, state.startDate, farEnd, state.capacity, state.capacityPct);
    renderBottomUpTable(filtered, schedule);
  }

  const bottomUpCommitment = getEl('bottomUpCommitment');
  const bottomUpPriority = getEl('bottomUpPriority');
  if (bottomUpCommitment) bottomUpCommitment.addEventListener('change', runBottomUpRender);
  if (bottomUpPriority) bottomUpPriority.addEventListener('change', runBottomUpRender);

  // Upload CSV: accept file → show Submit → on Submit show verification table
  const fileInput = getEl('csvFileInput');
  const uploadStatus = getEl('uploadStatus');
  const uploadSubmitRow = getEl('uploadSubmitRow');
  const uploadSubmitBtn = getEl('uploadSubmitBtn');
  const uploadTableWrap = getEl('uploadTableWrap');

  if (uploadPanel) {
    uploadPanel.addEventListener('click', (e) => {
      const isUploadSubmit = e.target.id === 'uploadSubmitBtn' || e.target.closest('#uploadSubmitBtn');
      if (!isUploadSubmit) return;
      e.preventDefault();
      e.stopPropagation();
      if (uploadStatus) {
        uploadStatus.textContent = 'Submitting…';
        uploadStatus.className = 'upload-status';
      }
      runUploadSubmit();
    }, true);
  }
  function runUploadSubmit() {
    const listToShow = (pendingUploadProjects && pendingUploadProjects.length > 0) ? pendingUploadProjects : projects;
    if (!listToShow || listToShow.length === 0) {
      if (uploadStatus) {
        uploadStatus.textContent = 'No project data. Upload a CSV or JSON above, or add data/projects.json and reload.';
        uploadStatus.className = 'upload-status error';
      }
      return;
    }
    if (listToShow === pendingUploadProjects) {
      projects = pendingUploadProjects;
      try {
        localStorage.setItem(UPLOAD_STORAGE_KEY, JSON.stringify(projects));
      } catch (err) {
        console.warn('Could not persist uploaded data:', err);
      }
    }
    showExportRow();
    renderUploadTable(listToShow);
    render();
    if (uploadTableWrap) {
      uploadTableWrap.style.display = 'block';
      uploadTableWrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    if (uploadStatus) {
      uploadStatus.textContent = `${listToShow.length} projects loaded. Verify the table below, then go to the Schedule tab when ready.`;
      uploadStatus.className = 'upload-status success';
    }
  }
  if (uploadSubmitBtn) {
    uploadSubmitBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (uploadStatus) { uploadStatus.textContent = 'Submitting…'; uploadStatus.className = 'upload-status'; }
      runUploadSubmit();
    });
  }
  if (fileInput && uploadStatus) {
    fileInput.addEventListener('click', () => {
      uploadStatus.textContent = 'Select a file…';
      uploadStatus.className = 'upload-status';
    });
    function onFileChosen(e) {
      const file = e.target.files?.[0];
      if (!file) {
        uploadStatus.textContent = 'No file chosen. Select a .csv or .json file above.';
        return;
      }
      uploadStatus.textContent = 'Loading…';
      uploadStatus.className = 'upload-status';
      void handleFile(file);
    }
    fileInput.addEventListener('change', onFileChosen);
    fileInput.addEventListener('input', onFileChosen);
    async function handleFile(file) {
      if (uploadSubmitRow) uploadSubmitRow.style.display = 'none';
      if (uploadTableWrap) uploadTableWrap.style.display = 'none';
      try {
        const text = await file.text();
        if (!text || !text.trim()) {
          uploadStatus.textContent = 'File is empty.';
          uploadStatus.className = 'upload-status error';
          fileInput.value = '';
          return;
        }
        const isJson = file.name.toLowerCase().endsWith('.json');
        let next;
        if (isJson) {
          const parsed = JSON.parse(text);
          if (!Array.isArray(parsed)) throw new Error('JSON must be an array of projects');
          detectResourceGroups(parsed);
          next = parsed;
        } else {
          const out = csvToProjects(text);
          if (out.error) {
            uploadStatus.textContent = out.error;
            uploadStatus.className = 'upload-status error';
            return;
          }
          next = out.projects;
        }
        pendingUploadProjects = next;
        uploadStatus.textContent = `Accepted ${next.length} projects. Click Submit to review.`;
        uploadStatus.className = 'upload-status success';
        if (uploadSubmitRow) uploadSubmitRow.style.display = 'flex';
        fileInput.blur();
        if (uploadSubmitBtn) {
          requestAnimationFrame(() => {
            uploadSubmitBtn.focus({ preventScroll: true });
          });
        }
      } catch (err) {
        uploadStatus.textContent = `Error: ${err.message}`;
        uploadStatus.className = 'upload-status error';
      }
      fileInput.value = '';
    }
  }

  const exportJsonBtn = getEl('exportJsonBtn');
  if (exportJsonBtn) {
    exportJsonBtn.addEventListener('click', () => {
      if (!projects || projects.length === 0) return;
      const blob = new Blob([JSON.stringify(projects, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'projects.json';
      a.click();
      URL.revokeObjectURL(url);
    });
  }
}

async function loadProjects() {
  const statusEl = getEl('status');
  try {
    // 1) Prefer data/projects.json so saved export is used without re-uploading
    try {
      const res = await fetch('data/projects.json');
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data) && data.length > 0) {
          detectResourceGroups(data);
          projects = data;
          try {
            localStorage.setItem(UPLOAD_STORAGE_KEY, JSON.stringify(projects));
          } catch (_) {}
          statusEl.textContent = '';
          statusEl.className = '';
          showExportRow();
          showUploadSubmitRow();
          render();
          return;
        }
      }
    } catch (_) {
      // fetch failed (e.g. no server, file missing); try localStorage
    }
    // 2) Fall back to last upload in this browser
    const stored = localStorage.getItem(UPLOAD_STORAGE_KEY);
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed) && parsed.length > 0) {
          detectResourceGroups(parsed);
          projects = parsed;
          statusEl.textContent = '';
          statusEl.className = '';
          showExportRow();
          showUploadSubmitRow();
          render();
          return;
        }
      } catch (parseErr) {
        console.warn('Stored upload data invalid:', parseErr);
      }
    }
    statusEl.textContent = 'No project data. Upload a CSV or JSON, or add data/projects.json (e.g. from Export).';
    statusEl.className = 'error';
  } catch (e) {
    statusEl.textContent = `Failed to load data: ${e.message}. Use Refresh CSV tab to upload, or add data/projects.json.`;
    statusEl.className = 'error';
  }
}

function showExportRow() {
  const row = getEl('exportRow');
  if (row) row.style.display = projects.length > 0 ? 'flex' : 'none';
}

function showUploadSubmitRow() {
  const row = getEl('uploadSubmitRow');
  if (row) row.style.display = (projects.length > 0 || (pendingUploadProjects && pendingUploadProjects.length > 0)) ? 'flex' : 'none';
}

// Temporary: show collected console errors on page for debugging
function showErrorLog() {
  const log = typeof window !== 'undefined' && window.__errLog;
  if (!log || log.length === 0) return;
  let el = document.getElementById('debugErrorLog');
  if (!el) {
    el = document.createElement('div');
    el.id = 'debugErrorLog';
    el.style.cssText = 'position:fixed;top:0;left:0;right:0;background:#1a1a1a;color:#f0f0f0;padding:12px 16px;max-height:40vh;overflow:auto;z-index:9999;font:12px monospace;white-space:pre-wrap;border-bottom:2px solid #d29922;';
    document.body.prepend(el);
  }
  el.textContent = log.map((e, i) => `[${i + 1}] ${e.msg}\n  ${(e.url || '') + (e.line != null ? ':' + e.line + ':' + (e.col || '') : '')}\n${e.stack || ''}`).join('\n\n');
}

// Bind when DOM is ready so date/count inputs exist and listeners attach; then load data
function init() {
  // Apply config defaults so form reflects single source of truth
  const numFTEsEl = getEl('numFTEs');
  const capacityPerFteEl = getEl('capacityPerFte');
  const startDateEl = getEl('startDate');
  const endDateEl = getEl('endDate');
  if (numFTEsEl) numFTEsEl.value = String(DEFAULT_NUM_FTES);
  if (capacityPerFteEl) capacityPerFteEl.value = String(DEFAULT_CAPACITY_PCT);
  if (startDateEl) startDateEl.value = DEFAULT_START;
  if (endDateEl) endDateEl.value = DEFAULT_END;

  bindControls();
  loadProjects();
  setTimeout(showErrorLog, 500);
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
