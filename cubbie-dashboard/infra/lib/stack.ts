import { CfnOutput, Duration, RemovalPolicy, SecretValue, Stack, type StackProps } from "aws-cdk-lib";
import { CorsHttpMethod, HttpApi, HttpMethod, WebSocketApi, WebSocketStage, type CfnStage } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpJwtAuthorizer } from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import { HttpLambdaIntegration, WebSocketLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { CfnBudget } from "aws-cdk-lib/aws-budgets";
import { Certificate } from "aws-cdk-lib/aws-certificatemanager";
import * as cf from "aws-cdk-lib/aws-cloudfront";
import { S3BucketOrigin } from "aws-cdk-lib/aws-cloudfront-origins";
import { Alarm, ComparisonOperator, TreatMissingData } from "aws-cdk-lib/aws-cloudwatch";
import { SnsAction } from "aws-cdk-lib/aws-cloudwatch-actions";
import * as cognito from "aws-cdk-lib/aws-cognito";
import { AttributeType, Billing, StreamViewType, TableEncryptionV2, TableV2 } from "aws-cdk-lib/aws-dynamodb";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import { Platform } from "aws-cdk-lib/aws-ecr-assets";
import { Effect, PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { StartingPosition } from "aws-cdk-lib/aws-lambda";
import { DynamoEventSource, SqsDlq } from "aws-cdk-lib/aws-lambda-event-sources";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { BlockPublicAccess, Bucket, BucketEncryption } from "aws-cdk-lib/aws-s3";
import { BucketDeployment, CacheControl, Source } from "aws-cdk-lib/aws-s3-deployment";
import { CfnSchedule, CfnScheduleGroup } from "aws-cdk-lib/aws-scheduler";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";
import { Topic } from "aws-cdk-lib/aws-sns";
import { EmailSubscription } from "aws-cdk-lib/aws-sns-subscriptions";
import { Queue, QueueEncryption } from "aws-cdk-lib/aws-sqs";
import type { Construct } from "constructs";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fn, ROOT } from "./fn.js";

export class CubbieDashboardStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);
    const ctx = (k: string) => this.node.tryGetContext(k);
    const stage: string = ctx("stage") ?? "prod";

    // ------------------------------------------------------------------ data
    const table = new TableV2(this, "Table", {
      partitionKey: { name: "PK", type: AttributeType.STRING },
      sortKey: { name: "SK", type: AttributeType.STRING },
      billing: Billing.onDemand(),
      timeToLiveAttribute: "ttl",
      dynamoStream: StreamViewType.NEW_AND_OLD_IMAGES,
      pointInTimeRecovery: true,
      encryption: TableEncryptionV2.awsManagedKey(),
      deletionProtection: stage === "prod",
      removalPolicy: stage === "prod" ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY
    });

    const discordSecret = new Secret(this, "DiscordSecret", {
      description: "Discord app credentials: {botToken, publicKey, applicationId}. Fill after deploy.",
      secretObjectValue: { botToken: SecretValue.unsafePlainText("REPLACE_ME"), publicKey: SecretValue.unsafePlainText("REPLACE_ME"), applicationId: SecretValue.unsafePlainText("REPLACE_ME") }
    });

    // ------------------------------------------------------------------ web hosting (S3 + CloudFront)
    const siteBucket = new Bucket(this, "Site", {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL, enforceSSL: true, encryption: BucketEncryption.S3_MANAGED,
      removalPolicy: RemovalPolicy.DESTROY, autoDeleteObjects: true
    });
    const customDomain: string = ctx("customDomain") ?? "";
    const certificateArn: string = ctx("certificateArn") ?? "";

    // Strict CSP: API + WebSocket + Cognito + Google Fonts only. Filled with real hosts below.
    const cspPlaceholder = "default-src 'self'";
    const headers = new cf.ResponseHeadersPolicy(this, "Headers", {
      securityHeadersBehavior: {
        contentSecurityPolicy: { contentSecurityPolicy: cspPlaceholder, override: true },
        strictTransportSecurity: { accessControlMaxAge: Duration.days(365), includeSubdomains: true, preload: true, override: true },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cf.HeadersFrameOption.DENY, override: true },
        referrerPolicy: { referrerPolicy: cf.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN, override: true }
      }
    });

    const distribution = new cf.Distribution(this, "Cdn", {
      defaultBehavior: {
        origin: S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: cf.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cf.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: headers,
        compress: true
      },
      defaultRootObject: "index.html",
      errorResponses: [403, 404].map(httpStatus => ({ httpStatus, responseHttpStatus: 200, responsePagePath: "/index.html", ttl: Duration.seconds(0) })),
      minimumProtocolVersion: cf.SecurityPolicyProtocol.TLS_V1_2_2021,
      priceClass: cf.PriceClass.PRICE_CLASS_100,
      ...(customDomain && certificateArn ? { domainNames: [customDomain], certificate: Certificate.fromCertificateArn(this, "Cert", certificateArn) } : {})
    });
    const webUrl = customDomain ? `https://${customDomain}` : `https://${distribution.distributionDomainName}`;

    // ------------------------------------------------------------------ auth (Cognito)
    const userPool = new cognito.UserPool(this, "Users", {
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: { email: { required: true, mutable: true }, givenName: { required: false, mutable: true } },
      passwordPolicy: { minLength: 10, requireSymbols: false },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: stage === "prod" ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY
    });
    const providers = [cognito.UserPoolClientIdentityProvider.COGNITO];
    const googleClientId: string = ctx("googleClientId") ?? "";
    let google: cognito.UserPoolIdentityProviderGoogle | undefined;
    if (googleClientId) {
      google = new cognito.UserPoolIdentityProviderGoogle(this, "Google", {
        userPool, clientId: googleClientId,
        clientSecretValue: SecretValue.secretsManager(ctx("googleClientSecretArn")),
        scopes: ["openid", "email", "profile"],
        attributeMapping: { email: cognito.ProviderAttribute.GOOGLE_EMAIL, givenName: cognito.ProviderAttribute.GOOGLE_GIVEN_NAME }
      });
      providers.push(cognito.UserPoolClientIdentityProvider.GOOGLE);
    }
    const domain = userPool.addDomain("Domain", { cognitoDomain: { domainPrefix: `cubbie-dashboard-${stage}-${this.account}` } });
    const allowedOrigins: string[] = ctx("allowedOrigins") ?? [];
    const client = userPool.addClient("Web", {
      generateSecret: false,
      authFlows: { userSrp: true },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls: [`${webUrl}/`, ...allowedOrigins.map(o => `${o}/`)],
        logoutUrls: [`${webUrl}/`, ...allowedOrigins.map(o => `${o}/`)]
      },
      supportedIdentityProviders: providers,
      idTokenValidity: Duration.hours(1), accessTokenValidity: Duration.hours(1), refreshTokenValidity: Duration.days(30),
      preventUserExistenceErrors: true
    });
    if (google) client.node.addDependency(google);
    const cognitoDomainUrl = domain.baseUrl();

    // ------------------------------------------------------------------ realtime (WebSocket API)
    const commonEnv = { TABLE_NAME: table.tableName, USER_POOL_ID: userPool.userPoolId, USER_POOL_CLIENT_ID: client.userPoolClientId, DISCORD_SECRET_ARN: discordSecret.secretArn };
    const wsConnect = fn(this, "WsConnect", "ws.ts", "connect", { environment: commonEnv });
    const wsDisconnect = fn(this, "WsDisconnect", "ws.ts", "disconnect", { environment: commonEnv });
    const wsMessage = fn(this, "WsMessage", "ws.ts", "message", { environment: commonEnv });
    const wsApi = new WebSocketApi(this, "Ws", {
      connectRouteOptions: { integration: new WebSocketLambdaIntegration("ConnectInt", wsConnect) },
      disconnectRouteOptions: { integration: new WebSocketLambdaIntegration("DisconnectInt", wsDisconnect) },
      defaultRouteOptions: { integration: new WebSocketLambdaIntegration("MessageInt", wsMessage) }
    });
    const wsStage = new WebSocketStage(this, "WsStage", { webSocketApi: wsApi, stageName: "prod", autoDeploy: true, throttle: { rateLimit: 50, burstLimit: 100 } });
    const wsEnv = { ...commonEnv, WS_MGMT_ENDPOINT: wsStage.callbackUrl };
    for (const f of [wsConnect, wsDisconnect, wsMessage]) { table.grantReadWriteData(f); wsStage.grantManagementApiAccess(f); f.addEnvironment("WS_MGMT_ENDPOINT", wsStage.callbackUrl); }

    // ------------------------------------------------------------------ reminders (EventBridge Scheduler)
    const scheduleGroup = new CfnScheduleGroup(this, "ReminderGroup", { name: `cubbie-reminders-${stage}` });
    const reminderFn = fn(this, "Reminder", "reminders.ts", "reminder", { environment: commonEnv });
    const briefFn = fn(this, "DailyBrief", "reminders.ts", "dailyBrief", { environment: commonEnv, timeout: Duration.minutes(5) });
    for (const f of [reminderFn, briefFn]) { table.grantReadData(f); discordSecret.grantRead(f); }
    const schedulerRole = new Role(this, "SchedulerRole", { assumedBy: new ServicePrincipal("scheduler.amazonaws.com") });
    reminderFn.grantInvoke(schedulerRole); briefFn.grantInvoke(schedulerRole);
    new CfnSchedule(this, "BriefSchedule", {
      groupName: scheduleGroup.name, flexibleTimeWindow: { mode: "FLEXIBLE", maximumWindowInMinutes: 10 },
      scheduleExpression: ctx("briefCron") ?? "cron(30 7 * * ? *)", scheduleExpressionTimezone: ctx("briefTimeZone") ?? "America/Phoenix",
      target: { arn: briefFn.functionArn, roleArn: schedulerRole.roleArn }
    }).addDependency(scheduleGroup);

    // ------------------------------------------------------------------ stream fan-out
    const dlq = new Queue(this, "FanoutDlq", { retentionPeriod: Duration.days(14), encryption: QueueEncryption.SQS_MANAGED, enforceSSL: true });
    const fanout = fn(this, "Fanout", "stream.ts", "handler", {
      environment: { ...wsEnv, REMINDER_TARGET_ARN: reminderFn.functionArn, SCHEDULER_ROLE_ARN: schedulerRole.roleArn, SCHEDULE_GROUP: scheduleGroup.name! },
      timeout: Duration.seconds(30)
    });
    table.grantReadWriteData(fanout); wsStage.grantManagementApiAccess(fanout);
    fanout.addToRolePolicy(new PolicyStatement({
      actions: ["scheduler:CreateSchedule", "scheduler:UpdateSchedule", "scheduler:DeleteSchedule"],
      resources: [`arn:${this.partition}:scheduler:${this.region}:${this.account}:schedule/${scheduleGroup.name}/*`]
    }));
    fanout.addToRolePolicy(new PolicyStatement({ actions: ["iam:PassRole"], resources: [schedulerRole.roleArn] }));
    fanout.addEventSource(new DynamoEventSource(table, {
      startingPosition: StartingPosition.LATEST, batchSize: 50, maxBatchingWindow: Duration.seconds(1),
      retryAttempts: 3, bisectBatchOnError: true, reportBatchItemFailures: true, onFailure: new SqsDlq(dlq)
    }));

    // ------------------------------------------------------------------ HTTP API
    const bedrockModelId: string = ctx("bedrockModelId") ?? "";
    const httpFn = fn(this, "Http", "http.ts", "handler", { environment: { ...wsEnv, BEDROCK_MODEL_ID: bedrockModelId, WEB_ORIGIN: webUrl }, timeout: Duration.seconds(29) });
    table.grantReadWriteData(httpFn); discordSecret.grantRead(httpFn); wsStage.grantManagementApiAccess(httpFn);
    if (bedrockModelId) httpFn.addToRolePolicy(new PolicyStatement({ effect: Effect.ALLOW, actions: ["bedrock:InvokeModel", "bedrock:Converse"], resources: ["*"] }));

    const ingestFn = fn(this, "Ingest", "ingest.ts", "handler", { environment: commonEnv, memorySize: 1024, timeout: Duration.seconds(29) });
    table.grantReadWriteData(ingestFn);
    const interactionsFn = fn(this, "DiscordInteractions", "discordInteractions.ts", "handler", { environment: commonEnv, timeout: Duration.seconds(3) });
    table.grantReadWriteData(interactionsFn); discordSecret.grantRead(interactionsFn);

    const httpApi = new HttpApi(this, "Api", {
      corsPreflight: {
        allowOrigins: [webUrl, ...allowedOrigins], allowHeaders: ["authorization", "content-type"],
        allowMethods: [CorsHttpMethod.GET, CorsHttpMethod.POST, CorsHttpMethod.PATCH, CorsHttpMethod.PUT, CorsHttpMethod.DELETE], maxAge: Duration.hours(1)
      }
    });
    (httpApi.defaultStage!.node.defaultChild as CfnStage).defaultRouteSettings = { throttlingRateLimit: 50, throttlingBurstLimit: 100 };
    const jwt = new HttpJwtAuthorizer("Cognito", `https://cognito-idp.${this.region}.amazonaws.com/${userPool.userPoolId}`, { jwtAudience: [client.userPoolClientId] });
    const httpInt = new HttpLambdaIntegration("HttpInt", httpFn);
    const authed: [HttpMethod, string][] = [
      [HttpMethod.GET, "/tasks"], [HttpMethod.POST, "/tasks"], [HttpMethod.PATCH, "/tasks/{id}"], [HttpMethod.DELETE, "/tasks/{id}"],
      [HttpMethod.GET, "/chat/messages"], [HttpMethod.POST, "/chat/messages"],
      [HttpMethod.GET, "/discord/messages"], [HttpMethod.POST, "/discord/messages"], [HttpMethod.POST, "/discord/link-code"], [HttpMethod.PUT, "/discord/channels"],
      [HttpMethod.GET, "/integrations/status"], [HttpMethod.POST, "/devices"], [HttpMethod.POST, "/ingest-keys"], [HttpMethod.PUT, "/profile"], [HttpMethod.POST, "/summary"]
    ];
    for (const [method, path] of authed) httpApi.addRoutes({ path, methods: [method], integration: httpInt, authorizer: jwt });
    httpApi.addRoutes({ path: "/ingest/cubbie", methods: [HttpMethod.POST], integration: new HttpLambdaIntegration("IngestInt", ingestFn) });
    httpApi.addRoutes({ path: "/discord/interactions", methods: [HttpMethod.POST], integration: new HttpLambdaIntegration("InteractionsInt", interactionsFn) });
    const apiUrl = httpApi.apiEndpoint;

    // Real CSP now that hosts are known.
    const csp = [
      "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src https://fonts.gstatic.com", "img-src 'self' data:",
      `connect-src 'self' ${apiUrl} ${wsApi.apiEndpoint} ${cognitoDomainUrl}`,
      "frame-ancestors 'none'", "base-uri 'self'", `form-action 'self' ${cognitoDomainUrl}`
    ].join("; ");
    (headers.node.defaultChild as cf.CfnResponseHeadersPolicy).addPropertyOverride(
      "ResponseHeadersPolicyConfig.SecurityHeadersConfig.ContentSecurityPolicy.ContentSecurityPolicy", csp);

    // ------------------------------------------------------------------ deploy the web build + runtime config
    const webDist = join(ROOT, "apps/web/dist");
    if (existsSync(webDist)) {
      new BucketDeployment(this, "DeployWeb", {
        destinationBucket: siteBucket, distribution, distributionPaths: ["/index.html", "/config.json"],
        sources: [
          Source.asset(webDist),
          Source.jsonData("config.json", { apiUrl, wsUrl: wsStage.url, cognitoDomain: cognitoDomainUrl, cognitoClientId: client.userPoolClientId, redirectUri: `${webUrl}/`, stage })
        ],
        cacheControl: [CacheControl.fromString("public, max-age=31536000, immutable")],
        prune: true, memoryLimit: 512
      });
    }

    // ------------------------------------------------------------------ Discord gateway bot (ECS Fargate)
    const botEnabled = String(ctx("discordBotEnabled")) === "true";
    const vpc = new ec2.Vpc(this, "Vpc", { maxAzs: 2, natGateways: 0, subnetConfiguration: [{ name: "public", subnetType: ec2.SubnetType.PUBLIC }] });
    const cluster = new ecs.Cluster(this, "Cluster", { vpc, containerInsights: false });
    const botTask = new ecs.FargateTaskDefinition(this, "BotTask", { cpu: 256, memoryLimitMiB: 512, runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.ARM64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX } });
    botTask.addContainer("bot", {
      image: ecs.ContainerImage.fromAsset(ROOT, { file: "services/discord-bot/Dockerfile", platform: Platform.LINUX_ARM64, exclude: ["**/node_modules", "**/cdk.out", "**/dist", ".git", "apps", "agents", "infra", "skills", "docs", "packages", "services/api"] }),
      environment: { TABLE_NAME: table.tableName, DISCORD_SECRET_ARN: discordSecret.secretArn },
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: "discord-bot", logGroup: new LogGroup(this, "BotLogs", { retention: RetentionDays.ONE_MONTH }) }),
      healthCheck: { command: ["CMD-SHELL", "node -e \"require('http').get('http://127.0.0.1:8080',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))\""], interval: Duration.seconds(30), startPeriod: Duration.seconds(30) }
    });
    table.grantReadWriteData(botTask.taskRole); discordSecret.grantRead(botTask.taskRole);
    new ecs.FargateService(this, "Bot", {
      cluster, taskDefinition: botTask, desiredCount: botEnabled ? 1 : 0, assignPublicIp: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC }, circuitBreaker: { rollback: true }, minHealthyPercent: 0, maxHealthyPercent: 100
    });

    // ------------------------------------------------------------------ observability + cost guardrails
    const alarmEmail: string = ctx("alarmEmail") ?? "";
    const topic = new Topic(this, "Alarms");
    if (alarmEmail) topic.addSubscription(new EmailSubscription(alarmEmail));
    const alarm = (id: string, a: Alarm) => { a.addAlarmAction(new SnsAction(topic)); return a; };
    for (const [id, f] of Object.entries({ Http: httpFn, Fanout: fanout, Ingest: ingestFn, WsMessage: wsMessage })) {
      alarm(`${id}Errors`, new Alarm(this, `${id}Errors`, { metric: f.metricErrors({ period: Duration.minutes(5) }), threshold: 5, evaluationPeriods: 1, treatMissingData: TreatMissingData.NOT_BREACHING }));
    }
    alarm("Dlq", new Alarm(this, "FanoutDlqDepth", { metric: dlq.metricApproximateNumberOfMessagesVisible(), threshold: 1, evaluationPeriods: 1, comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD }));
    if (alarmEmail) {
      new CfnBudget(this, "Budget", {
        budget: { budgetType: "COST", timeUnit: "MONTHLY", budgetLimit: { amount: Number(ctx("monthlyBudgetUsd") ?? 50), unit: "USD" } },
        notificationsWithSubscribers: [80, 100].map(threshold => ({
          notification: { notificationType: "ACTUAL", comparisonOperator: "GREATER_THAN", threshold, thresholdType: "PERCENTAGE" },
          subscribers: [{ subscriptionType: "EMAIL", address: alarmEmail }]
        }))
      });
    }

    // ------------------------------------------------------------------ outputs
    new CfnOutput(this, "WebUrl", { value: webUrl });
    new CfnOutput(this, "ApiUrl", { value: apiUrl, description: "Save in Cubbie's memory as the dashboard API URL" });
    new CfnOutput(this, "WebSocketUrl", { value: wsStage.url, description: "Paste into the iMessage relay setup" });
    new CfnOutput(this, "DiscordInteractionsUrl", { value: `${apiUrl}/discord/interactions`, description: "Discord developer portal > Interactions Endpoint URL" });
    new CfnOutput(this, "DiscordSecretArn", { value: discordSecret.secretArn });
    new CfnOutput(this, "UserPoolId", { value: userPool.userPoolId });
    new CfnOutput(this, "UserPoolClientId", { value: client.userPoolClientId });
    new CfnOutput(this, "CognitoDomain", { value: cognitoDomainUrl });
  }
}
