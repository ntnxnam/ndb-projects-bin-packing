/**
 * Upload page: CSV/JSON file input, submit to persist, verification table, export JSON.
 * @module upload
 */

import { getEl, escapeHtml, formatNum } from './utils.js';
import { logger } from './logger.js';
import { getProjects, setProjects } from './state.js';
import { csvToProjects, detectResourceGroups } from './csv-parser.js';
import { orderByDependencyAndSize, getDependentsCounts, getRankLabel } from './ranking.js';

/** Pending projects after file selection, before Submit. */
let pendingUploadProjects = null;

/**
 * Render the verification table (ordered by dependency and rank).
 * @param {Array<object>} projectList
 */
function renderUploadTable(projectList) {
  const container = getEl('uploadTableContainer');
  if (!container) return;

  const ordered = orderByDependencyAndSize(projectList || []);
  const counts = getDependentsCounts(projectList || []);
  const devBlockerSet = (p) => new Set(p.dependencyDevBlockers || []);

  container.innerHTML = '';
  const table = document.createElement('table');
  table.className = 'verify-table';
  table.setAttribute('role', 'table');
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
    const rankText = getRankLabel(p, counts);
    const statusText = (p.status || '').trim() || '—';
    const tr = document.createElement('tr');
    if (p.inProgress) tr.style.background = 'rgba(210, 153, 34, 0.10)';
    if (p.isResourceGroupChild) tr.style.background = 'rgba(130, 160, 200, 0.08)';
    tr.innerHTML = `
      <td>${escapeHtml(String(slNo))}</td>
      <td>${escapeHtml(rankText)}</td>
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
  logger.debug('upload.renderUploadTable: rendered', ordered.length, 'rows');
}

/**
 * Run submit: persist pending or current projects, render table, show export.
 */
function runUploadSubmit() {
  const uploadStatus = getEl('uploadStatus');
  const uploadTableWrap = getEl('uploadTableWrap');
  const listToShow = (pendingUploadProjects && pendingUploadProjects.length > 0) ? pendingUploadProjects : getProjects();

  if (!listToShow || listToShow.length === 0) {
    if (uploadStatus) {
      uploadStatus.textContent = 'No project data. Upload a CSV or JSON above, or add data/projects.json and reload.';
      uploadStatus.className = 'upload-status error';
    }
    return;
  }

  try {
    if (listToShow === pendingUploadProjects) {
      setProjects(pendingUploadProjects);
      logger.info('upload.submit: persisted', pendingUploadProjects.length, 'projects');
    }

    renderUploadTable(listToShow);
    if (uploadTableWrap) {
      uploadTableWrap.style.display = 'block';
      uploadTableWrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    if (uploadStatus) {
      uploadStatus.textContent = `${listToShow.length} projects loaded. Verify the table below, then go to the Schedule tab when ready.`;
      uploadStatus.className = 'upload-status success';
    }
    showExportRow();
  } catch (err) {
    logger.error('upload.runUploadSubmit', err);
    if (uploadStatus) {
      uploadStatus.textContent = `Error: ${err.message}`;
      uploadStatus.className = 'upload-status error';
    }
  }
}

function showExportRow() {
  const row = getEl('exportRow');
  const projects = getProjects();
  if (row) row.style.display = projects.length > 0 ? 'flex' : 'none';
}

function updateSubmitButtonState() {
  const btn = getEl('uploadSubmitBtn');
  if (!btn) return;
  const hasPending = pendingUploadProjects && pendingUploadProjects.length > 0;
  const hasSaved = getProjects().length > 0;
  const canSubmit = hasPending || hasSaved;
  /* Keep button always clickable; handler shows message if nothing to submit */
  btn.title = canSubmit ? 'Persist and show project table' : 'Select a CSV or JSON file above first';
}

function showUploadSubmitRow() {
  updateSubmitButtonState();
}

/**
 * Handle selected file: parse CSV or JSON, detect resource groups, show Submit row.
 * @param {File} file
 */
async function handleFile(file) {
  const uploadStatus = getEl('uploadStatus');
  const uploadTableWrap = getEl('uploadTableWrap');
  const fileInput = getEl('csvFileInput');

  if (uploadTableWrap) uploadTableWrap.style.display = 'none';

  try {
    const text = await file.text();
    if (!text || !text.trim()) {
      if (uploadStatus) {
        uploadStatus.textContent = 'File is empty.';
        uploadStatus.className = 'upload-status error';
      }
      if (fileInput) fileInput.value = '';
      return;
    }

    const isJson = file.name.toLowerCase().endsWith('.json');
    let next;

    if (isJson) {
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) throw new Error('JSON must be an array of projects');
      detectResourceGroups(parsed);
      next = parsed;
      logger.debug('upload.handleFile: parsed JSON', next.length, 'projects');
    } else {
      const out = csvToProjects(text);
      if (out.error) {
        if (uploadStatus) {
          uploadStatus.textContent = out.error;
          uploadStatus.className = 'upload-status error';
        }
        return;
      }
      next = out.projects;
      logger.debug('upload.handleFile: parsed CSV', next.length, 'projects');
    }

    pendingUploadProjects = next;
    if (uploadStatus) {
      uploadStatus.textContent = `Accepted ${next.length} projects. Click Submit to review.`;
      uploadStatus.className = 'upload-status success';
    }
    updateSubmitButtonState();
    const submitBtnEl = getEl('uploadSubmitBtn');
    if (submitBtnEl) requestAnimationFrame(() => submitBtnEl.focus({ preventScroll: true }));
    if (fileInput) fileInput.blur();
  } catch (err) {
    logger.error('upload.handleFile', err);
    if (uploadStatus) {
      uploadStatus.textContent = `Error: ${err.message}`;
      uploadStatus.className = 'upload-status error';
    }
  }
  if (fileInput) fileInput.value = '';
}

function bindControls() {
  const fileInput = getEl('csvFileInput');
  const uploadStatus = getEl('uploadStatus');
  const uploadSubmitBtn = getEl('uploadSubmitBtn');
  const exportJsonBtn = getEl('exportJsonBtn');

  if (fileInput && uploadStatus) {
    fileInput.addEventListener('click', () => {
      uploadStatus.textContent = 'Select a file…';
      uploadStatus.className = 'upload-status';
    });
    const onFileChosen = (e) => {
      const file = e.target.files?.[0];
      if (!file) {
        uploadStatus.textContent = 'No file chosen. Select a .csv or .json file above.';
        return;
      }
      uploadStatus.textContent = 'Loading…';
      uploadStatus.className = 'upload-status';
      void handleFile(file);
    };
    fileInput.addEventListener('change', onFileChosen);
    fileInput.addEventListener('input', onFileChosen);
  }

  if (uploadSubmitBtn) {
    uploadSubmitBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const hasPending = pendingUploadProjects && pendingUploadProjects.length > 0;
      const hasSaved = getProjects().length > 0;
      if (!hasPending && !hasSaved) {
        if (uploadStatus) {
          uploadStatus.textContent = 'Select a CSV or JSON file above first.';
          uploadStatus.className = 'upload-status error';
        }
        return;
      }
      if (uploadStatus) {
        uploadStatus.textContent = 'Submitting…';
        uploadStatus.className = 'upload-status';
      }
      runUploadSubmit();
    });
  }

  if (exportJsonBtn) {
    exportJsonBtn.addEventListener('click', () => {
      const projects = getProjects();
      if (!projects || projects.length === 0) return;
      const blob = new Blob([JSON.stringify(projects, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'projects.json';
      a.click();
      URL.revokeObjectURL(url);
      logger.debug('upload.export: downloaded projects.json');
    });
  }
}

/**
 * On load: if we have projects in state, show export and optionally table.
 */
function init() {
  bindControls();
  const projects = getProjects();
  if (projects.length > 0) {
    showExportRow();
    showUploadSubmitRow();
    renderUploadTable(projects);
    const wrap = getEl('uploadTableWrap');
    if (wrap) wrap.style.display = 'block';
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
