import * as cdk from "aws-cdk-lib";
import * as iot from "aws-cdk-lib/aws-iot";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as cr from "aws-cdk-lib/custom-resources";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";

export class IoTCoreStack extends cdk.Stack {
	public readonly eventDataTable: dynamodb.Table;

	constructor(scope: Construct, id: string, props?: cdk.StackProps) {
		super(scope, id, props);

		// DynamoDB テーブル作成
		this.eventDataTable = new dynamodb.Table(this, "EventDataTable", {
			tableName: "EventData",
			partitionKey: {
				name: "PK",
				type: dynamodb.AttributeType.STRING,
			},
			sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
			billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
			removalPolicy: cdk.RemovalPolicy.DESTROY, // 開発用のため
		});

		this.eventDataTable.addGlobalSecondaryIndex({
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
		this.eventDataTable.addGlobalSecondaryIndex({
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

		const errorBucket = new s3.Bucket(this, "ErrorBucket", {
			bucketName: "aws-nfc-visits-management-error-logs",
			removalPolicy: cdk.RemovalPolicy.DESTROY, // ←ここをDESTROYに
			autoDeleteObjects: true,
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
							`arn:aws:iot:${this.region}:${this.account}:client/booth-*`,
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

		// IoT Rule用IAMロール
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
								"s3:PutObject",
								"s3:PutObjectAcl",
							],
							resources: [
								this.eventDataTable.tableArn,
								`${this.eventDataTable.tableArn}/index/*`,
								errorBucket.bucketArn,
								errorBucket.bucketArn + "/*",
							],
						}),
					],
				}),
			},
		});

		// IoT Rule作成（MQTTメッセージをDynamoDBに書き込む）
		const visitRule = new iot.CfnTopicRule(this, "VisitRule", {
			ruleName: "ProcessNFCVisits",
			topicRulePayload: {
				sql: "SELECT boothId, nfcUid, topic(3) as boothId, timestamp() as timestamp, newuuid() as visitId FROM 'nfc/visits/+'",
				description: "Process NFC visit data and store in DynamoDB",
				actions: [
					{
						dynamoDb: {
							tableName: this.eventDataTable.tableName,
							roleArn: iotRuleRole.roleArn,
							hashKeyField: "PK",
							hashKeyValue: "BOOTHS#${topic(3)}",
							rangeKeyField: "SK",
							rangeKeyValue: "RECORD#${timestamp()}",
						},
					},
				],
				errorAction: {
					s3: {
						bucketName: errorBucket.bucketName, // エラーログ用S3バケット名
						key: "iot-rule-errors/${timestamp()}-${UUID()}",
						roleArn: iotRuleRole.roleArn,
					},
				},
				ruleDisabled: false,
			},
		});

		// デバイス毎に証明書とアタッチメントを作成
		const policyAttachments: iot.CfnPolicyPrincipalAttachment[] = [];
		const thingAttachments: iot.CfnThingPrincipalAttachment[] = [];

		// S3バケット作成（バケット名はGo側と合わせること）
		const certBucket = new s3.Bucket(this, "CertKeyBucket", {
			bucketName: "aws-nfc-visits-management-certs",
			removalPolicy: cdk.RemovalPolicy.DESTROY, // ←ここをDESTROYに
			autoDeleteObjects: true,
		});

		// Lambda関数（Goコンテナイメージ）をデプロイ
		const certHandlerLambda = new lambda.DockerImageFunction(
			this,
			"CertHandlerLambda",
			{
				code: lambda.DockerImageCode.fromImageAsset(
					"../../services/cert_handler"
				),
				timeout: cdk.Duration.seconds(30),
				memorySize: 256,
				environment: {
					// 必要に応じて環境変数を指定
				},
				architecture: cdk.aws_lambda.Architecture.ARM_64,
			}
		);

		// LambdaにIoT証明書発行権限を付与
		certHandlerLambda.addToRolePolicy(
			new iam.PolicyStatement({
				actions: [
					"iot:CreateKeysAndCertificate",
					"iot:AttachPolicy",
					"iot:AttachThingPrincipal",
					"iot:CreatePolicy",
					"iot:DescribeCertificate",
					"iot:UpdateCertificate",
					"iot:ListPolicies",
					"iot:ListThings",
				],
				resources: ["*"], // 必要に応じて絞る
			})
		);
		// LambdaにS3書き込み権限を付与
		certHandlerLambda.addToRolePolicy(
			new iam.PolicyStatement({
				actions: ["s3:PutObject", "s3:PutObjectAcl"],
				resources: [certBucket.bucketArn + "/*"],
			})
		);

		// Custom Resource Provider
		const certProvider = new cr.Provider(
			this,
			"CertCustomResourceProvider",
			{
				onEventHandler: certHandlerLambda,
			}
		);

		// デバイスごとにCustom Resourceで証明書発行
		for (const config of deviceConfigs) {
			// IoT Thing作成
			const nfcThing = new iot.CfnThing(this, `NFCThing-${config.id}`, {
				thingName: config.id,
				attributePayload: { attributes: { boothId: config.id } },
			});

			// Custom Resourceで証明書発行
			const certResource = new cdk.CustomResource(
				this,
				`CustomCertResource-${config.id}`,
				{
					serviceToken: certProvider.serviceToken,
					properties: { BoothId: config.id },
				}
			);

			// Policyと証明書のアタッチメント
			new iot.CfnPolicyPrincipalAttachment(
				this,
				`PolicyAttachment-${config.id}`,
				{
					policyName: iotPolicy.policyName!,
					principal: certResource.getAttString("CertificateArn"),
				}
			);

			// Thingと証明書のアタッチメント
			new iot.CfnThingPrincipalAttachment(
				this,
				`ThingAttachment-${config.id}`,
				{
					thingName: nfcThing.thingName!,
					principal: certResource.getAttString("CertificateArn"),
				}
			);

			// 出力
			new cdk.CfnOutput(this, `CustomCertArn-${config.id}`, {
				value: certResource.getAttString("CertificateArn"),
				description: `Custom Resource Certificate ARN for ${config.id}`,
			});
		}

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
			value: this.eventDataTable.tableName,
			description: "DynamoDB Table Name",
		});

		// タグ付け
		cdk.Tags.of(this).add("Project", "NFCVisitManagement");
		cdk.Tags.of(this).add("Environment", "Development");
	}
}