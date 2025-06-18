import * as cdk from "aws-cdk-lib";
import * as iot from "aws-cdk-lib/aws-iot";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";

export class IoTCoreStack extends cdk.Stack {
	constructor(scope: Construct, id: string, props?: cdk.StackProps) {
		super(scope, id, props);

		// DynamoDB テーブル作成
		const eventDataTable = new dynamodb.Table(this, "EventDataTable", {
			tableName: "EventData",
			partitionKey: {
				name: "partitionKey",
				type: dynamodb.AttributeType.STRING,
			},
			sortKey: { name: "sortKey", type: dynamodb.AttributeType.STRING },
			billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
			removalPolicy: cdk.RemovalPolicy.DESTROY, // 開発用のため
		});

		eventDataTable.addGlobalSecondaryIndex({
			indexName: "GSI1-GenericQueries", // より汎用的なアクセスパターンをサポートする意味合い
			partitionKey: {
				name: "GSI_1_PK",
				type: dynamodb.AttributeType.STRING,
			},
			sortKey: {
				name: "GSI_1_SK",
				type: dynamodb.AttributeType.STRING,
			},
			projectionType: dynamodb.ProjectionType.ALL, // ここは本番では最適化を検討
			// 以下の設定は例です。本番環境ではThroughputの慎重な見積もりが必要です。
			// readCapacity: 1, // オンデマンドなので設定不要（プロビジョンドモードの場合）
			// writeCapacity: 1, // オンデマンドなので設定不要
		});

		// GSI2: 特定の日付の全訪問履歴を時系列で取得 (ブースを問わず)
		// PK: DATE#<YYYY-MM-DD>
		// SK: RECORD#<timestamp>
		eventDataTable.addGlobalSecondaryIndex({
			indexName: "VisitRecordsByDateAndTimestamp", // 日付とタイムスタンプでアクセスする来場記録
			partitionKey: {
				name: "GSI_2_PK",
				type: dynamodb.AttributeType.STRING,
			},
			sortKey: {
				name: "GSI_2_SK",
				type: dynamodb.AttributeType.STRING,
			},
			projectionType: dynamodb.ProjectionType.ALL, // ここは本番では最適化を検討
		});

		const deviceConfigs = [{ id: "booth-1" }, { id: "booth-2" }];

		// IoT Policy 作成（先に作成）
		const iotPolicy = new iot.CfnPolicy(this, "NFCIoTPolicy", {
			policyName: "NFCDevicePolicy",
			policyDocument: {
				Version: "2012-10-17",
				Statement: [
					{
						Effect: "Allow",
						Action: ["iot:Connect"],
						Resource: [
							`arn:aws:iot:${this.region}:${this.account}:client/nfc-reader-*`,
						],
					},
					{
						Effect: "Allow",
						Action: ["iot:Publish"],
						Resource: [
							`arn:aws:iot:${this.region}:${this.account}:topic/nfc/visits/*`,
						],
					},
					{
						Effect: "Allow",
						Action: ["iot:Subscribe"],
						Resource: [
							`arn:aws:iot:${this.region}:${this.account}:topicfilter/nfc/commands/*`,
						],
					},
					{
						Effect: "Allow",
						Action: ["iot:Receive"],
						Resource: [
							`arn:aws:iot:${this.region}:${this.account}:topic/nfc/commands/*`,
						],
					},
				],
			},
		});

		// デバイス毎に証明書とアタッチメントを作成
		const certificates: { [key: string]: iot.CfnCertificate } = {};
		const policyAttachments: iot.CfnPolicyPrincipalAttachment[] = [];
		const thingAttachments: iot.CfnThingPrincipalAttachment[] = [];

		for (const config of deviceConfigs) {
			// IoT Thing作成
			const nfcThing = new iot.CfnThing(this, `NFCThing-${config.id}`, {
				thingName: config.id,
				attributePayload: {
					attributes: {
						boothId: config.id,
					},
				},
			});

			// 証明書作成
			const certificate = new iot.CfnCertificate(
				this,
				`NFCReaderCertificate-${config.id}`,
				{
					status: "ACTIVE",
					certificateSigningRequest: undefined, // CDKが自動生成
				}
			);
			certificates[config.id] = certificate;

			// Policy と Certificate のアタッチメント
			const policyAttachment = new iot.CfnPolicyPrincipalAttachment(
				this,
				`PolicyAttachment-${config.id}`,
				{
					policyName: iotPolicy.policyName!,
					principal: certificate.attrArn,
				}
			);
			policyAttachments.push(policyAttachment);

			// Certificate と Thing のアタッチメント
			const thingAttachment = new iot.CfnThingPrincipalAttachment(
				this,
				`ThingAttachment-${config.id}`,
				{
					thingName: nfcThing.thingName!,
					principal: certificate.attrArn,
				}
			);
			thingAttachments.push(thingAttachment);

			// 証明書情報を出力
			new cdk.CfnOutput(this, `CertificateArn-${config.id}`, {
				value: certificate.attrArn,
				description: `Certificate ARN for ${config.id}`,
			});

			new cdk.CfnOutput(this, `CertificateId-${config.id}`, {
				value: certificate.ref,
				description: `Certificate ID for ${config.id}`,
			});
		}

		// IoT Role for Rule Action
		const iotRuleRole = new iam.Role(this, "IoTRuleRole", {
			assumedBy: new iam.ServicePrincipal("iot.amazonaws.com"),
			inlinePolicies: {
				DynamoDBAccess: new iam.PolicyDocument({
					statements: [
						new iam.PolicyStatement({
							effect: iam.Effect.ALLOW,
							actions: [
								"dynamodb:PutItem",
								"dynamodb:UpdateItem",
								"dynamodb:GetItem",
								"dynamodb:Query",
							],
							resources: [
								eventDataTable.tableArn,
								`${eventDataTable.tableArn}/index/*`,
							],
						}),
					],
				}),
			},
		});

		// IoT Rule 作成 - 訪問データをDynamoDBに保存
		const visitRule = new iot.CfnTopicRule(this, "VisitRule", {
			ruleName: "ProcessNFCVisits",
			topicRulePayload: {
				sql: "SELECT *, topic(3) as deviceId FROM 'nfc/visits/+'",
				description: "Process NFC visit data and store in DynamoDB",
				actions: [
					{
						dynamoDb: {
							tableName: eventDataTable.tableName,
							roleArn: iotRuleRole.roleArn,
							hashKeyField: "PK",
							hashKeyValue: "BOOTHS#${boothId}",
							rangeKeyField: "SK",
							rangeKeyValue: "RECORD#${timestamp}",
						},
					},
				],
				ruleDisabled: false,
			},
		});

		for (const config of deviceConfigs) {
			new cdk.CfnOutput(this, `IoTThingName-${config.id}`, {
				value: config.id,
				description: `IoT Thing Name for NFC Reader ${config.id}`,
			});
		}

		new cdk.CfnOutput(this, "IoTPolicyName", {
			value: iotPolicy.policyName!,
			description: "IoT Policy Name",
		});

		new cdk.CfnOutput(this, "DynamoDBTableName", {
			value: eventDataTable.tableName,
			description: "DynamoDB Table Name",
		});

		new cdk.CfnOutput(this, "IoTEndpoint", {
			value: `https://${this.account}.iot.${this.region}.amazonaws.com`,
			description: "IoT Core Endpoint",
		});

		// タグ付け
		cdk.Tags.of(this).add("Project", "NFCVisitManagement");
		cdk.Tags.of(this).add("Environment", "Development");
	}
}
