/**
 * Shared DOM and formatting utilities.
 * @module utils
 */

/** Cache of getElementById lookups to avoid repeated DOM queries. */
const _elCache = Object.create(null);

/**
 * Get a DOM element by id, with optional caching.
 * @param {string} id - Element id.
 * @returns {HTMLElement | null}
 */
export function getEl(id) {
  if (id == null) return null;
  if (_elCache[id] !== undefined) return _elCache[id];
  const el = document.getElementById(id);
  if (el) _elCache[id] = el;
  return el;
}

/**
 * Parse an ISO-style date string (YYYY-MM-DD) to a Date at midnight local.
 * @param {string} str - Date string.
 * @returns {Date}
 */
export function parseDate(str) {
  const [y, m, d] = str.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/**
 * Format a Date for display (e.g. "Jan 15, 2026").
 * @param {Date | null | undefined} d
 * @returns {string}
 */
export function formatDate(d) {
  if (!d) return '—';
  return d.toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * Format a number for display; integers as-is, decimals to 2 places. NaN/null → "—".
 * @param {number | null | undefined} n
 * @returns {string}
 */
export function formatNum(n) {
  if (n == null || Number.isNaN(n)) return '—';
  return Number(n) % 1 === 0 ? String(n) : Number(n).toFixed(2);
}

/**
 * Escape a string for safe insertion into HTML (text content or attributes).
 * @param {string} s
 * @returns {string}
 */
export function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

/**
 * Month difference between two dates (whole months, no fractional).
 * @param {Date | string} startDate
 * @param {Date | string} endDate
 * @returns {number | null}
 */
export function monthDiff(startDate, endDate) {
  if (!startDate || !endDate) return null;
  const s = startDate instanceof Date ? startDate : new Date(startDate);
  const e = endDate instanceof Date ? endDate : new Date(endDate);
  return Math.max(0, (e.getFullYear() - s.getFullYear()) * 12 + (e.getMonth() - s.getMonth()));
}

/**
 * Normalize a string for comparison (trim + lower case).
 * @param {string} s
 * @returns {string}
 */
export function norm(s) {
  return (s || '').trim().toLowerCase();
}
