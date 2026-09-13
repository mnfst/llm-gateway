/**
 * Maximum number of fallback models/routes allowed on a single routing config
 * (default routing or a header tier).
 *
 * The fallback list is validated against this ceiling on the backend (DTOs) and
 * gated in the frontend UI. Keep a single source of truth here so the limit
 * cannot drift between the API and the UI.
 */
export const MAX_FALLBACKS = 100;
