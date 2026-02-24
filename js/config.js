/**
 * Application-wide configuration and constants.
 * Single source of truth for defaults and storage keys.
 * @module config
 */

/** Default timeline start (YYYY-MM-DD). */
export const DEFAULT_START = '2026-04-01';

/** Default timeline end / viewport (YYYY-MM-DD). */
export const DEFAULT_END = '2027-01-30';

/** Default headcount (number of FTEs). */
export const DEFAULT_NUM_FTES = 85;

/** Default capacity per FTE in percent (e.g. 60 = 60% productivity). */
export const DEFAULT_CAPACITY_PCT = 60;

/** localStorage key for persisted project data (uploaded CSV/JSON). */
export const UPLOAD_STORAGE_KEY = 'ndb-projects-upload';

/** localStorage key for last-used schedule filters (commitment, priority, etc.). */
export const FILTERS_STORAGE_KEY = 'ndb-projects-filters';

/** Enable debug logging when true. Set via query param ?debug=1 or build. */
export const DEBUG = typeof window !== 'undefined' && /[?&]debug=1/.test(window.location.search);

/** Min/max bounds for numeric inputs. */
export const NUM_FTES_MIN = 1;
export const NUM_FTES_MAX = 500;
export const CAPACITY_PCT_MIN = 0.1;
export const CAPACITY_PCT_MAX = 100;
