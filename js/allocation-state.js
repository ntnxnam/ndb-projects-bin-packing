/**
 * Persisted state for People allocation tab: staff list, allocations, headcount.
 * Uses its own localStorage keys so no other modules are modified.
 * @module allocation-state
 */

const STAFF_STORAGE_KEY = 'ndb-allocation-staff';
const ALLOCATIONS_STORAGE_KEY = 'ndb-allocation-allocations';
const HEADCOUNT_STORAGE_KEY = 'ndb-allocation-headcount';

/**
 * @typedef {object} StaffMember
 * @property {string} id
 * @property {string} name
 * @property {number} capacityPct
 */

/**
 * @typedef {object} Allocation
 * @property {string} id
 * @property {string} staffId
 * @property {number} projectRowNumber
 * @property {string} [projectSummary]
 * @property {string} startDate YYYY-MM-DD
 * @property {string} endDate YYYY-MM-DD
 * @property {number} [allocationPct] 0-100, default 100
 */

/**
 * Load staff from localStorage.
 * @returns {StaffMember[]}
 */
export function getStaff() {
  try {
    const raw = localStorage.getItem(STAFF_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch (_) {
    return [];
  }
}

/**
 * Save staff to localStorage.
 * @param {StaffMember[]} staff
 */
export function setStaff(staff) {
  try {
    if (!Array.isArray(staff)) return;
    localStorage.setItem(STAFF_STORAGE_KEY, JSON.stringify(staff));
  } catch (_) {}
}

/**
 * Load allocations from localStorage.
 * @returns {Allocation[]}
 */
export function getAllocations() {
  try {
    const raw = localStorage.getItem(ALLOCATIONS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch (_) {
    return [];
  }
}

/**
 * Save allocations to localStorage.
 * @param {Allocation[]} allocations
 */
export function setAllocations(allocations) {
  try {
    if (!Array.isArray(allocations)) return;
    localStorage.setItem(ALLOCATIONS_STORAGE_KEY, JSON.stringify(allocations));
  } catch (_) {}
}

/**
 * Load headcount (for placeholder people). Returns null if never set.
 * @returns {number | null}
 */
export function getHeadcount() {
  try {
    const raw = localStorage.getItem(HEADCOUNT_STORAGE_KEY);
    if (raw == null || raw === '') return null;
    const n = parseInt(raw, 10);
    return Number.isNaN(n) ? null : Math.max(1, Math.min(500, n));
  } catch (_) {
    return null;
  }
}

/**
 * Save headcount.
 * @param {number} n
 */
export function setHeadcount(n) {
  try {
    const val = Math.max(1, Math.min(500, parseInt(String(n), 10) || 85));
    localStorage.setItem(HEADCOUNT_STORAGE_KEY, String(val));
  } catch (_) {}
}
