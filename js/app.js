/**
 * App entry: load data, wire controls, run bin packing, render both Gantt views.
 * Changing dates or FTE capacity triggers repack and redraw.
 */

import { packSequential, packWithCapacity } from './bin-packing.js';
import { renderGantt, renderTimelineAxis } from './gantt.js';

const DEFAULT_START = '2026-04-01';
const DEFAULT_END = '2027-01-30';
const DEFAULT_CAPACITY = 80;

let projects = [];

function parseDate(str) {
  const [y, m, d] = str.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function getState() {
  const startStr = document.getElementById('startDate').value;
  const endStr = document.getElementById('endDate').value;
  const capacity = Math.max(1, parseInt(document.getElementById('capacity').value, 10) || DEFAULT_CAPACITY);
  return {
    startDate: parseDate(startStr || DEFAULT_START),
    endDate: parseDate(endStr || DEFAULT_END),
    capacity,
  };
}

function render() {
  const state = getState();
  const { startDate, endDate, capacity } = state;
  const timeline = { startDate, endDate };

  document.getElementById('capacityLabel').textContent = capacity;

  const sequentialSchedule = packSequential(projects, startDate);
  const capacitySchedule = packWithCapacity(projects, startDate, endDate, capacity);

  const view = document.querySelector('.views button.active')?.dataset?.view || 'both';

  if (view !== 'capacity') {
    document.getElementById('sequentialSection').style.display = 'block';
    renderTimelineAxis(document.getElementById('sequentialAxis'), timeline);
    renderGantt(document.getElementById('sequentialChart'), sequentialSchedule, timeline);
  } else {
    document.getElementById('sequentialSection').style.display = 'none';
  }

  if (view !== 'sequential') {
    document.getElementById('capacitySection').style.display = 'block';
    renderTimelineAxis(document.getElementById('capacityAxis'), timeline);
    renderGantt(document.getElementById('capacityChart'), capacitySchedule, timeline);
  } else {
    document.getElementById('capacitySection').style.display = 'none';
  }
}

function bindControls() {
  ['startDate', 'endDate', 'capacity'].forEach(id => {
    document.getElementById(id).addEventListener('change', render);
    document.getElementById(id).addEventListener('input', render);
  });

  document.querySelectorAll('.views button').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.views button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      render();
    });
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
