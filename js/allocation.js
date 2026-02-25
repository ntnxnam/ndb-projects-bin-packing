/**
 * People allocation tab: staff upload (or placeholders), allocations, capacity chart, Gantt.
 * Projects from committed schedule only (getScheduleData or data/committed-schedule.json).
 * @module allocation
 */

import { getEl, escapeHtml, formatNum, formatDate } from './utils.js';
import { getScheduleData } from './state.js';
import { DEFAULT_START, DEFAULT_END, DEFAULT_NUM_FTES } from './config.js';
import {
  getStaff,
  setStaff,
  getAllocations,
  setAllocations,
  getHeadcount,
  setHeadcount,
} from './allocation-state.js';
import { parseCsvToRows, rowsToStaff } from './staff-parser.js';
import { parseXlsxToRows } from './xlsx-parser.js';

/** @type {Array<{ rowNumber: number, summary?: string, feat?: string }>} */
let committedProjects = [];
/** Pending staff rows after file selection, before Submit */
let pendingStaffRows = null;

/**
 * Load committed schedule: state first, then fetch data/committed-schedule.json.
 * @returns {Promise<Array<object>>}
 */
async function loadCommittedProjects() {
  const fromState = getScheduleData();
  if (fromState && fromState.length > 0) {
    committedProjects = fromState;
    return committedProjects;
  }
  try {
    const res = await fetch('data/committed-schedule.json');
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) {
        committedProjects = data;
        return committedProjects;
      }
    }
  } catch (_) {}
  committedProjects = [];
  return committedProjects;
}

/**
 * Effective staff list: uploaded staff or placeholders Person 1..N (N = headcount).
 * Placeholders use capacity 80% for display.
 */
function getEffectiveStaff() {
  const staff = getStaff();
  if (staff.length > 0) return staff;
  const n = Math.max(1, Math.min(500, getHeadcount() ?? DEFAULT_NUM_FTES));
  return Array.from({ length: n }, (_, i) => ({
    id: `placeholder-${i + 1}`,
    name: `Person ${i + 1}`,
    capacityPct: 80,
  }));
}

/**
 * Populate person and project dropdowns, set default dates.
 */
function refreshForm() {
  const staff = getEffectiveStaff();
  const personSelect = getEl('allocationPerson');
  const projectSelect = getEl('allocationProject');
  if (!personSelect || !projectSelect) return;

  personSelect.innerHTML = '';
  staff.forEach((s) => {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.name;
    personSelect.appendChild(opt);
  });

  projectSelect.innerHTML = '';
  committedProjects.forEach((p) => {
    const opt = document.createElement('option');
    opt.value = String(p.rowNumber);
    opt.textContent = `${p.rowNumber}. ${(p.summary || p.feat || '').trim() || 'Project'}`;
    projectSelect.appendChild(opt);
  });

  const fromEl = getEl('allocationFrom');
  const toEl = getEl('allocationTo');
  if (fromEl && !fromEl.value) fromEl.value = DEFAULT_START;
  if (toEl && !toEl.value) toEl.value = DEFAULT_END;
}

/**
 * Render staff preview table (from parsed rows).
 * @param {Array<{ id: string, name: string, capacityPct: number }>} list
 */
