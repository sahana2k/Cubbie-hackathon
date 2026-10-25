export const env = {
  table: process.env.TABLE_NAME ?? "",
  wsEndpoint: process.env.WS_MGMT_ENDPOINT ?? "",          // https://{id}.execute-api.{region}.amazonaws.com/{stage}
  userPoolId: process.env.USER_POOL_ID ?? "",
  userPoolClientId: process.env.USER_POOL_CLIENT_ID ?? "",
  discordSecretArn: process.env.DISCORD_SECRET_ARN ?? "",  // JSON: { botToken, publicKey, applicationId }
  reminderTargetArn: process.env.REMINDER_TARGET_ARN ?? "",
  schedulerRoleArn: process.env.SCHEDULER_ROLE_ARN ?? "",
  scheduleGroup: process.env.SCHEDULE_GROUP ?? "cubbie-reminders",
  bedrockModelId: process.env.BEDROCK_MODEL_ID ?? "",
  webOrigin: process.env.WEB_ORIGIN ?? "*"
};
