import { App, Tags } from "aws-cdk-lib";
import { CubbieDashboardStack } from "../lib/stack.js";

const app = new App();
const stage = app.node.tryGetContext("stage") ?? "prod";
const stack = new CubbieDashboardStack(app, `CubbieDashboard-${stage}`, {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION ?? "us-west-2" },
  description: "Cubbie Dashboard: board + iMessage relay + Discord, serverless on AWS"
});
Tags.of(stack).add("app", "cubbie-dashboard");
Tags.of(stack).add("stage", stage);
