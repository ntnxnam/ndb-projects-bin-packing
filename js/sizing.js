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
 * For IAMv2-style big bar width: sizing band → { lower, mid, higher } months.
 * CONVENTIONS: < L use lower; L and XL use mid; > XL use higher.
 */
const SIZING_BAND_MONTHS = {
  'None': { lower: 0, mid: 0, higher: 0 },
  'XS (1 month)': { lower: 1, mid: 1, higher: 1 },
  'S (1-3 months)': { lower: 1, mid: 2, higher: 3 },
  'M (3-5 months)': { lower: 3, mid: 4, higher: 5 },
  'L (5-8 months)': { lower: 5, mid: 6, higher: 8 },
  'XL (8-13 months)': { lower: 8, mid: 10, higher: 13 },
  'XXL (13+ months)': { lower: 13, mid: 17, higher: 21 },
  '3L (21+ months)': { lower: 21, mid: 27, higher: 34 },
  '4L (34+ months)': { lower: 34, mid: 44, higher: 55 },
};

/**
 * Months to use for IAMv2-style pool (big) bar width from "sizing (refer sheet 2 for guidance)".
 * &lt; L → lower end; L and XL → mid; &gt; XL → higher end.
 * @param {string} sizingLabel - e.g. "M (3-5 months)", "XL (8-13 months)"
 * @returns {number} Months for the big bar (0 if unknown label).
 */
export function monthsFromSizingBand(sizingLabel) {
  const band = (sizingLabel || '').trim();
  const range = SIZING_BAND_MONTHS[band];
  if (!range) return 0;
  if (band === 'L (5-8 months)' || band === 'XL (8-13 months)') return range.mid;
  const max = SIZING_MONTHS[band];
  if (max == null) return 0;
  if (max <= 5) return range.lower;  /* XS, S, M = &lt; L */
  if (max >= 21) return range.higher; /* XXL, 3L, 4L = &gt; XL */
  return range.mid; /* L, XL already handled */
}

/**
 * Raw duration in months from project (Number of Months (Dev) or derived).
 * @param {object} project
 * @returns {number}
 */
export function durationMonths(project) {
  return project.durationMonths ?? 0;
}

/**
 * Duration in months: Total person-months / (Dev resources × capacityPct/100).
 * 9 person-months with 3 devs at 60% → 9 / (3 × 0.6) = 5 months.
 * Falls back to durationMonths if no person-months data.
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
 * True when project has data needed for bar length: either (totalPersonMonthsNum + totalResources) or (durationMonths + totalResources).
 * When false, schedule shows a greyed-out bar (data missing).
 * @param {object} project
 * @returns {boolean}
 */
export function hasDurationData(project) {
  const total = project.totalPersonMonthsNum;
  const devR = totalResources(project);
  if (total != null && total > 0 && devR > 0) return true;
  /* durationMonths from sizing band or explicit Number of Months (Dev) is valid even when devResources = 0
     (e.g. rows where the formula in "Number of Months (Dev)" errors with #DIV/0! but sizing is present). */
  const dm = project.durationMonths;
  return typeof dm === 'number' && dm > 0;
}

/**
 * Remaining duration in months for bar width:
 * (Total person-months × (100 − completed %) / 100) ÷ (Dev resources × capacityPct / 100).
 * E.g. 9 person-months, 3 devs, 60% capacity → 9 / (3 × 0.6) = 5 months.
 * When data is missing, returns 0 — caller shows a greyed-out bar.
 * @param {object} project - Project with totalPersonMonthsNum, completedPct, totalResources (dev resources).
 * @param {number} [capacityPct] - 0–100; e.g. 60 for 60%. If missing/0, treated as 100%.
 * @returns {number} Remaining duration in months (≥ 1), or 0 if data missing.
 */
export function remainingDurationMonths(project, capacityPct) {
  if (!hasDurationData(project)) return 0;
  const completedPct = Math.min(100, Math.max(0, project.completedPct ?? 0));
  const remainingFraction = (100 - completedPct) / 100;
  const devR = totalResources(project);
  const totalExplicit = project.totalPersonMonthsNum;
  const capacityFactor = capacityPct > 0 && capacityPct <= 100 ? capacityPct / 100 : 1;
  if (totalExplicit != null && totalExplicit > 0 && devR > 0) {
    const remainingPersonMonths = totalExplicit * remainingFraction;
    return Math.max(1, Math.ceil(remainingPersonMonths / (devR * capacityFactor)));
  }
  /* Fallback: use durationMonths directly (adjusted for completion %) when totalPersonMonthsNum is missing. */
  const dm = project.durationMonths;
  if (typeof dm === 'number' && dm > 0) {
    return Math.max(1, Math.ceil(dm * remainingFraction));
  }
  return 0;
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
