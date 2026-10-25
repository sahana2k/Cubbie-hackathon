/** The dashboard connects only to the Python server on this Mac. */
export interface RuntimeConfig { apiUrl?: string; localApi?: boolean }
export function config(): RuntimeConfig { return { apiUrl: '/api', localApi: true }; }
export async function loadRuntimeConfig() { /* No cloud configuration or authentication. */ }
