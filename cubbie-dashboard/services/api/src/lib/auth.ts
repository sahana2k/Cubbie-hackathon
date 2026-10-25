import { createHash, randomBytes } from "node:crypto";
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import { env } from "./env";
import { HttpError } from "./http";

/** HTTP API routes sit behind the Cognito JWT authorizer; the verified claims arrive on the event. */
export function userFrom(event: APIGatewayProxyEventV2WithJWTAuthorizer): { sub: string; email?: string } {
  const claims = event.requestContext.authorizer?.jwt?.claims;
  const sub = claims?.sub as string | undefined;
  if (!sub) throw new HttpError(401, "Sign in to continue");
  return { sub, email: claims?.email as string | undefined };
}

let verifier: ReturnType<typeof CognitoJwtVerifier.create> | null = null;
/** WebSocket $connect has no JWT authorizer, so the browser's ID token is verified here. */
export async function verifyIdToken(token: string) {
  verifier ??= CognitoJwtVerifier.create({ userPoolId: env.userPoolId, clientId: env.userPoolClientId, tokenUse: "id" });
  const payload = await verifier.verify(token);
  return { sub: payload.sub, email: payload.email as string | undefined };
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
/** Long random secret shown to the student once; only its hash is stored. */
export const newSecret = (prefix: string) => `${prefix}_${randomBytes(24).toString("base64url")}`;
