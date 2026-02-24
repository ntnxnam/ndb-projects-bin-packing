/**
 * Sizing bands and duration/resource helpers for project scheduling.
 * Single source of truth for label → "up to" months (Gantt bar length).
 * @module sizing
 */

/** Sizing label → maximum months (e.g. "M (3-5 months)" → 5). */
export const SIZING_MONTHS = {
  'None': 0,
  'XS (1 month)': 1,
  'S (1-3 months)': 3,
  'M (3-5 months)': 5,
  'L (5-8 months)': 8,
  'XL (8-13 months)': 13,
  'XXL (13+ months)': 21,
  '3L (21+ months)': 34,
  '4L (34+ months)': 55,
};

/**
 * Raw duration in months from project (Number of Months (Dev) or derived).
 * @param {object} project
 * @returns {number}
 */
export function durationMonths(project) {
  return project.durationMonths ?? 0;
}

/**
 * Duration in months using productivity: Total person-months / (Dev resources × capacityPct/100).
 * Used for scheduling when user sets Capacity per FTE (e.g. 60%). Falls back to durationMonths if no data.
 * @param {object} project
 * @param {number} [capacityPct] - 0–100; e.g. 60 for 60%. If missing/0, uses durationMonths.
 */
export function effectiveDurationMonths(project, capacityPct) {
  const pct = capacityPct > 0 && capacityPct <= 100 ? capacityPct / 100 : 0;
  const total = project.totalPersonMonthsNum;
  const devR = totalResources(project);
  if (pct > 0 && total != null && total > 0 && devR > 0) {
    return Math.max(1, Math.ceil(total / (devR * pct)));
  }
  return Math.max(0, durationMonths(project));
}

/**
 * Remaining duration in months for bar width: (Total person-months × (100 − completed %) / 100) ÷ (Dev resources × capacity % / 100).
 * Single source for schedule bar length; applies completion % and capacity %.
 * @param {object} project - Project with totalPersonMonthsNum, completedPct, totalResources (dev resources).
 * @param {number} [capacityPct] - 0–100; e.g. 60 for 60%. If missing/0, treated as 100%.
 * @returns {number} Remaining duration in months (≥ 1).
 */
export function remainingDurationMonths(project, capacityPct) {
  const completedPct = Math.min(100, Math.max(0, project.completedPct ?? 0));
  const remainingFraction = (100 - completedPct) / 100;
  const total = project.totalPersonMonthsNum;
  const devR = totalResources(project);
  const capacityFactor = capacityPct > 0 && capacityPct <= 100 ? capacityPct / 100 : 1;
  if (total != null && total > 0 && devR > 0) {
    const remainingPersonMonths = total * remainingFraction;
    return Math.max(1, Math.ceil(remainingPersonMonths / (devR * capacityFactor)));
  }
  const full = durationMonths(project) || (project.sizingLabel && SIZING_MONTHS[project.sizingLabel]) || 0;
  return Math.max(1, Math.ceil((full || 1) * remainingFraction));
}

/**
 * Dev resources (headcount) for the project; 0 if missing or invalid.
 * @param {object} project
 * @returns {number}
 */
export function totalResources(project) {
  const r = project.totalResources;
  return typeof r === 'number' && r > 0 ? r : 0;
}
