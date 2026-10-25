import { Duration } from "aws-cdk-lib";
import { Architecture, LoggingFormat, Runtime, Tracing } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction, type NodejsFunctionProps } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import type { Construct } from "constructs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
export const API_SRC = join(ROOT, "services/api/src/handlers");

/** House defaults for every Lambda: Node 20 on Graviton, bundled with esbuild, JSON logs, X-Ray, 30-day logs. */
export function fn(scope: Construct, id: string, file: string, handler: string, props: Partial<NodejsFunctionProps> = {}) {
  return new NodejsFunction(scope, id, {
    entry: join(API_SRC, file),
    handler,
    runtime: Runtime.NODEJS_20_X,
    architecture: Architecture.ARM_64,
    memorySize: 512,
    timeout: Duration.seconds(15),
    tracing: Tracing.ACTIVE,
    loggingFormat: LoggingFormat.JSON,
    logGroup: new LogGroup(scope, `${id}Logs`, { retention: RetentionDays.ONE_MONTH }),
    projectRoot: ROOT,
    depsLockFilePath: join(ROOT, "pnpm-lock.yaml"),
    bundling: { minify: true, sourceMap: true, target: "node20", externalModules: [] },
    ...props,
    environment: { NODE_OPTIONS: "--enable-source-maps", ...(props.environment ?? {}) }
  });
}
