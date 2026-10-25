import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { ZodError, type ZodTypeAny, type z } from "zod";

export class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }

export const json = (status: number, body?: unknown): APIGatewayProxyResultV2 => ({
  statusCode: status,
  headers: { "content-type": "application/json" },
  body: body === undefined ? "" : JSON.stringify(body)
});

export function parseBody<S extends ZodTypeAny>(event: APIGatewayProxyEventV2, schema: S): z.infer<S> {
  let raw: unknown;
  try { raw = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body ?? "", "base64").toString() : event.body ?? "{}"); }
  catch { throw new HttpError(400, "Body must be JSON"); }
  return schema.parse(raw);
}

export function toResponse(err: unknown): APIGatewayProxyResultV2 {
  if (err instanceof HttpError) return json(err.status, { message: err.message });
  if (err instanceof ZodError) return json(400, { message: "Invalid input", issues: err.issues.map(i => ({ path: i.path.join("."), message: i.message })) });
  console.error(err);
  return json(500, { message: "Something went wrong on our side. Try again." });
}
