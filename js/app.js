/**
 * Two modes: (1) Fixed FTEs, fluid timeline (2) Fixed timeline, fluid FTEs.
 * Single Gantt; Commitment and Priority filters apply to both.
 */

import { packWithCapacity, getScheduleEnd, findMinCapacityToFit } from './bin-packing.js';
import { renderGantt, renderTimelineAxis } from './gantt.js';

const DEFAULT_START = '2026-04-01';
const DEFAULT_END = '2027-01-30';
const DEFAULT_NUM_FTES = 100;
const DEFAULT_CAPACITY_PCT = 100;

let projects = [];

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

  if (mode === 'fixedFTE') {
    const numFTEs = Math.max(1, parseInt(document.getElementById('numFTEs')?.value, 10) || DEFAULT_NUM_FTES);
    const capacityPct = Math.max(1, Math.min(100, parseInt(document.getElementById('capacityPerFte')?.value, 10) || DEFAULT_CAPACITY_PCT));
    const capacity = (numFTEs * capacityPct) / 100;
    const startStr = document.getElementById('startDate1')?.value ?? DEFAULT_START;
    return {
      mode: 'fixedFTE',
      startDate: parseDate(startStr),
      endDate: null,
      capacity,
      numFTEs,
      capacityPct,
      commitment,
      priority,
    };
  } else {
    const startStr = document.getElementById('startDate2')?.value ?? DEFAULT_START;
    const endStr = document.getElementById('endDate2')?.value ?? DEFAULT_END;
    return {
      mode: 'fixedTimeline',
      startDate: parseDate(startStr),
      endDate: parseDate(endStr),
      capacity: null,
      commitment,
      priority,
    };
  }
}

function filterByCommitment(projects, commitment) {
  if (!commitment) return projects;
  return projects.filter(p => (p.commitment || '') === commitment);
}

function filterByPriority(projects, priority) {
  if (!priority) return projects;
  return projects.filter(p => (p.priority || 'P0') === priority);
}

function render() {
  const state = getState();
  let filtered = filterByCommitment(projects, state.commitment);
  filtered = filterByPriority(filtered, state.priority);

  const mode1Controls = document.getElementById('mode1Controls');
  const mode2Controls = document.getElementById('mode2Controls');
  const mode1Summary = document.getElementById('mode1Summary');
  const mode2Summary = document.getElementById('mode2Summary');
  const ganttTitle = document.getElementById('ganttTitle');
  const capacityLegend = document.getElementById('capacityLegend');

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
      mode1Summary.textContent = timelineEnd
        ? `Timeline: ${formatDate(state.startDate)} → ${formatDate(timelineEnd)} (fluid)`
        : 'No projects in range.';
    }
    if (ganttTitle) ganttTitle.textContent = '1. Fixed FTEs, fluid timeline';
    if (capacityLegend) capacityLegend.textContent = `Capacity = ${state.capacity.toFixed(0)} people (${state.numFTEs} × ${state.capacityPct}%)`;

    const ax = document.getElementById('ganttAxis');
    const chart = document.getElementById('ganttChart');
    if (ax) renderTimelineAxis(ax, timeline);
    if (chart) renderGantt(chart, schedule, timeline);
  } else {
    if (mode1Controls) mode1Controls.style.display = 'none';
    if (mode2Controls) mode2Controls.style.display = '';
    if (mode1Summary) mode1Summary.style.display = 'none';
    if (mode2Summary) mode2Summary.style.display = 'block';

    const { minCapacity, schedule } = findMinCapacityToFit(filtered, state.startDate, state.endDate);
    const timeline = { startDate: state.startDate, endDate: state.endDate };

    if (mode2Summary) {
      if (minCapacity != null) {
        mode2Summary.textContent = `Required FTEs = ${minCapacity} people (to fit by ${formatDate(state.endDate)})`;
      } else {
        mode2Summary.textContent = `Cannot fit all projects by ${formatDate(state.endDate)}. Try a later end date or fewer projects.`;
      }
    }
    if (ganttTitle) ganttTitle.textContent = '2. Fixed timeline, fluid FTEs';
    if (capacityLegend) capacityLegend.textContent = minCapacity != null ? `Required capacity = ${minCapacity} people` : '—';

    const ax = document.getElementById('ganttAxis');
    const chart = document.getElementById('ganttChart');
    if (ax) renderTimelineAxis(ax, timeline);
    if (chart) renderGantt(chart, schedule || [], timeline);
  }
}

function bindControls() {
  document.querySelectorAll('input[name="mode"]').forEach(radio => {
    radio.addEventListener('change', () => {
      render();
    });
  });

  ['numFTEs', 'capacityPerFte', 'startDate1', 'startDate2', 'endDate2', 'commitment', 'priority'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('change', render);
    if (el.tagName === 'INPUT') el.addEventListener('input', render);
  });
}

async function loadProjects() {
  const statusEl = document.getElementById('status');
  try {
    const res = await fetch('data/projects.json');
    if (!res.ok) throw new Error(res.statusText);
    projects = await res.json();
    statusEl.textContent = '';
    statusEl.className = '';
    bindControls();
    render();
  } catch (e) {
    statusEl.textContent = `Failed to load data: ${e.message}. Run scripts/prepare-data.js and serve this folder.`;
    statusEl.className = 'error';
  }
}

loadProjects();
