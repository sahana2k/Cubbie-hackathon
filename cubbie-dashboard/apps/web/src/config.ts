/** Runtime config. CDK writes /config.json next to index.html, so one build works in every stage. */
export interface RuntimeConfig { apiUrl?: string; wsUrl?: string; cognitoDomain?: string; cognitoClientId?: string; redirectUri?: string; stage?: string; localApi?: boolean }

declare global { interface Window { __CUBBIE_CONFIG__?: RuntimeConfig } }

const env = import.meta.env;
export function config(): RuntimeConfig {
  return {
    apiUrl: env.VITE_API_URL || undefined,
    wsUrl: env.VITE_WS_URL || undefined,
    cognitoDomain: env.VITE_COGNITO_DOMAIN || undefined,
    cognitoClientId: env.VITE_COGNITO_CLIENT_ID || undefined,
    redirectUri: env.VITE_REDIRECT_URI || undefined,
    ...(window.__CUBBIE_CONFIG__ ?? {})
  };
}

export async function loadRuntimeConfig() {
  if (env.MODE === "preview") return; // the shareable single-file preview always runs on demo data
  try {
    const res = await fetch("/config.json", { cache: "no-store" });
    if (res.ok && res.headers.get("content-type")?.includes("json")) window.__CUBBIE_CONFIG__ = await res.json();
  } catch { /* local dev without config.json: fall back to Vite env or demo mode */ }
}