function renderStaffTable(list) {
  const container = getEl('allocationStaffTableContainer');
  if (!container) return;
  container.innerHTML = '';
  const table = document.createElement('table');
  table.className = 'verify-table';
  table.setAttribute('role', 'table');
  table.innerHTML = `
    <thead><tr><th scope="col">Name</th><th scope="col">Capacity %</th></tr></thead>
    <tbody></tbody>
  `;
  const tbody = table.querySelector('tbody');
  list.forEach((s) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${escapeHtml(s.name)}</td><td>${formatNum(s.capacityPct)}</td>`;
    tbody.appendChild(tr);
  });
  container.appendChild(table);
}

/**
 * Render allocations list and delete handlers.
 */
function renderAllocationsList() {
  const container = getEl('allocationListContainer');
  if (!container) return;
  const allocations = getAllocations();
  const staffById = new Map(getEffectiveStaff().map((s) => [s.id, s]));
  const projectByRow = new Map(committedProjects.map((p) => [p.rowNumber, p]));

  container.innerHTML = '';
  if (allocations.length === 0) {
    container.innerHTML = '<p class="upload-desc">No allocations yet. Add one above.</p>';
    return;
  }
  const table = document.createElement('table');
  table.className = 'verify-table';
  table.setAttribute('role', 'table');
  table.innerHTML = `
    <thead><tr><th scope="col">Person</th><th scope="col">Project</th><th scope="col">From</th><th scope="col">To</th><th scope="col">%</th><th scope="col"></th></tr></thead>
    <tbody></tbody>
  `;
  const tbody = table.querySelector('tbody');
  allocations.forEach((a) => {
    const person = staffById.get(a.staffId);
    const project = projectByRow.get(a.projectRowNumber);
    const tr = document.createElement('tr');
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.textContent = 'Delete';
    delBtn.className = 'btn-export';
    delBtn.style.fontSize = '0.8rem';
    delBtn.addEventListener('click', () => {
      const next = getAllocations().filter((x) => x.id !== a.id);
      setAllocations(next);
      renderAll();
    });
    tr.innerHTML = `
      <td>${escapeHtml(person ? person.name : a.staffId)}</td>
      <td>${escapeHtml(project ? `${project.rowNumber}. ${(project.summary || '').trim()}` : String(a.projectRowNumber))}</td>
      <td>${escapeHtml(a.startDate)}</td>
      <td>${escapeHtml(a.endDate)}</td>
      <td>${formatNum(a.allocationPct ?? 100)}</td>
      <td></td>
    `;
    tr.querySelector('td:last-child').appendChild(delBtn);
    tbody.appendChild(tr);
  });
  container.appendChild(table);
}

/**
 * Compute allocated FTE per month (same date range as timeline).
 */
function getAllocatedPerMonth(startDate, endDate) {
  const staffById = new Map(getEffectiveStaff().map((s) => [s.id, s]));
  const allocations = getAllocations();
  const tsStart = new Date(startDate);
  tsStart.setDate(1);
  const monthIdx = (d) => {
    const y = typeof d === 'string' ? d.slice(0, 7) : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const [yr, mo] = y.split('-').map(Number);
    return (yr - tsStart.getFullYear()) * 12 + (mo - tsStart.getMonth());
  };
  const endMo = monthIdx(endDate);
  const totalMonths = Math.max(endMo + 1, 1);
  const usage = new Map();
  for (const a of allocations) {
    const person = staffById.get(a.staffId);
    const capacityPct = person ? person.capacityPct : 80;
    const pct = (capacityPct / 100) * ((a.allocationPct ?? 100) / 100);
    const sMo = monthIdx(a.startDate);
    const eMo = monthIdx(a.endDate);
    for (let m = sMo; m < eMo; m++) {
      if (m >= 0 && m < totalMonths) usage.set(m, (usage.get(m) ?? 0) + pct);
    }
  }
  return { usage, totalMonths, tsStart };
}

/**
 * Render remaining capacity chart (allocated vs total capacity).
 */
function renderCapacityChart() {
  const section = getEl('allocationCapacitySection');
  const descEl = getEl('allocationCapacityDesc');
  const chartEl = getEl('allocationCapacityChart');
  if (!section || !descEl || !chartEl) return;

  const staff = getEffectiveStaff();
  const totalCapacity = staff.reduce((s, p) => s + p.capacityPct / 100, 0);
  if (totalCapacity <= 0) {
    section.style.display = 'none';
    return;
  }

  const startDate = new Date(DEFAULT_START);
  const endDate = new Date(DEFAULT_END);
  const { usage, totalMonths, tsStart } = getAllocatedPerMonth(DEFAULT_START, DEFAULT_END);
  const dateFromMonth = (idx) => new Date(tsStart.getFullYear(), tsStart.getMonth() + idx, 1);

  const months = [];
  let peakUsed = 0;
  for (let m = 0; m < totalMonths; m++) {
    const used = usage.get(m) ?? 0;
    peakUsed = Math.max(peakUsed, used);
    const d = dateFromMonth(m);
    const utilPct = totalCapacity > 0 ? Math.round((used / totalCapacity) * 100) : 0;
    months.push({
      month: m,
      date: d,
      used,
      spare: Math.max(0, totalCapacity - used),
      utilPct,
      label: d.toLocaleString('default', { month: 'short', year: '2-digit' }),
    });
  }

  const peakMonth = months.length ? months.reduce((best, m) => (m.used > best.used ? m : best), months[0]) : null;
  const avgUtil = months.length ? Math.round(months.reduce((s, m) => s + m.utilPct, 0) / months.length) : 0;
  descEl.textContent = peakMonth
    ? `${formatNum(totalCapacity.toFixed(1))} FTE total (${staff.length} people). Peak allocated: ${formatNum(peakMonth.used.toFixed(1))} in ${peakMonth.label} (${peakMonth.utilPct}%). Avg ${avgUtil}%.`
    : `${formatNum(totalCapacity.toFixed(1))} FTE total. Add allocations to see the chart.`;

  const chartH = 130;
  const labelH = 18;
  const padTop = 12;
  const padRight = 4;
  const svgH = chartH + labelH + padTop;
  const maxVal = Math.max(totalCapacity, peakUsed, 0.1);
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

  for (const frac of [0.25, 0.5, 0.75]) {
    const gy = yScale(totalCapacity * frac);
    const gl = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    gl.setAttribute('x1', 0); gl.setAttribute('y1', gy);
    gl.setAttribute('x2', svgW); gl.setAttribute('y2', gy);
    gl.setAttribute('stroke', 'rgba(110,118,129,0.12)');
    gl.setAttribute('stroke-width', '0.5');
    svg.appendChild(gl);
  }
  const capY = yScale(totalCapacity);
  const capLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  capLine.setAttribute('x1', 0); capLine.setAttribute('y1', capY);
  capLine.setAttribute('x2', svgW); capLine.setAttribute('y2', capY);
  capLine.setAttribute('stroke', 'rgba(63,185,80,0.5)');
  capLine.setAttribute('stroke-width', '1.5');
  capLine.setAttribute('stroke-dasharray', '6,3');
  svg.appendChild(capLine);
  const capLabel = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  capLabel.setAttribute('x', svgW - 6);
  capLabel.setAttribute('y', capY - 5);
  capLabel.setAttribute('text-anchor', 'end');
  capLabel.setAttribute('fill', 'rgba(63,185,80,0.65)');
  capLabel.setAttribute('font-size', '9');
  capLabel.textContent = `${totalCapacity.toFixed(1)} cap`;
  svg.appendChild(capLabel);

  const gradId = 'alloc-area-grad';
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

  wrapper.appendChild(svg);
  chartEl.appendChild(wrapper);
  section.style.display = '';
}

/**
 * Render Gantt: one row per person, bars = allocations.
 */
function renderGantt() {
  const section = getEl('allocationGanttSection');
  const labelsEl = getEl('allocationGanttLabels');
  const axisEl = getEl('allocationGanttAxis');
  const chartEl = getEl('allocationGanttChart');
  if (!section || !labelsEl || !axisEl || !chartEl) return;

  const staff = getEffectiveStaff();
  const allocations = getAllocations();
  const projectByRow = new Map(committedProjects.map((p) => [p.rowNumber, p]));

  const startDate = new Date(DEFAULT_START);
  const endDate = new Date(DEFAULT_END);
  const rangeStart = startDate.getTime();
  const rangeEnd = endDate.getTime();
  const totalMs = Math.max(rangeEnd - rangeStart, 1);

  const allocationsByStaff = new Map();
  for (const a of allocations) {
    if (!allocationsByStaff.has(a.staffId)) allocationsByStaff.set(a.staffId, []);
    allocationsByStaff.get(a.staffId).push(a);
  }

  const rowHeight = 28;
  const rowGap = 4;
  const totalRows = staff.length;
  if (totalRows === 0) {
    section.style.display = 'none';
    return;
  }

  section.style.display = '';
  axisEl.innerHTML = '';
  labelsEl.innerHTML = '';
  chartEl.innerHTML = '';

  const totalMonths = Math.ceil((endDate.getFullYear() - startDate.getFullYear()) * 12 + (endDate.getMonth() - startDate.getMonth()) + 1);
  const maxTicks = Math.min(24, Math.max(8, totalMonths));
  const interval = Math.max(1, Math.floor(totalMonths / maxTicks));
  const axis = document.createElement('div');
  axis.className = 'gantt-axis';
  for (let i = 0; i < totalMonths; i += interval) {
    const d = new Date(startDate.getFullYear(), startDate.getMonth() + i, 1);
    if (d > endDate) break;
    const label = `${d.toLocaleString('default', { month: 'short' })} ${d.getFullYear()}`;
    const posMs = d.getTime() - rangeStart;
    const leftPct = (posMs / totalMs) * 100;
    const tick = document.createElement('div');
    tick.className = 'gantt-axis-tick';
    tick.style.left = `${Math.max(0, Math.min(100, leftPct))}%`;
    tick.textContent = label;
    axis.appendChild(tick);
  }
  axisEl.appendChild(axis);

  const labelsHeader = document.createElement('div');
  labelsHeader.className = 'gantt-labels-header';
  labelsHeader.innerHTML = '<span class="gantt-col-sl">Person</span>';
  labelsEl.appendChild(labelsHeader);
  const labelsRows = document.createElement('div');
  labelsRows.className = 'gantt-labels-rows';

  const track = document.createElement('div');
  track.className = 'gantt-track';
  const grid = document.createElement('div');
  grid.className = 'gantt-grid';

  let topOffset = 0;
  for (let i = 0; i < staff.length; i++) {
    const s = staff[i];
    const rowTop = topOffset;
    topOffset += rowHeight + rowGap;

    const labelRow = document.createElement('div');
    labelRow.className = 'gantt-label-row';
    labelRow.style.top = `${rowTop}px`;
    labelRow.style.height = `${rowHeight + rowGap}px`;
    labelRow.innerHTML = `<span class="gantt-col-sl">${escapeHtml(s.name)}</span>`;
    labelsRows.appendChild(labelRow);

    const personAllocs = allocationsByStaff.get(s.id) || [];
    for (const a of personAllocs) {
      const aStart = new Date(a.startDate).getTime();
      const aEnd = new Date(a.endDate).getTime();
      const leftPct = Math.max(0, ((aStart - rangeStart) / totalMs) * 100);
      const rightPct = Math.min(100, ((aEnd - rangeStart) / totalMs) * 100);
      const widthPct = rightPct - leftPct;
      if (widthPct <= 0) continue;
      const proj = projectByRow.get(a.projectRowNumber);
      const label = proj ? (proj.summary || proj.feat || '').trim() || `#${a.projectRowNumber}` : `#${a.projectRowNumber}`;

      const bar = document.createElement('div');
      bar.className = 'gantt-bar gantt-bar--fresh';
      bar.style.position = 'absolute';
      bar.style.left = `${leftPct}%`;
      bar.style.width = `${widthPct}%`;
      bar.style.top = `${rowTop + 2}px`;
      bar.style.height = `${rowHeight - 4}px`;
      bar.style.minWidth = '4px';
      bar.title = `${label} (${a.startDate} – ${a.endDate})`;
      bar.textContent = widthPct > 8 ? label : '';
      bar.style.fontSize = '10px';
      bar.style.overflow = 'hidden';
      bar.style.textOverflow = 'ellipsis';
      bar.style.whiteSpace = 'nowrap';
      track.appendChild(bar);
    }
  }

  track.style.height = `${topOffset}px`;
  track.style.minHeight = `${Math.max(topOffset, 120)}px`;
  grid.style.height = track.style.height;
  labelsRows.style.height = track.style.height;
  labelsRows.style.minHeight = track.style.minHeight;

  for (let i = 0; i < totalMonths; i += interval) {
    const d = new Date(startDate.getFullYear(), startDate.getMonth() + i, 1);
    if (d > endDate) break;
    const posMs = d.getTime() - rangeStart;
    const leftPct = (posMs / totalMs) * 100;
    const line = document.createElement('div');
    line.className = 'gantt-grid-line';
    line.style.left = `${Math.max(0, Math.min(100, leftPct))}%`;
    grid.appendChild(line);
  }
  chartEl.appendChild(grid);
  chartEl.appendChild(track);
  labelsEl.appendChild(labelsRows);
}

