/**
 * Renders a Gantt chart: bar length = duration, bar thickness = people allocated.
 * (1 = no parallelization, >1 = team chose to parallelize within the project.)
 */

import { totalResources } from './sizing.js';

const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

function escapeHtmlLabel(s) {
  if (s == null) return '';
  const div = document.createElement('div');
  div.textContent = String(s);
  return div.innerHTML;
}

const MONTH_ABBR = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];

/**
 * Normalize a date string (YYYY-MM-DD, YYYY-MM, "Jun 2026", etc.) to YYYY-MM-DD
 * for <input type="date">.  Returns '' if unparseable.
 */
function normalizeToDateValue(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  const fullMatch = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (fullMatch) return `${fullMatch[1]}-${String(fullMatch[2]).padStart(2, '0')}-${String(fullMatch[3]).padStart(2, '0')}`;
  const isoMatch = s.match(/^(\d{4})-(\d{1,2})$/);
  if (isoMatch) return `${isoMatch[1]}-${String(isoMatch[2]).padStart(2, '0')}-01`;
  /* D/Mon/YY or D/Mon/YYYY — month as 3-letter abbreviation */
  const MONTH_ABBR = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  const abbrevMatch = s.match(/^(\d{1,2})\/([A-Za-z]{3,})\/(\d{2,4})$/);
  if (abbrevMatch) {
    const day = +abbrevMatch[1];
    const mi = MONTH_ABBR.indexOf(abbrevMatch[2].slice(0, 3).toLowerCase());
    let y = +abbrevMatch[3];
    if (y < 100) y += 2000;
    if (mi >= 0 && day >= 1 && day <= 31)
      return `${y}-${String(mi + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  /* Flexible: M/D/YYYY or D/M/YYYY — auto-detect by checking which part > 12 */
  const slashMatch = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/);
  if (slashMatch) {
    const a = +slashMatch[1], b = +slashMatch[2];
    let y = +slashMatch[3];
    if (y < 100) y += 2000;
    let month, day;
    if (a > 12 && b <= 12)      { day = a; month = b; }
    else if (b > 12 && a <= 12) { month = a; day = b; }
    else                        { month = a; day = b; } /* ambiguous → M/D/YYYY */
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31)
      return `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  const nameMatch = s.match(/^([A-Za-z]+)\s*(\d{4})$/);
  if (nameMatch) {
    const mi = MONTH_ABBR.indexOf(nameMatch[1].slice(0, 3).toLowerCase());
    if (mi >= 0) return `${nameMatch[2]}-${String(mi + 1).padStart(2, '0')}-01`;
  }
  const serial = parseFloat(s);
  if (!Number.isNaN(serial) && serial > 40000) {
    const d = new Date(Math.round((serial - 25569) * 86400000));
    if (!Number.isNaN(d.getTime())) return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  return '';
}

/**
 * @param {HTMLElement} container
 * @param {Array<{ project, startDate, endDate }>} schedule - display order (e.g. capacity-flow order)
 * @param {{ startDate: Date, endDate: Date }} timeline
 * @param {{ minBarHeightPx?: number, maxBarHeightPx?: number, dependentsByProject?: Map, childToParent?: Map, capacity?: number, capacityPct?: number, labelsContainer?: HTMLElement }} options
 *   labelsContainer = element for Column B (group) / Column C (project) labels. If set, header and rows are rendered there.
 */
export function renderGantt(container, schedule, timeline, options = {}) {
  const labelsContainer = options.labelsContainer ?? null;
  const minH = options.minBarHeightPx ?? 12;
  const maxH = options.maxBarHeightPx ?? 56;
  const dependentsByProject = options.dependentsByProject;
  const childToParent = options.childToParent ?? new Map();
  const resolveDep = (depRow) => childToParent.has(depRow) ? childToParent.get(depRow) : depRow;
  const headcount = options.capacity ?? 0;
  const capacityPct = options.capacityPct ?? 100;
  const onStartDateChange = options.onStartDateChange ?? null;
  const onFundFirstChange = options.onFundFirstChange ?? null;
  const onCompletedPctChange = options.onCompletedPctChange ?? null;
  const onFteChange = options.onFteChange ?? null;
  const onDurationChange = options.onDurationChange ?? null;
  const pctFactor = capacityPct > 0 && capacityPct <= 100 ? capacityPct / 100 : 1;
  const rangeStart = timeline.startDate.getTime();
  const rangeEnd = timeline.endDate.getTime();
  const totalMs = Math.max(rangeEnd - rangeStart, 1);

  /* Bar thickness = allocated FTE; non-linear scale + cap so 2 vs 5 FTE are clearly distinct */
  const allocatedFte = (e) => e.isResourceGroupChild ? 0 : (e.fte ?? totalResources(e.project));
  const rawMaxFte = Math.max(1, ...schedule.map(allocatedFte));
  const maxFte = Math.min(rawMaxFte, 24);
  const scaleFte = (fte) => {
    if (maxFte <= 0 || fte <= 0) return minH;
    const t = Math.sqrt(Math.min(1, fte / maxFte));
    return minH + t * (maxH - minH);
  };

  function tooltipWhy(deps) {
    if (!deps || (!deps.devBlockerFor?.length && !deps.relBlockerFor?.length && !deps.plainDepFor?.length)) return '';
    const parts = [];
    if (deps.devBlockerFor?.length) parts.push(`Dev-blocker for: ${deps.devBlockerFor.join(', ')}`);
    if (deps.relBlockerFor?.length) parts.push(`Rel-blocker for: ${deps.relBlockerFor.join(', ')}`);
    if (deps.plainDepFor?.length) parts.push(`Plain dependency for: ${deps.plainDepFor.join(', ')}`);
    return parts.length ? '\n' + parts.join('\n') : '';
  }

  container.innerHTML = '';

  const track = document.createElement('div');
  track.className = 'gantt-track';

  /* Remaining headcount: use the value stashed by the packing algorithm.
     _remainingAtPlacement = capacity − usage at start month (before this
     project was added), so it naturally decreases in packing order. */
  const remainingByEntry = new Map();
  for (const e of schedule) {
    remainingByEntry.set(e, e._remainingAtPlacement ?? null);
  }

  /* Pool order: 1-based within each bucket by rowNumber so numbering is stable regardless of display order. */
  const bucketEntries = new Map();
  for (const e of schedule) {
    const bucketKey = e.isResourceGroupChild && e.project?.resourceGroupParentRow != null
      ? e.project.resourceGroupParentRow
      : (!e.isResourceGroupChild && e.project?.resourceGroupChildRows?.length ? e.project.rowNumber : null);
    if (bucketKey == null) continue;
    if (!bucketEntries.has(bucketKey)) bucketEntries.set(bucketKey, []);
    bucketEntries.get(bucketKey).push(e);
  }
  for (const entries of bucketEntries.values()) {
    entries.sort((a, b) => (a.project?.rowNumber ?? 0) - (b.project?.rowNumber ?? 0));
    entries.forEach((e, i) => { e._poolOrder = i + 1; });
  }

  let topOffset = 0;
  const rowGap = 4;
  const rowData = []; /* { top, height, colSlNo, colB, colC, colPeople, isGroup } for labels panel */
  const barGeometry = new Map(); /* rowNumber → { leftPct, rightPct, topPx, heightPx, depRows, devBlockers } */

  const narrowBarHeight = Math.max(minH * 0.65, 10);
  const tierDividerHeight = 24;

  /* Build a set of schedule indices where tier dividers should appear */
  const tierBreaks = options.tierBreaks || [];
  const tierBreakByIndex = new Map();
  for (const tb of tierBreaks) {
    tierBreakByIndex.set(tb.index, tb.label);
  }

  /* Track peer group bar positions for wrapper rendering after all bars are placed */
  const peerGroupBars = new Map(); /* resourceGroupName → [{ topPx, bottomPx }] */

  let scheduleIdx = 0;
  for (const entry of schedule) {
    const { project, startDate, endDate, rotated, rotatedFteCount, inProgress } = entry;
    /* Tier divider: insert a section header row before the first entry of each tier */
    const tierLabel = tierBreakByIndex.get(scheduleIdx);
    if (tierLabel && !entry.isResourceGroupChild) {
      const divider = document.createElement('div');
      divider.className = 'gantt-tier-divider';
      divider.style.top = `${topOffset}px`;
      divider.style.height = `${tierDividerHeight}px`;
      const dividerLabel = document.createElement('span');
      dividerLabel.className = 'gantt-tier-divider-label';
      dividerLabel.textContent = tierLabel;
      divider.appendChild(dividerLabel);
      track.appendChild(divider);
      rowData.push({ top: topOffset, height: tierDividerHeight, colSlNo: '', colB: '', colC: tierLabel, colPeople: '', isGroup: false, isTierDivider: true });
      topOffset += tierDividerHeight + rowGap;
    }
    scheduleIdx++;

    const isChild = !!entry.isResourceGroupChild;
    const isPoolContainer = !!entry.isPoolContainer;
    const isPoolSub = !!entry.isPoolSubProject;
    const left = ((startDate.getTime() - rangeStart) / totalMs) * 100;
    const width = ((endDate.getTime() - startDate.getTime()) / totalMs) * 100;
    const effectiveFte = isChild ? 0 : (entry.fte ?? totalResources(project));
    const bucketName = project.resourceGroupName || '';
    const isBucketParent = !isChild && !isPoolContainer && bucketName && Array.isArray(project.resourceGroupChildRows) && project.resourceGroupChildRows.length > 0;
    const isPeer = !isChild && !isBucketParent && !isPoolContainer && bucketName && !project.isResourceGroupChild;
    const poolSubHeight = Math.max(minH * 0.55, 9);
    const height = isPoolSub ? poolSubHeight : isChild ? narrowBarHeight : isPoolContainer ? scaleFte(effectiveFte) : scaleFte(effectiveFte);

    /* Pool container: display the pool/FEAT name, not the first row's project summary */
    const slNoPrefix = isPoolContainer ? '' : (project.rowNumber != null ? `${project.rowNumber} - ` : '');
    const summary = isPoolContainer ? (bucketName || project.feat || '') : (project.summary || '');
    const bucketNameForColB = bucketName || (project.feat && project.feat.trim()) || '—';

    const bar = document.createElement('div');
    let barClass = 'gantt-bar';
    if (entry.missingDurationData) barClass += ' gantt-bar--no-duration-data';
    if (entry.pastDeadline) barClass += ' gantt-bar--past-deadline';
    if (isPoolContainer) barClass += ' gantt-bar--pool-container';
    else if (isPoolSub) barClass += ' gantt-bar--pool-sub';
    else if (isChild) barClass += ' gantt-bar--group-child';
    else if (inProgress) barClass += ' gantt-bar--in-progress';
    else if (rotated) barClass += ' gantt-bar--rotated';
    if (project.resourceGroupChildRows?.length && !project.resourceGroupName) barClass += ' gantt-bar--group-parent';
    bar.className = barClass;
    bar.style.left = `${Math.max(0, left)}%`;
    bar.style.width = `${Math.min(100 - left, width)}%`;
    bar.style.height = `${height}px`;
    bar.style.top = `${topOffset}px`;

    /* Pool container: add budget marker line if chain exceeds budget */
    if (isPoolContainer && project._poolBudgetMonths > 0 && project._poolChainMonths > project._poolBudgetMonths) {
      const budgetFrac = project._poolBudgetMonths / (project._poolChainMonths || 1);
      const budgetMarker = document.createElement('div');
      budgetMarker.className = 'gantt-pool-budget-marker';
      budgetMarker.style.left = `${budgetFrac * 100}%`;
      budgetMarker.title = `Budget: ${project._poolBudgetMonths} mo — dependency chain extends to ${project._poolChainMonths} mo`;
      bar.appendChild(budgetMarker);
    }
    const people = effectiveFte || totalResources(project);
    const deps = project.rowNumber != null ? dependentsByProject?.get(project.rowNumber) : null;
    const whyLine = tooltipWhy(deps);
    const devBlockers = new Set(project.dependencyDevBlockers || []);
    const relBlockers = new Set(project.dependencyRelBlockers || []);
    const depRows = (project.dependencyRowNumbers || []).filter(r => r !== project.rowNumber);
    const dependsOnLine = depRows.length
      ? '\nDepends on (cannot complete until checked in): ' + [...new Set(depRows.map(r => resolveDep(r)))].map(resolved => {
          const origRow = depRows.find(d => resolveDep(d) === resolved);
          if (origRow != null && devBlockers.has(origRow)) return `${resolved} (Dev-blocker)`;
          if (origRow != null && relBlockers.has(origRow)) return `${resolved} (Rel-blocker)`;
          return `${resolved}`;
        }).join(', ')
      : '';
    const rotationNote = rotated ? `\n↻ Rotated: ${rotatedFteCount} people (reused from completed projects)` : '';
    const completedPct = Math.min(100, Math.max(0, project.completedPct ?? 0));
    const inProgressNote = completedPct > 0 ? `\n⏳ ${completedPct}% completed (${100 - completedPct}% remaining of ${project.durationMonths ?? '—'} mo total)` : '';

    const groupNote = isPoolSub
      ? `\n📦 Sub-project of pool "${bucketName}" (shares ${project.resourceGroupParentRow != null ? `pool's` : ''} people — no additional headcount)`
      : isChild
      ? `\n📦 Part of ${bucketName ? `bucket "${bucketName}"` : 'resource group'} (shares parent Sl No ${project.resourceGroupParentRow}'s people — no additional headcount)`
      : '';
    let parentNote = '';
    if (isPoolContainer) {
      const pool = project._pool;
      const budgetMo = project._poolBudgetMonths ?? 0;
      const chainMo = project._poolChainMonths ?? 0;
      const overrun = chainMo > budgetMo && budgetMo > 0;
      parentNote = `\n📦 Pool "${bucketName}" — ${pool?.totalResources ?? 0} people, ${pool?.totalPersonMonthsNum ?? '?'} person-months`
        + (budgetMo > 0 ? `\n   Budget: ${budgetMo} mo` : '')
        + (chainMo > 0 ? `\n   Dependency chain: ${chainMo} mo` : '')
        + (overrun ? `\n   ⚠️ Chain exceeds budget by ${chainMo - budgetMo} mo` : '');
    } else if (project.resourceGroupChildRows?.length) {
      parentNote = `\n📦 Bucket "${bucketName || project.rowNumber}" (${project.resourceGroupChildRows.length} sub-projects share these ${people.toFixed(1)} people)`;
    }
    const poolOrder = entry._poolOrder;
    const poolDependsOn = [...new Set(entry.poolDependsOn || [])];
    const poolOrderNote = (isChild || isBucketParent) && poolOrder != null
      ? (poolDependsOn.length > 0
          ? `\n📦 Order in pool: ${poolOrder} (after #${poolDependsOn.join(', #')})`
          : `\n📦 Order in pool: ${poolOrder}`)
      : '';

    let deadlineNote = '';
    if (entry.pastDeadline && !isChild) {
      const deadlineDate = options.deadlineDate;
      const totalPM = project.totalPersonMonthsNum;
      const remainFrac = (100 - completedPct) / 100;
      const remainPM = totalPM > 0 ? totalPM * remainFrac : 0;
      const availMonths = deadlineDate
        ? Math.max(1, Math.round((deadlineDate.getTime() - startDate.getTime()) / MONTH_MS))
        : 0;
      if (remainPM > 0 && availMonths > 0 && pctFactor > 0) {
        const neededPeople = Math.ceil(remainPM / (availMonths * pctFactor));
        const currentPeople = Math.ceil(people);
        const extraPeople = neededPeople - currentPeople;
        if (extraPeople > 0) {
          deadlineNote = `\n⚠️ Extends past end date — to finish on time, increase to ${neededPeople} people (+${extraPeople}) or move end date to ${endDate.toLocaleString('default', { month: 'short', year: 'numeric' })}`;
        } else {
          deadlineNote = `\n⚠️ Extends past end date — move end date to ${endDate.toLocaleString('default', { month: 'short', year: 'numeric' })}`;
        }
      } else {
        deadlineNote = `\n⚠️ Extends past end date — move end date to ${endDate.toLocaleString('default', { month: 'short', year: 'numeric' })}`;
      }
    }
    const noDurationNote = entry.missingDurationData ? `\n⚠️ Total Months Needed for 1 person by Dev (Everything from start to finish) / Dev Resources — data missing; bar greyed out` : '';
    const fundFirstNote = project._fundFirst ? '\n⭐ Fund First — scheduled before all other projects' : '';
    const csvStart = project._csvStartDate ?? null;
    const isOverridden = project.requestedStartDate && csvStart !== project.requestedStartDate;
    const reqStartNote = project.requestedStartDate
      ? `\n📅 Requested start: ${project.requestedStartDate}` + (isOverridden && csvStart ? ` (CSV: ${csvStart})` : isOverridden ? ' (user override)' : '')
      : '';
    const titleLine = isPoolContainer
      ? `${bucketName} (pool)\n${people.toFixed(0)} people · ${project._pool?.totalPersonMonthsNum ?? '?'} person-months`
      : `${slNoPrefix}${project.summary || '—'}\n${project.feat || ''} · ${project.durationMonths ?? '—'} mo · ${isChild ? '0 (shared)' : people.toFixed(1)} people${!isChild && people <= 1 ? ' (no parallelization)' : !isChild ? ' (parallelization chosen)' : ''}`;
    bar.title = `${titleLine}${fundFirstNote}${reqStartNote}${dependsOnLine}${whyLine}${rotationNote}${inProgressNote}${groupNote}${parentNote}${poolOrderNote}${deadlineNote}${noDurationNote}`;
    bar.dataset.fte = effectiveFte.toFixed(1);
    if (!isPoolContainer && project.rowNumber != null) bar.dataset.row = String(project.rowNumber);

    const truncLen = isPoolSub ? 35 : isChild ? 35 : 40;
    const projectName = summary.slice(0, truncLen) + (summary.length > truncLen ? '…' : '') || '—';
    const slNoDisplay = isPoolContainer ? '' : (project.rowNumber != null ? String(project.rowNumber) : '—');
    const remaining = remainingByEntry.get(entry) ?? null;
    const remainingDisplay = remaining != null ? String(remaining) : '';
    const reqStartDisplay = project.requestedStartDate || '';
    const rowNum = project.rowNumber ?? null;
    const csvStartDate = project._csvStartDate ?? null;
    const currentStart = project.requestedStartDate || null;
    const startIsOverridden = currentStart !== csvStartDate && !(currentStart == null && csvStartDate == null);
    const fundFirst = !!project._fundFirst;
    const completedPctVal = Math.min(100, Math.max(0, project.completedPct ?? 0));
    const csvCompletedPct = project._csvCompletedPct ?? 0;
    const pctIsOverridden = completedPctVal !== csvCompletedPct;
    const totalRes = project.totalResources ?? 0;
    const csvTotalResources = project._csvTotalResources ?? totalRes;
    const fteIsOverridden = totalRes !== csvTotalResources;
    const totalPersonMonths = project.totalPersonMonthsNum ?? null;
    const csvTotalPersonMonths = project._csvTotalPersonMonths ?? totalPersonMonths;
    const durationIsOverridden = totalPersonMonths !== csvTotalPersonMonths;
    const displayTier = entry._displayTier ?? 1;
    rowData.push({ top: topOffset, height, colSlNo: slNoDisplay, colB: bucketNameForColB, colC: projectName, colReqStart: reqStartDisplay, csvStartDate, startIsOverridden, colPeople: remainingDisplay, isGroup: isPoolContainer, rowNumber: rowNum, fundFirst, completedPct: completedPctVal, csvCompletedPct, pctIsOverridden, totalResources: totalRes, csvTotalResources, fteIsOverridden, totalPersonMonths, csvTotalPersonMonths, durationIsOverridden, displayTier });

    const label = document.createElement('span');
    label.className = 'gantt-bar-label';
    if (!isChild && people > 0) {
      const fteSpan = document.createElement('span');
      fteSpan.className = 'gantt-bar-balance';
      fteSpan.textContent = `${Math.round(people)}p · `;
      label.appendChild(fteSpan);
    }
    label.appendChild(document.createTextNode(projectName));
    bar.appendChild(label);

    if (project.rowNumber != null) {
      barGeometry.set(project.rowNumber, {
        leftPct: Math.max(0, left),
        rightPct: Math.max(0, left) + Math.min(100 - left, width),
        topPx: topOffset,
        heightPx: height,
        depRows: (project.dependencyRowNumbers || []).filter(r => r !== project.rowNumber),
        devBlockers: new Set(project.dependencyDevBlockers || []),
      });
    }

    track.appendChild(bar);

    /* Track peer group bar vertical positions for wrapper */
    if (isPeer && bucketName) {
      if (!peerGroupBars.has(bucketName)) peerGroupBars.set(bucketName, []);
      peerGroupBars.get(bucketName).push({ topPx: topOffset, bottomPx: topOffset + height });
    }

    topOffset += height + rowGap;
  }

  /* --- Peer group wrappers: dotted border around related bars --- */
  for (const [groupName, positions] of peerGroupBars) {
    if (positions.length < 2) continue;
    const minTop = Math.min(...positions.map(p => p.topPx));
    const maxBottom = Math.max(...positions.map(p => p.bottomPx));
    const wrapper = document.createElement('div');
    wrapper.className = 'gantt-peer-wrapper';
    wrapper.style.top = `${minTop - 3}px`;
    wrapper.style.height = `${maxBottom - minTop + 6}px`;
    const truncName = groupName.length > 60 ? groupName.slice(0, 57).trim() + '…' : groupName;
    const wrapperLabel = document.createElement('span');
    wrapperLabel.className = 'gantt-peer-wrapper-label';
    wrapperLabel.textContent = truncName;
    wrapper.appendChild(wrapperLabel);
    track.appendChild(wrapper);
  }

  /* --- Dependency lines: SVG overlay connecting blocker end → dependent start --- */
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'gantt-dep-lines');
  svg.style.position = 'absolute';
  svg.style.top = '0';
  svg.style.left = '0';
  svg.style.width = '100%';
  svg.style.height = `${topOffset}px`;
  svg.style.pointerEvents = 'none';
  svg.style.overflow = 'visible';

  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
  marker.setAttribute('id', 'dep-arrow');
  marker.setAttribute('viewBox', '0 0 6 6');
  marker.setAttribute('refX', '6');
  marker.setAttribute('refY', '3');
  marker.setAttribute('markerWidth', '5');
  marker.setAttribute('markerHeight', '5');
  marker.setAttribute('orient', 'auto');
  const arrowPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  arrowPath.setAttribute('d', 'M0,0 L6,3 L0,6 Z');
  arrowPath.setAttribute('fill', 'rgba(200,160,60,0.7)');
  marker.appendChild(arrowPath);
  defs.appendChild(marker);
  svg.appendChild(defs);

  function findBarByRow(rowNum) {
    return track.querySelector(`.gantt-bar[data-row="${rowNum}"]`);
  }

  function highlightDep(srcRow, targetRow, lineEl) {
    const srcBar = findBarByRow(srcRow);
    const tgtBar = findBarByRow(targetRow);
    if (srcBar) srcBar.classList.add('gantt-bar--dep-highlight');
    if (tgtBar) tgtBar.classList.add('gantt-bar--dep-highlight');
    lineEl.classList.add('gantt-dep-line--highlight');
  }

  function unhighlightDep(srcRow, targetRow, lineEl) {
    const srcBar = findBarByRow(srcRow);
    const tgtBar = findBarByRow(targetRow);
    if (srcBar) srcBar.classList.remove('gantt-bar--dep-highlight');
    if (tgtBar) tgtBar.classList.remove('gantt-bar--dep-highlight');
    lineEl.classList.remove('gantt-dep-line--highlight');
  }

  for (const [rowNum, geo] of barGeometry) {
    if (!geo.depRows.length) continue;
    const targetMidY = geo.topPx + geo.heightPx / 2;
    const targetLeftPct = geo.leftPct;

    for (const depRow of geo.depRows) {
      /* If the dep target has its own bar, draw arrow directly to it;
         only redirect to parent when the target has no bar (old uber model). */
      const resolved = barGeometry.has(depRow) ? depRow
        : childToParent.has(depRow) ? childToParent.get(depRow) : depRow;
      const depGeo = barGeometry.get(resolved);
      if (!depGeo) continue;

      const srcMidY = depGeo.topPx + depGeo.heightPx / 2;
      const srcRightPct = depGeo.rightPct;

      const isDevBlocker = geo.devBlockers.has(depRow);
      const color = isDevBlocker ? 'rgba(200,160,60,0.55)' : 'rgba(140,140,140,0.4)';

      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', `${srcRightPct}%`);
      line.setAttribute('y1', `${srcMidY}`);
      line.setAttribute('x2', `${targetLeftPct}%`);
      line.setAttribute('y2', `${targetMidY}`);
      line.setAttribute('stroke', color);
      line.setAttribute('stroke-width', isDevBlocker ? '1.5' : '1');
      line.setAttribute('stroke-dasharray', isDevBlocker ? '' : '4,3');
      if (isDevBlocker) line.setAttribute('marker-end', 'url(#dep-arrow)');
      line.style.pointerEvents = 'auto';
      line.style.cursor = 'pointer';
      line.setAttribute('stroke-linecap', 'round');
      /* Invisible wider hit area for easier hovering */
      const hitArea = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      hitArea.setAttribute('x1', `${srcRightPct}%`);
      hitArea.setAttribute('y1', `${srcMidY}`);
      hitArea.setAttribute('x2', `${targetLeftPct}%`);
      hitArea.setAttribute('y2', `${targetMidY}`);
      hitArea.setAttribute('stroke', 'transparent');
      hitArea.setAttribute('stroke-width', '12');
      hitArea.style.pointerEvents = 'auto';
      hitArea.style.cursor = 'pointer';

      const srcRow = resolved;
      const tgtRow = rowNum;
      const depLabel = isDevBlocker ? 'Dev-blocker' : 'Dependency';
      const tooltip = `${depLabel}: Row ${srcRow} → Row ${tgtRow}`;
      hitArea.innerHTML = `<title>${tooltip}</title>`;

      hitArea.addEventListener('mouseenter', () => highlightDep(srcRow, tgtRow, line));
      hitArea.addEventListener('mouseleave', () => unhighlightDep(srcRow, tgtRow, line));

      svg.appendChild(line);
      svg.appendChild(hitArea);
    }
  }

  track.appendChild(svg);

  track.style.height = `${topOffset}px`;
  track.style.minHeight = `${Math.max(topOffset, 200)}px`;

  /* Sl No, Column B (group), Column C (project) labels */
  if (labelsContainer) {
    labelsContainer.innerHTML = '';
    if (rowData.length === 0) labelsContainer.style.display = 'none';
    else {
      labelsContainer.style.display = '';
    const header = document.createElement('div');
    header.className = 'gantt-labels-header';
    header.innerHTML = '<span class="gantt-col-ff">1st</span><span class="gantt-col-b">FEAT</span><span class="gantt-col-c">Project</span><span class="gantt-col-start">Req. Start</span><span class="gantt-col-pct">Done %</span><span class="gantt-col-people">People</span><span class="gantt-col-duration">1p mo</span><span class="gantt-col-available">Remaining</span>';
    labelsContainer.appendChild(header);
    const rowsWrap = document.createElement('div');
    rowsWrap.className = 'gantt-labels-rows';
    rowsWrap.style.height = `${topOffset}px`;
    rowsWrap.style.minHeight = `${Math.max(topOffset, 200)}px`;
    for (const row of rowData) {
      const rowEl = document.createElement('div');
      if (row.isTierDivider) {
        rowEl.className = 'gantt-label-row gantt-label-row--tier-divider';
        rowEl.style.top = `${row.top}px`;
        rowEl.style.height = `${row.height + rowGap}px`;
        rowEl.innerHTML = `<span class="gantt-tier-divider-label">${escapeHtmlLabel(row.colC)}</span>`;
      } else {
        rowEl.className = 'gantt-label-row' + (row.isGroup ? ' gantt-label-row--group' : '');
        rowEl.style.top = `${row.top}px`;
        rowEl.style.height = `${row.height + rowGap}px`;
        const ppl = row.colPeople != null ? String(row.colPeople) : '';
        const projectLabel = row.colSlNo ? `${row.colSlNo} - ${row.colC}` : row.colC;
        rowEl.innerHTML = `<span class="gantt-col-ff"></span><span class="gantt-col-b">${escapeHtmlLabel(row.colB)}</span><span class="gantt-col-c">${escapeHtmlLabel(projectLabel)}</span><span class="gantt-col-available">${escapeHtmlLabel(ppl)}</span>`;

        const ffCell = rowEl.querySelector('.gantt-col-ff');
        if (ffCell && row.rowNumber != null && !row.isGroup && (row.displayTier ?? 1) <= 1) {
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.className = 'gantt-ff-checkbox';
          cb.checked = row.fundFirst;
          cb.title = row.fundFirst ? 'Fund First — this project is prioritized above all others' : 'Check to schedule this project before all others';
          if (onFundFirstChange) {
            const boundRow = row.rowNumber;
            cb.addEventListener('change', () => {
              onFundFirstChange(boundRow, cb.checked);
            });
          }
          ffCell.appendChild(cb);
        }

        const startCell = document.createElement('span');
        startCell.className = 'gantt-col-start';
        const startInput = document.createElement('input');
        startInput.type = 'date';
        const hasCsvDate = !!(row.csvStartDate);
        const dateClass = row.startIsOverridden ? ' gantt-start-input--overridden'
          : hasCsvDate ? ' gantt-start-input--csv' : '';
        startInput.className = 'gantt-start-input' + dateClass;
        startInput.value = normalizeToDateValue(row.colReqStart);
        if (row.startIsOverridden) {
          const csvLabel = row.csvStartDate || 'none';
          startInput.title = `User override (CSV: ${csvLabel}) — clear to restore default`;
        } else if (row.colReqStart) {
          startInput.title = `From CSV: ${row.colReqStart}`;
        } else {
          startInput.title = 'Set requested start date';
        }
        if (onStartDateChange && row.rowNumber != null) {
          const boundRowNumber = row.rowNumber;
          startInput.addEventListener('change', () => {
            onStartDateChange(boundRowNumber, startInput.value || null);
          });
        }
        startCell.appendChild(startInput);
        if (row.startIsOverridden && onStartDateChange && row.rowNumber != null) {
          const boundRowNumberReset = row.rowNumber;
          const resetBtn = document.createElement('button');
          resetBtn.type = 'button';
          resetBtn.className = 'gantt-start-reset';
          resetBtn.textContent = '×';
          resetBtn.title = 'Restore CSV default' + (row.csvStartDate ? ` (${row.csvStartDate})` : ' (none)');
          resetBtn.addEventListener('click', () => {
            onStartDateChange(boundRowNumberReset, null);
          });
          startCell.appendChild(resetBtn);
        }
        const availableSpan = rowEl.querySelector('.gantt-col-available');
        rowEl.insertBefore(startCell, availableSpan);

        const pctCell = document.createElement('span');
        pctCell.className = 'gantt-col-pct';
        if (row.rowNumber != null && !row.isGroup) {
          const pctInput = document.createElement('input');
          pctInput.type = 'number';
          pctInput.min = '0';
          pctInput.max = '100';
          pctInput.step = '1';
          const pctClass = row.pctIsOverridden ? ' gantt-pct-input--overridden'
            : (row.csvCompletedPct > 0) ? ' gantt-pct-input--csv' : '';
          pctInput.className = 'gantt-pct-input' + pctClass;
          const showPctBlank = row.completedPct === 0 && !row.pctIsOverridden;
          pctInput.value = showPctBlank ? '' : String(row.completedPct);
          if (row.pctIsOverridden) {
            pctInput.title = `User override (CSV: ${row.csvCompletedPct}%) — clear to restore`;
          } else if (row.csvCompletedPct > 0) {
            pctInput.title = `From CSV: ${row.csvCompletedPct}%`;
          } else {
            pctInput.title = 'Set completion %';
          }
          if (onCompletedPctChange && row.rowNumber != null) {
            const boundRow = row.rowNumber;
            pctInput.addEventListener('change', () => {
              const raw = pctInput.value.trim();
              if (raw === '') {
                onCompletedPctChange(boundRow, null);
              } else {
                const val = parseFloat(raw);
                if (!Number.isNaN(val)) {
                  onCompletedPctChange(boundRow, Math.min(100, Math.max(0, val)));
                }
              }
            });
          }
          pctCell.appendChild(pctInput);
          if (row.pctIsOverridden && onCompletedPctChange && row.rowNumber != null) {
            pctInput.style.paddingRight = '14px';
            const boundRowReset = row.rowNumber;
            const resetBtn = document.createElement('button');
            resetBtn.type = 'button';
            resetBtn.className = 'gantt-pct-reset';
            resetBtn.textContent = '×';
            resetBtn.title = `Restore CSV default (${row.csvCompletedPct}%)`;
            resetBtn.addEventListener('click', () => {
              onCompletedPctChange(boundRowReset, null);
            });
            pctCell.appendChild(resetBtn);
          }
        }
        rowEl.insertBefore(pctCell, availableSpan);

        const fteCell = document.createElement('span');
        fteCell.className = 'gantt-col-people';
        if (row.rowNumber != null && !row.isGroup) {
          const fteInput = document.createElement('input');
          fteInput.type = 'number';
          fteInput.min = '0';
          fteInput.step = '1';
          const fteClass = row.fteIsOverridden ? ' gantt-fte-input--overridden'
            : (row.csvTotalResources > 0) ? ' gantt-fte-input--csv' : '';
          fteInput.className = 'gantt-fte-input' + fteClass;
          const showFteBlank = row.totalResources === 0 && !row.fteIsOverridden;
          fteInput.value = showFteBlank ? '' : String(row.totalResources);
          if (row.fteIsOverridden) {
            fteInput.title = `User override (CSV: ${row.csvTotalResources}) — clear to restore`;
          } else if (row.csvTotalResources > 0) {
            fteInput.title = `From CSV: ${row.csvTotalResources}`;
          } else {
            fteInput.title = 'Set people count';
          }
          if (onFteChange && row.rowNumber != null) {
            const boundRow = row.rowNumber;
            fteInput.addEventListener('change', () => {
              const raw = fteInput.value.trim();
              if (raw === '') {
                onFteChange(boundRow, null);
              } else {
                const val = parseFloat(raw);
                if (!Number.isNaN(val) && val >= 0) {
                  onFteChange(boundRow, val);
                }
              }
            });
          }
          fteCell.appendChild(fteInput);
          if (row.fteIsOverridden && onFteChange && row.rowNumber != null) {
            fteInput.style.paddingRight = '14px';
            const boundRowReset = row.rowNumber;
            const resetBtn = document.createElement('button');
            resetBtn.type = 'button';
            resetBtn.className = 'gantt-fte-reset';
            resetBtn.textContent = '×';
            resetBtn.title = `Restore CSV default (${row.csvTotalResources})`;
            resetBtn.addEventListener('click', () => {
              onFteChange(boundRowReset, null);
            });
            fteCell.appendChild(resetBtn);
          }
        }
        rowEl.insertBefore(fteCell, availableSpan);

        const durCell = document.createElement('span');
        durCell.className = 'gantt-col-duration';
        if (row.rowNumber != null && !row.isGroup) {
          const durInput = document.createElement('input');
          durInput.type = 'number';
          durInput.min = '0';
          durInput.step = '1';
          const durClass = row.durationIsOverridden ? ' gantt-dur-input--overridden'
            : (row.csvTotalPersonMonths != null && row.csvTotalPersonMonths > 0) ? ' gantt-dur-input--csv' : '';
          durInput.className = 'gantt-dur-input' + durClass;
          const showDurBlank = (row.totalPersonMonths == null || row.totalPersonMonths === 0) && !row.durationIsOverridden;
          durInput.value = showDurBlank ? '' : String(row.totalPersonMonths);
          if (row.durationIsOverridden) {
            const csvLabel = row.csvTotalPersonMonths != null ? row.csvTotalPersonMonths : 'none';
            durInput.title = `User override (CSV: ${csvLabel}) — clear to restore`;
          } else if (row.totalPersonMonths != null && row.totalPersonMonths > 0) {
            durInput.title = `From CSV: ${row.totalPersonMonths} person-months`;
          } else {
            durInput.title = 'Set total person-months (1 person, start to finish)';
          }
          if (onDurationChange && row.rowNumber != null) {
            const boundRow = row.rowNumber;
            durInput.addEventListener('change', () => {
              const raw = durInput.value.trim();
              if (raw === '') {
                onDurationChange(boundRow, null);
              } else {
                const val = parseFloat(raw);
                if (!Number.isNaN(val) && val >= 0) {
                  onDurationChange(boundRow, val);
                }
              }
            });
          }
          durCell.appendChild(durInput);
          if (row.durationIsOverridden && onDurationChange && row.rowNumber != null) {
            durInput.style.paddingRight = '14px';
            const boundRowReset = row.rowNumber;
            const resetBtn = document.createElement('button');
            resetBtn.type = 'button';
            resetBtn.className = 'gantt-dur-reset';
            resetBtn.textContent = '×';
            const csvLabel = row.csvTotalPersonMonths != null ? row.csvTotalPersonMonths : 'none';
            resetBtn.title = `Restore CSV default (${csvLabel})`;
            resetBtn.addEventListener('click', () => {
              onDurationChange(boundRowReset, null);
            });
            durCell.appendChild(resetBtn);
          }
        }
        rowEl.insertBefore(durCell, availableSpan);
      }
      rowsWrap.appendChild(rowEl);
    }
    labelsContainer.appendChild(rowsWrap);
    }
  }

  /* Viewport: user's start/end fill the visible area; rest is horizontal scroll */
  const visibleRange = options.visibleRange;
  let widthPct = 100;
  if (visibleRange) {
    const visibleMs = Math.max(visibleRange.endDate.getTime() - visibleRange.startDate.getTime(), 1);
    widthPct = Math.max(100, (totalMs / visibleMs) * 100);
  }
  container.style.width = `${widthPct}%`;
  track.style.width = '100%';

  const trackHeight = track.style.height;
  const grid = document.createElement('div');
  grid.className = 'gantt-grid';
  grid.style.height = trackHeight;
  grid.style.width = '100%';
  const rangeStartAxis = timeline.startDate.getTime();
  const rangeEndAxis = timeline.endDate.getTime();
  const totalMsAxis = Math.max(rangeEndAxis - rangeStartAxis, 1);
  const start = new Date(timeline.startDate);
  const end = new Date(timeline.endDate);
  const totalMonthsAxis = Math.ceil((end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth()) + 1);
  const maxTicks = Math.min(24, Math.max(14, totalMonthsAxis));
  const interval = Math.max(1, Math.floor(totalMonthsAxis / maxTicks));
  const tickMonths = [];
  for (let i = 0; i < totalMonthsAxis; i += interval) tickMonths.push(i);
  if (totalMonthsAxis > 0 && tickMonths[tickMonths.length - 1] !== totalMonthsAxis - 1) tickMonths.push(totalMonthsAxis - 1);
  for (const monthIndex of tickMonths) {
    const d = new Date(start.getFullYear(), start.getMonth() + monthIndex, 1);
    if (d > end) break;
    const posMs = d.getTime() - rangeStartAxis;
    const leftPct = (posMs / totalMsAxis) * 100;
    const line = document.createElement('div');
    line.className = 'gantt-grid-line';
    line.style.left = `${Math.max(0, Math.min(100, leftPct))}%`;
    grid.appendChild(line);
  }
  container.appendChild(grid);
  container.appendChild(track);

  /* Deadline marker: vertical line at end date */
  const deadlineDate = options.deadlineDate;
  if (deadlineDate && deadlineDate.getTime() > rangeStart && deadlineDate.getTime() < rangeEnd) {
    const deadlinePct = ((deadlineDate.getTime() - rangeStart) / totalMs) * 100;
    const line = document.createElement('div');
    line.className = 'gantt-deadline-line';
    line.style.left = `${Math.max(0, Math.min(100, deadlinePct))}%`;
    line.style.height = track.style.height;
    container.appendChild(line);
  }
}

/**
 * Renders the timeline axis above the chart.
 * Uses spaced ticks (max ~12–15 labels) so labels don't overlap on long ranges.
 * If options.visibleRange is set, axis width is scaled so viewport matches user start/end.
 */
export function renderTimelineAxis(container, timeline, options = {}) {
  container.innerHTML = '';
  const start = new Date(timeline.startDate);
  const end = new Date(timeline.endDate);
  const rangeStartMs = start.getTime();
  const rangeEndMs = end.getTime();
  const totalMs = Math.max(rangeEndMs - rangeStartMs, 1);

  let widthPct = 100;
  const visibleRange = options.visibleRange;
  if (visibleRange) {
    const visibleMs = Math.max(visibleRange.endDate.getTime() - visibleRange.startDate.getTime(), 1);
    widthPct = Math.max(100, (totalMs / visibleMs) * 100);
  }

  const totalMonths = Math.ceil((end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth()) + 1);
  const maxTicks = Math.min(24, Math.max(14, totalMonths));
  const interval = Math.max(1, Math.floor(totalMonths / maxTicks));
  const tickMonths = [];
  for (let i = 0; i < totalMonths; i += interval) tickMonths.push(i);
  if (totalMonths > 0 && tickMonths[tickMonths.length - 1] !== totalMonths - 1) tickMonths.push(totalMonths - 1);

  container.style.width = `${widthPct}%`;
  const axis = document.createElement('div');
  axis.className = 'gantt-axis';
  for (const monthIndex of tickMonths) {
    const d = new Date(start.getFullYear(), start.getMonth() + monthIndex, 1);
    if (d > end) break;
    const label = `${d.toLocaleString('default', { month: 'short' })} ${d.getFullYear()}`;
    const posMs = d.getTime() - rangeStartMs;
    const leftPct = (posMs / totalMs) * 100;

    const tick = document.createElement('div');
    tick.className = 'gantt-axis-tick';
    tick.style.left = `${Math.max(0, Math.min(100, leftPct))}%`;
    tick.textContent = label;
    axis.appendChild(tick);
  }
  container.appendChild(axis);
}
