/**
 * Persisted application state (projects and filters) via localStorage.
 * Single contract for all pages so filters and data stay in sync.
 * @module state
 */

import { logger } from './logger.js';
import { UPLOAD_STORAGE_KEY, SCHEDULE_STORAGE_KEY, FILTERS_STORAGE_KEY, START_DATE_OVERRIDES_KEY, FUND_FIRST_KEY, COMPLETED_PCT_OVERRIDES_KEY, FTE_OVERRIDES_KEY, DURATION_OVERRIDES_KEY } from './config.js';

/**
 * Load projects from localStorage (previously uploaded CSV/JSON).
 * @returns {Array<object>} Project objects, or empty array if none or invalid.
 */
export function getProjects() {
  try {
    const raw = localStorage.getItem(UPLOAD_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    logger.debug('state.getProjects: loaded', parsed.length, 'projects');
    return parsed;
  } catch (e) {
    logger.warn('state.getProjects: invalid stored data', e);
    return [];
  }
}

/**
 * Persist projects to localStorage (e.g. after upload/submit).
 * @param {Array<object>} projects
 */
export function setProjects(projects) {
  try {
    if (!Array.isArray(projects)) return;
    localStorage.setItem(UPLOAD_STORAGE_KEY, JSON.stringify(projects));
    logger.debug('state.setProjects: saved', projects.length, 'projects');
  } catch (e) {
    logger.warn('state.setProjects: failed to persist', e);
  }
}

/**
 * Load schedule-ready projects (Committed-only, cleaned) from localStorage.
 * @returns {Array<object>}
 */
export function getScheduleData() {
  try {
    const raw = localStorage.getItem(SCHEDULE_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    logger.debug('state.getScheduleData: loaded', parsed.length, 'projects');
    return parsed;
  } catch (e) {
    logger.warn('state.getScheduleData: invalid stored data', e);
    return [];
  }
}

/**
 * Persist schedule-ready projects to localStorage.
 * @param {Array<object>} projects
 */
export function setScheduleData(projects) {
  try {
    if (!Array.isArray(projects)) return;
    localStorage.setItem(SCHEDULE_STORAGE_KEY, JSON.stringify(projects));
    logger.debug('state.setScheduleData: saved', projects.length, 'projects');
  } catch (e) {
    logger.warn('state.setScheduleData: failed to persist', e);
  }
}

/**
 * @typedef {object} FilterState
 * @property {string} commitment - e.g. "Committed", "Approved", ""
 * @property {string} priority - e.g. "P0", "P1", ""
 */

/**
 * Load last-used filters from localStorage (optional; pages can use defaults).
 * @returns {FilterState}
 */
export function getFilters() {
  try {
    const raw = localStorage.getItem(FILTERS_STORAGE_KEY);
    if (!raw) return { commitment: '', priority: '' };
    const parsed = JSON.parse(raw);
    return {
      commitment: String(parsed.commitment ?? '').trim(),
      priority: String(parsed.priority ?? '').trim(),
    };
  } catch (e) {
    logger.warn('state.getFilters: invalid stored data', e);
    return { commitment: '', priority: '' };
  }
}

/**
 * Persist filter state so other pages can pre-fill (e.g. Schedule → Bottom-up).
 * @param {FilterState} filters
 */
export function setFilters(filters) {
  try {
    if (!filters || typeof filters !== 'object') return;
    localStorage.setItem(FILTERS_STORAGE_KEY, JSON.stringify({
      commitment: String(filters.commitment ?? '').trim(),
      priority: String(filters.priority ?? '').trim(),
    }));
    logger.debug('state.setFilters: saved', filters);
  } catch (e) {
    logger.warn('state.setFilters: failed to persist', e);
  }
}

/**
 * Load user-overridden start dates.
 * @returns {Object<string, string>} Map of rowNumber (as string key) → date string.
 */
export function getStartDateOverrides() {
  try {
    const raw = localStorage.getItem(START_DATE_OVERRIDES_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch (e) {
    logger.warn('state.getStartDateOverrides: invalid stored data', e);
    return {};
  }
}

/**
 * Set a user-overridden start date for a project.
 * @param {number} rowNumber
 * @param {string} dateStr - YYYY-MM-DD (or null to clear)
 */
export function setStartDateOverride(rowNumber, dateStr) {
  try {
    const overrides = getStartDateOverrides();
    if (dateStr) {
      overrides[String(rowNumber)] = dateStr;
    } else {
      delete overrides[String(rowNumber)];
    }
    localStorage.setItem(START_DATE_OVERRIDES_KEY, JSON.stringify(overrides));
    logger.debug('state.setStartDateOverride:', rowNumber, dateStr);
  } catch (e) {
    logger.warn('state.setStartDateOverride: failed to persist', e);
  }
}

/**
 * Apply start-date overrides to a projects array (in-place).
 * Stashes the CSV original in `_csvStartDate` before overwriting.
 * @param {Array<object>} projects
 */
export function applyStartDateOverrides(projects) {
  const overrides = getStartDateOverrides();
  for (const p of projects) {
    if (p.rowNumber == null) continue;
    const key = String(p.rowNumber);
    if (!p.hasOwnProperty('_csvStartDate')) {
      p._csvStartDate = p.requestedStartDate ?? null;
    }
    if (key in overrides) {
      p.requestedStartDate = overrides[key];
    } else {
      p.requestedStartDate = p._csvStartDate;
    }
  }
}

/**
 * Load "fund first" flags.
 * @returns {Object<string, boolean>} Map of rowNumber (as string key) → true.
 */
export function getFundFirstOverrides() {
  try {
    const raw = localStorage.getItem(FUND_FIRST_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch (e) {
    logger.warn('state.getFundFirstOverrides: invalid stored data', e);
    return {};
  }
}

/**
 * Toggle the "fund first" flag for a project.
 * @param {number} rowNumber
 * @param {boolean} enabled
 */
export function setFundFirstOverride(rowNumber, enabled) {
  try {
    const overrides = getFundFirstOverrides();
    if (enabled) {
      overrides[String(rowNumber)] = true;
    } else {
      delete overrides[String(rowNumber)];
    }
    localStorage.setItem(FUND_FIRST_KEY, JSON.stringify(overrides));
    logger.debug('state.setFundFirstOverride:', rowNumber, enabled);
  } catch (e) {
    logger.warn('state.setFundFirstOverride: failed to persist', e);
  }
}

/**
 * Apply fund-first flags to a projects array (in-place).
 * Sets `_fundFirst = true` on flagged projects.
 * @param {Array<object>} projects
 */
export function applyFundFirstOverrides(projects) {
  const overrides = getFundFirstOverrides();
  for (const p of projects) {
    if (p.rowNumber == null) continue;
    p._fundFirst = !!overrides[String(p.rowNumber)];
  }
}

/**
 * Load user-overridden completed percentages.
 * @returns {Object<string, number>} Map of rowNumber (as string key) → number (0–100).
 */
export function getCompletedPctOverrides() {
  try {
    const raw = localStorage.getItem(COMPLETED_PCT_OVERRIDES_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch (e) {
    logger.warn('state.getCompletedPctOverrides: invalid stored data', e);
    return {};
  }
}

/**
 * Set a user-overridden completed % for a project.
 * @param {number} rowNumber
 * @param {number|null} pct - 0–100, or null to clear the override
 */
export function setCompletedPctOverride(rowNumber, pct) {
  try {
    const overrides = getCompletedPctOverrides();
    if (pct != null && pct >= 0) {
      overrides[String(rowNumber)] = Math.min(100, Math.max(0, pct));
    } else {
      delete overrides[String(rowNumber)];
    }
    localStorage.setItem(COMPLETED_PCT_OVERRIDES_KEY, JSON.stringify(overrides));
    logger.debug('state.setCompletedPctOverride:', rowNumber, pct);
  } catch (e) {
    logger.warn('state.setCompletedPctOverride: failed to persist', e);
  }
}

/**
 * Apply completed-pct overrides to a projects array (in-place).
 * Stashes the CSV original in `_csvCompletedPct` before overwriting.
 * @param {Array<object>} projects
 */
export function applyCompletedPctOverrides(projects) {
  const overrides = getCompletedPctOverrides();
  for (const p of projects) {
    if (p.rowNumber == null) continue;
    const key = String(p.rowNumber);
    if (!p.hasOwnProperty('_csvCompletedPct')) {
      p._csvCompletedPct = p.completedPct ?? 0;
    }
    if (key in overrides) {
      p.completedPct = overrides[key];
    } else {
      p.completedPct = p._csvCompletedPct;
    }
  }
}

/**
 * Load user-overridden FTE (people) counts.
 * @returns {Object<string, number>} Map of rowNumber (as string key) → number.
 */
export function getFteOverrides() {
  try {
    const raw = localStorage.getItem(FTE_OVERRIDES_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch (e) {
    logger.warn('state.getFteOverrides: invalid stored data', e);
    return {};
  }
}

/**
 * Set a user-overridden FTE count for a project.
 * @param {number} rowNumber
 * @param {number|null} fte - positive number, or null to clear the override
 */
export function setFteOverride(rowNumber, fte) {
  try {
    const overrides = getFteOverrides();
    if (fte != null && fte > 0) {
      overrides[String(rowNumber)] = fte;
    } else {
      delete overrides[String(rowNumber)];
    }
    localStorage.setItem(FTE_OVERRIDES_KEY, JSON.stringify(overrides));
    logger.debug('state.setFteOverride:', rowNumber, fte);
  } catch (e) {
    logger.warn('state.setFteOverride: failed to persist', e);
  }
}

/**
 * Apply FTE overrides to a projects array (in-place).
 * Stashes the CSV original in `_csvTotalResources` before overwriting.
 * @param {Array<object>} projects
 */
export function applyFteOverrides(projects) {
  const overrides = getFteOverrides();
  for (const p of projects) {
    if (p.rowNumber == null) continue;
    const key = String(p.rowNumber);
    if (!p.hasOwnProperty('_csvTotalResources')) {
      p._csvTotalResources = p.totalResources ?? 0;
    }
    if (key in overrides) {
      p.totalResources = overrides[key];
    } else {
      p.totalResources = p._csvTotalResources;
    }
  }
}

/**
 * Load user-overridden total person-months.
 * @returns {Object<string, number>} Map of rowNumber (as string key) → number.
 */
export function getDurationOverrides() {
  try {
    const raw = localStorage.getItem(DURATION_OVERRIDES_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch (e) {
    logger.warn('state.getDurationOverrides: invalid stored data', e);
    return {};
  }
}

/**
 * Set a user-overridden total person-months for a project.
 * @param {number} rowNumber
 * @param {number|null} months - positive number, or null to clear the override
 */
export function setDurationOverride(rowNumber, months) {
  try {
    const overrides = getDurationOverrides();
    if (months != null && months > 0) {
      overrides[String(rowNumber)] = months;
    } else {
      delete overrides[String(rowNumber)];
    }
    localStorage.setItem(DURATION_OVERRIDES_KEY, JSON.stringify(overrides));
    logger.debug('state.setDurationOverride:', rowNumber, months);
  } catch (e) {
    logger.warn('state.setDurationOverride: failed to persist', e);
  }
}

/**
 * Apply duration (total person-months) overrides to a projects array (in-place).
 * Stashes the CSV original in `_csvTotalPersonMonths` before overwriting.
 * @param {Array<object>} projects
 */
export function applyDurationOverrides(projects) {
  const overrides = getDurationOverrides();
  for (const p of projects) {
    if (p.rowNumber == null) continue;
    const key = String(p.rowNumber);
    if (!p.hasOwnProperty('_csvTotalPersonMonths')) {
      p._csvTotalPersonMonths = p.totalPersonMonthsNum ?? null;
    }
    if (key in overrides) {
      p.totalPersonMonthsNum = overrides[key];
    } else {
      p.totalPersonMonthsNum = p._csvTotalPersonMonths;
    }
  }
}

/**
 * Clear all user overrides (start dates, fund-first flags, completed %, FTE, duration).
 * Call on fresh CSV upload to avoid stale state.
 */
export function clearAllOverrides() {
  try {
    localStorage.removeItem(START_DATE_OVERRIDES_KEY);
    localStorage.removeItem(FUND_FIRST_KEY);
    localStorage.removeItem(COMPLETED_PCT_OVERRIDES_KEY);
    localStorage.removeItem(FTE_OVERRIDES_KEY);
    localStorage.removeItem(DURATION_OVERRIDES_KEY);
    logger.debug('state.clearAllOverrides: cleared all overrides');
  } catch (e) {
    logger.warn('state.clearAllOverrides: failed', e);
  }
}
