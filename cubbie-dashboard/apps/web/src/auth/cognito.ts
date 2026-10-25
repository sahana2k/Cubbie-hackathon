/**
 * Minimal Cognito Hosted UI sign-in (OAuth 2.0 authorization code + PKCE). No SDK needed.
 * Supports school email sign-up and "Continue with Google" when the Google IdP is enabled in CDK.
 */
import { config } from "../config";

const cfg = config();
const DOMAIN = cfg.cognitoDomain;            // e.g. https://cubbie-dashboard.auth.us-west-2.amazoncognito.com
const CLIENT_ID = cfg.cognitoClientId;
const REDIRECT = cfg.redirectUri ?? location.origin + "/";
const KEY = "cubbie.auth";

type Tokens = { id_token: string; access_token: string; refresh_token?: string; expires_at: number };

const b64url = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function read(): Tokens | null {
  try { const raw = sessionStorage.getItem(KEY); return raw ? (JSON.parse(raw) as Tokens) : null; } catch { return null; }
}
function write(t: Tokens) { try { sessionStorage.setItem(KEY, JSON.stringify(t)); } catch { /* ignore */ } }

export async function signIn() {
  if (!DOMAIN || !CLIENT_ID) throw new Error("Cognito is not configured");
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)).buffer);
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)).buffer);
  sessionStorage.setItem("cubbie.pkce", JSON.stringify({ verifier, state }));
  const q = new URLSearchParams({ response_type: "code", client_id: CLIENT_ID, redirect_uri: REDIRECT, scope: "openid email profile", code_challenge_method: "S256", code_challenge: challenge, state });
  location.assign(`${DOMAIN}/oauth2/authorize?${q}`);
}

export function signOut() {
  sessionStorage.removeItem(KEY);
  if (DOMAIN && CLIENT_ID) location.assign(`${DOMAIN}/logout?client_id=${CLIENT_ID}&logout_uri=${encodeURIComponent(REDIRECT)}`);
}

async function tokenRequest(body: Record<string, string>) {
  const res = await fetch(`${DOMAIN}/oauth2/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: CLIENT_ID!, ...body }) });
  if (!res.ok) throw new Error("Sign-in failed. Try again.");
  const j = await res.json();
  const t: Tokens = { id_token: j.id_token, access_token: j.access_token, refresh_token: j.refresh_token ?? read()?.refresh_token, expires_at: Date.now() + (j.expires_in - 60) * 1000 };
  write(t); return t;
}

/** Call once on load: finishes the redirect if there is a ?code=. Returns true when signed in. */
export async function completeSignIn(): Promise<boolean> {
  if (!DOMAIN) return true; // demo mode
  const url = new URL(location.href);
  const code = url.searchParams.get("code");
  if (code) {
    const saved = JSON.parse(sessionStorage.getItem("cubbie.pkce") ?? "{}");
    if (saved.state !== url.searchParams.get("state")) throw new Error("Sign-in state mismatch");
    await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: saved.verifier });
    sessionStorage.removeItem("cubbie.pkce");
    history.replaceState(null, "", url.pathname);
  }
  return !!read();
}

export async function getIdToken(): Promise<string> {
  let t = read();
  if (!t) { await signIn(); throw new Error("Redirecting to sign-in"); }
  if (Date.now() > t.expires_at && t.refresh_token) t = await tokenRequest({ grant_type: "refresh_token", refresh_token: t.refresh_token });
  return t.id_token;
}

export function currentUser(): { email?: string; name?: string } | null {
  const t = read(); if (!t) return null;
  try { const p = JSON.parse(atob(t.id_token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))); return { email: p.email, name: p.name ?? p.given_name }; } catch { return null; }
}
