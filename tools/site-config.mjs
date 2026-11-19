/**
 * Canonical production site origin without a trailing slash.
 * Can be overridden via the SITE_ORIGIN environment variable (e.g. for preview deployments).
 *
 * @type {string}
 */
export const SITE_ORIGIN = process.env.SITE_ORIGIN || 'https://cartmancodes.com';