function renderAll() {
  refreshForm();
  renderAllocationsList();
  renderCapacityChart();
  renderGantt();
}

function init() {
  const headcountInput = getEl('allocationHeadcount');
  const saved = getHeadcount();
  if (saved != null && headcountInput) headcountInput.value = String(saved);
  if (headcountInput) {
    headcountInput.addEventListener('change', () => {
      const n = parseInt(headcountInput.value, 10);
      if (!Number.isNaN(n)) setHeadcount(n);
      renderAll();
    });
  }

  getEl('allocationTemplateBtn')?.addEventListener('click', () => {
    const csv = 'Name,Capacity %\nJane Doe,85';
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'staff-template.csv';
    a.click();
    URL.revokeObjectURL(url);
  });

  const fileInput = getEl('allocationStaffFile');
  const statusEl = getEl('allocationStaffStatus');
  const submitRow = getEl('allocationStaffSubmitRow');
  const tableWrap = getEl('allocationStaffTableWrap');
  fileInput?.addEventListener('change', async (e) => {
    const file = e.target?.files?.[0];
    pendingStaffRows = null;
    if (!file) {
      if (statusEl) statusEl.textContent = 'No file chosen.';
      if (submitRow) submitRow.style.display = 'none';
      if (tableWrap) tableWrap.style.display = 'none';
      return;
    }
    const name = (file.name || '').toLowerCase();
    if (name.endsWith('.csv')) {
      const text = await file.text();
      const rows = parseCsvToRows(text);
      const { staff, error } = rowsToStaff(rows);
      if (error) {
        if (statusEl) { statusEl.textContent = error; statusEl.className = 'upload-status error'; }
        return;
      }
      pendingStaffRows = staff;
      if (statusEl) { statusEl.textContent = `Parsed ${staff.length} staff from CSV.`; statusEl.className = 'upload-status success'; }
      renderStaffTable(staff);
      if (submitRow) submitRow.style.display = 'flex';
      if (tableWrap) tableWrap.style.display = '';
    } else if (name.endsWith('.xlsx')) {
      const buf = await file.arrayBuffer();
      const { rows, error: xError } = await parseXlsxToRows(buf);
      if (xError || !rows?.length) {
        if (statusEl) { statusEl.textContent = xError || 'Could not read XLSX.'; statusEl.className = 'upload-status error'; }
        return;
      }
      const { staff, error } = rowsToStaff(rows);
      if (error) {
        if (statusEl) { statusEl.textContent = error; statusEl.className = 'upload-status error'; }
        return;
      }
      pendingStaffRows = staff;
      if (statusEl) { statusEl.textContent = `Parsed ${staff.length} staff from Excel.`; statusEl.className = 'upload-status success'; }
      renderStaffTable(staff);
      if (submitRow) submitRow.style.display = 'flex';
      if (tableWrap) tableWrap.style.display = '';
    } else {
      if (statusEl) { statusEl.textContent = 'Please choose a .csv or .xlsx file.'; statusEl.className = 'upload-status error'; }
    }
  });

  getEl('allocationStaffSubmitBtn')?.addEventListener('click', () => {
    if (!pendingStaffRows || pendingStaffRows.length === 0) return;
    setStaff(pendingStaffRows);
    pendingStaffRows = null;
    if (statusEl) statusEl.textContent = 'Staff saved. You can add allocations below.';
    if (submitRow) submitRow.style.display = 'none';
    if (tableWrap) tableWrap.style.display = 'none';
    renderAll();
  });

  getEl('allocationAddBtn')?.addEventListener('click', () => {
    const personId = getEl('allocationPerson')?.value;
    const projectRow = getEl('allocationProject')?.value;
    const from = getEl('allocationFrom')?.value;
    const to = getEl('allocationTo')?.value;
    const pctRaw = getEl('allocationPct')?.value;
    if (!personId || !projectRow || !from || !to) {
      const status = getEl('allocationStatus');
      if (status) { status.textContent = 'Please fill Person, Project, From, and To.'; status.className = 'error'; }
      return;
    }
    const pct = Math.max(1, Math.min(100, parseInt(pctRaw, 10) || 100));
    if (new Date(to) < new Date(from)) {
      const status = getEl('allocationStatus');
      if (status) { status.textContent = 'To date must be after From date.'; status.className = 'error'; }
      return;
    }
    const allocations = getAllocations();
    const newId = `alloc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const proj = committedProjects.find((p) => String(p.rowNumber) === projectRow);
    allocations.push({
      id: newId,
      staffId: personId,
      projectRowNumber: parseInt(projectRow, 10),
      projectSummary: proj?.summary,
      startDate: from,
      endDate: to,
      allocationPct: pct,
    });
    setAllocations(allocations);
    const status = getEl('allocationStatus');
    if (status) { status.textContent = ''; status.className = ''; }
    renderAll();
  });

  loadCommittedProjects().then(() => {
    refreshForm();
    const staff = getStaff();
    if (staff.length > 0) {
      if (tableWrap) tableWrap.style.display = 'none';
    } else {
      const head = getEl('allocationHeadcount');
      if (head) setHeadcount(parseInt(head.value, 10) || DEFAULT_NUM_FTES);
    }
    renderAll();
  });
}

init();
