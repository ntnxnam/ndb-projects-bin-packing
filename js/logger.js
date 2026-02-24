/**
 * Centralized logging for the application.
 * Use instead of console.* for consistent levels and optional production no-op.
 * @module logger
 */

import { DEBUG } from './config.js';

const noop = () => {};

/**
 * @typedef {'debug'|'info'|'warn'|'error'} LogLevel
 */

/**
 * Logger that respects DEBUG and level. In production (DEBUG false), debug is no-op.
 * @type {{ debug: function, info: function, warn: function, error: function }}
 */
export const logger = {
  debug: DEBUG ? (...args) => console.debug('[ndb]', ...args) : noop,
  info: (...args) => console.info('[ndb]', ...args),
  warn: (...args) => console.warn('[ndb]', ...args),
  error: (...args) => console.error('[ndb]', ...args),
};

export default logger;
