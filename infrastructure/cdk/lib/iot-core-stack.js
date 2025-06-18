"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.IoTCoreStack = void 0;
const cdk = __importStar(require("aws-cdk-lib"));
const iot = __importStar(require("aws-cdk-lib/aws-iot"));
const dynamodb = __importStar(require("aws-cdk-lib/aws-dynamodb"));
const iam = __importStar(require("aws-cdk-lib/aws-iam"));
class IoTCoreStack extends cdk.Stack {
    constructor(scope, id, props) {
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
        const certificates = {};
        const policyAttachments = [];
        const thingAttachments = [];
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
            const certificate = new iot.CfnCertificate(this, `NFCCertificate-${config.id}`, {
                status: 'ACTIVE',
                certificateSigningRequest: undefined, // CDKが自動生成
            });
            certificates[config.id] = certificate;
            // Policy と Certificate のアタッチメント
            const policyAttachment = new iot.CfnPolicyPrincipalAttachment(this, `PolicyAttachment-${config.id}`, {
                policyName: iotPolicy.policyName,
                principal: certificate.attrArn,
            });
            policyAttachments.push(policyAttachment);
            // Certificate と Thing のアタッチメント
            const thingAttachment = new iot.CfnThingPrincipalAttachment(this, `ThingAttachment-${config.id}`, {
                thingName: nfcThing.thingName,
                principal: certificate.attrArn,
            });
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
            value: iotPolicy.policyName,
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
exports.IoTCoreStack = IoTCoreStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW90LWNvcmUtc3RhY2suanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJpb3QtY29yZS1zdGFjay50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUFBLGlEQUFtQztBQUNuQyx5REFBMkM7QUFDM0MsbUVBQXFEO0FBQ3JELHlEQUEyQztBQUczQyxNQUFhLFlBQWEsU0FBUSxHQUFHLENBQUMsS0FBSztJQUMxQyxZQUFZLEtBQWdCLEVBQUUsRUFBVSxFQUFFLEtBQXNCO1FBQy9ELEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxFQUFFLEtBQUssQ0FBQyxDQUFDO1FBRXhCLGtCQUFrQjtRQUNsQixNQUFNLGNBQWMsR0FBRyxJQUFJLFFBQVEsQ0FBQyxLQUFLLENBQUMsSUFBSSxFQUFFLGdCQUFnQixFQUFFO1lBQ2pFLFNBQVMsRUFBRSxXQUFXO1lBQ3RCLFlBQVksRUFBRTtnQkFDYixJQUFJLEVBQUUsY0FBYztnQkFDcEIsSUFBSSxFQUFFLFFBQVEsQ0FBQyxhQUFhLENBQUMsTUFBTTthQUNuQztZQUNELE9BQU8sRUFBRSxFQUFFLElBQUksRUFBRSxTQUFTLEVBQUUsSUFBSSxFQUFFLFFBQVEsQ0FBQyxhQUFhLENBQUMsTUFBTSxFQUFFO1lBQ2pFLFdBQVcsRUFBRSxRQUFRLENBQUMsV0FBVyxDQUFDLGVBQWU7WUFDakQsYUFBYSxFQUFFLEdBQUcsQ0FBQyxhQUFhLENBQUMsT0FBTyxFQUFFLFNBQVM7U0FDbkQsQ0FBQyxDQUFDO1FBRUgsY0FBYyxDQUFDLHVCQUF1QixDQUFDO1lBQ3RDLFNBQVMsRUFBRSxxQkFBcUIsRUFBRSw0QkFBNEI7WUFDOUQsWUFBWSxFQUFFO2dCQUNiLElBQUksRUFBRSxVQUFVO2dCQUNoQixJQUFJLEVBQUUsUUFBUSxDQUFDLGFBQWEsQ0FBQyxNQUFNO2FBQ25DO1lBQ0QsT0FBTyxFQUFFO2dCQUNSLElBQUksRUFBRSxVQUFVO2dCQUNoQixJQUFJLEVBQUUsUUFBUSxDQUFDLGFB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QUM7UUFFSCxLQUFLLE1BQU0sTUFBTSxJQUFJLGFBQWEsRUFBRSxDQUFDO1lBQ3BDLElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUsZ0JBQWdCLE1BQU0sQ0FBQyxFQUFFLEVBQUUsRUFBRTtnQkFDcEQsS0FBSyxFQUFFLE1BQU0sQ0FBQyxFQUFFO2dCQUNoQixXQUFXLEVBQUUsaUNBQWlDLE1BQU0sQ0FBQyxFQUFFLEVBQUU7YUFDekQsQ0FBQyxDQUFDO1FBQ0osQ0FBQztRQUVELElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUsZUFBZSxFQUFFO1lBQ3hDLEtBQUssRUFBRSxTQUFTLENBQUMsVUFBVztZQUM1QixXQUFXLEVBQUUsaUJBQWlCO1NBQzlCLENBQUMsQ0FBQztRQUVILElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUsbUJBQW1CLEVBQUU7WUFDNUMsS0FBSyxFQUFFLGNBQWMsQ0FBQyxTQUFTO1lBQy9CLFdBQVcsRUFBRSxxQkFBcUI7U0FDbEMsQ0FBQyxDQUFDO1FBRUgsSUFBSSxHQUFHLENBQUMsU0FBUyxDQUFDLElBQUksRUFBRSxhQUFhLEVBQUU7WUFDdEMsS0FBSyxFQUFFLFdBQVcsSUFBSSxDQUFDLE9BQU8sUUFBUSxJQUFJLENBQUMsTUFBTSxnQkFBZ0I7WUFDakUsV0FBVyxFQUFFLG1CQUFtQjtTQUNoQyxDQUFDLENBQUM7UUFFSCxPQUFPO1FBQ1AsR0FBRyxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUMsSUFBSSxDQUFDLENBQUMsR0FBRyxDQUFDLFNBQVMsRUFBRSxvQkFBb0IsQ0FBQyxDQUFDO1FBQ3ZELEdBQUcsQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDLElBQUksQ0FBQyxDQUFDLEdBQUcsQ0FBQyxhQUFhLEVBQUUsYUFBYSxDQUFDLENBQUM7SUFDckQsQ0FBQztDQUNEO0FBak5ELG9DQWlOQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCAqIGFzIGNkayBmcm9tIFwiYXdzLWNkay1saWJcIjtcbmltcG9ydCAqIGFzIGlvdCBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWlvdFwiO1xuaW1wb3J0ICogYXMgZHluYW1vZGIgZnJvbSBcImF3cy1jZGstbGliL2F3cy1keW5hbW9kYlwiO1xuaW1wb3J0ICogYXMgaWFtIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtaWFtXCI7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tIFwiY29uc3RydWN0c1wiO1xuXG5leHBvcnQgY2xhc3MgSW9UQ29yZVN0YWNrIGV4dGVuZHMgY2RrLlN0YWNrIHtcblx0Y29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM/OiBjZGsuU3RhY2tQcm9wcykge1xuXHRcdHN1cGVyKHNjb3BlLCBpZCwgcHJvcHMpO1xuXG5cdFx0Ly8gRHluYW1vREIg44OG44O844OW44Or5L2c5oiQXG5cdFx0Y29uc3QgZXZlbnREYXRhVGFibGUgPSBuZXcgZHluYW1vZGIuVGFibGUodGhpcywgXCJFdmVudERhdGFUYWJsZVwiLCB7XG5cdFx0XHR0YWJsZU5hbWU6IFwiRXZlbnREYXRhXCIsXG5cdFx0XHRwYXJ0aXRpb25LZXk6IHtcblx0XHRcdFx0bmFtZTogXCJwYXJ0aXRpb25LZXlcIixcblx0XHRcdFx0dHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcsXG5cdFx0XHR9LFxuXHRcdFx0c29ydEtleTogeyBuYW1lOiBcInNvcnRLZXlcIiwgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcgfSxcblx0XHRcdGJpbGxpbmdNb2RlOiBkeW5hbW9kYi5CaWxsaW5nTW9kZS5QQVlfUEVSX1JFUVVFU1QsXG5cdFx0XHRyZW1vdmFsUG9saWN5OiBjZGsuUmVtb3ZhbFBvbGljeS5ERVNUUk9ZLCAvLyDplovnmbrnlKjjga7jgZ/jgoFcblx0XHR9KTtcblxuXHRcdGV2ZW50RGF0YVRhYmxlLmFkZEdsb2JhbFNlY29uZGFyeUluZGV4KHtcblx0XHRcdGluZGV4TmFtZTogXCJHU0kxLUdlbmVyaWNRdWVyaWVzXCIsIC8vIOOCiOOCiuaxjueUqOeahOOBquOCouOCr+OCu+OCueODkeOCv+ODvOODs+OCkuOCteODneODvOODiOOBmeOCi+aEj+WRs+WQiOOBhFxuXHRcdFx0cGFydGl0aW9uS2V5OiB7XG5cdFx0XHRcdG5hbWU6IFwiR1NJXzFfUEtcIixcblx0XHRcdFx0dHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcsXG5cdFx0XHR9LFxuXHRcdFx0c29ydEtleToge1xuXHRcdFx0XHRuYW1lOiBcIkdTSV8xX1NLXCIsXG5cdFx0XHRcdHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuU1RSSU5HLFxuXHRcdFx0fSxcblx0XHRcdHByb2plY3Rpb25UeXBlOiBkeW5hbW9kYi5Qcm9qZWN0aW9uVHlwZS5BTEwsIC8vIOOBk+OBk+OBr+acrOeVquOBp+OBr+acgOmBqeWMluOCkuaknOiojlxuXHRcdFx0Ly8g5Lul5LiL44Gu6Kit5a6a44Gv5L6L44Gn44GZ44CC5pys55Wq55Kw5aKD44Gn44GvVGhyb3VnaHB1dOOBruaFjumHjeOBquimi+epjeOCguOCiuOBjOW/heimgeOBp+OBmeOAglxuXHRcdFx0Ly8gcmVhZENhcGFjaXR5OiAxLCAvLyDjgqrjg7Pjg4fjg57jg7Pjg4njgarjga7jgafoqK3lrprkuI3opoHvvIjjg5fjg63jg5Pjgrjjg6fjg7Pjg4njg6Ljg7zjg4njga7loLTlkIjvvIlcblx0XHRcdC8vIHdyaXRlQ2FwYWNpdHk6IDEsIC8vIOOCquODs+ODh+ODnuODs+ODieOBquOBruOBp+ioreWumuS4jeimgVxuXHRcdH0pO1xuXG5cdFx0Ly8gR1NJMjog54m55a6a44Gu5pel5LuY44Gu5YWo6Kiq5ZWP5bGl5q2044KS5pmC57O75YiX44Gn5Y+W5b6XICjjg5bjg7zjgrnjgpLllY/jgo/jgZopXG5cdFx0Ly8gUEs6IERBVEUjPFlZWVktTU0tREQ+XG5cdFx0Ly8gU0s6IFJFQ09SRCM8dGltZXN0YW1wPlxuXHRcdGV2ZW50RGF0YVRhYmxlLmFkZEdsb2JhbFNlY29uZGFyeUluZGV4KHtcblx0XHRcdGluZGV4TmFtZTogXCJWaXNpdFJlY29yZHNCeURhdGVBbmRUaW1lc3RhbXBcIiwgLy8g5pel5LuY44Go44K/44Kk44Og44K544K/44Oz44OX44Gn44Ki44Kv44K744K544GZ44KL5p2l5aC06KiY6YyyXG5cdFx0XHRwYXJ0aXRpb25LZXk6IHtcblx0XHRcdFx0bmFtZTogXCJHU0lfMl9QS1wiLFxuXHRcdFx0XHR0eXBlOiBkeW5hbW9kYi5BdHRyaWJ1dGVUeXBlLlNUUklORyxcblx0XHRcdH0sXG5cdFx0XHRzb3J0S2V5OiB7XG5cdFx0XHRcdG5hbWU6IFwiR1NJXzJfU0tcIixcblx0XHRcdFx0dHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcsXG5cdFx0XHR9LFxuXHRcdFx0cHJvamVjdGlvblR5cGU6IGR5bmFtb2RiLlByb2plY3Rpb25UeXBlLkFMTCwgLy8g44GT44GT44Gv5pys55Wq44Gn44Gv5pyA6YGp5YyW44KS5qSc6KiOXG5cdFx0fSk7XG5cblx0XHRjb25zdCBkZXZpY2VDb25maWdzID0gW3sgaWQ6IFwiYm9vdGgtMVwiIH0sIHsgaWQ6IFwiYm9vdGgtMlwiIH1dO1xuXG5cdFx0Ly8gSW9UIFBvbGljeSDkvZzmiJDvvIjlhYjjgavkvZzmiJDvvIlcblx0XHRjb25zdCBpb3RQb2xpY3kgPSBuZXcgaW90LkNmblBvbGljeSh0aGlzLCBcIk5GQ0lvVFBvbGljeVwiLCB7XG5cdFx0XHRwb2xpY3lOYW1lOiBcIk5GQ0RldmljZVBvbGljeVwiLFxuXHRcdFx0cG9saWN5RG9jdW1lbnQ6IHtcblx0XHRcdFx0VmVyc2lvbjogXCIyMDEyLTEwLTE3XCIsXG5cdFx0XHRcdFN0YXRlbWVudDogW1xuXHRcdFx0XHRcdHtcblx0XHRcdFx0XHRcdEVmZmVjdDogXCJBbGxvd1wiLFxuXHRcdFx0XHRcdFx0QWN0aW9uOiBbXCJpb3Q6Q29ubmVjdFwiXSxcblx0XHRcdFx0XHRcdFJlc291cmNlOiBbXG5cdFx0XHRcdFx0XHRcdGBhcm46YXdzOmlvdDoke3RoaXMucmVnaW9ufToke3RoaXMuYWNjb3VudH06Y2xpZW50L25mYy1yZWFkZXItKmAsXG5cdFx0XHRcdFx0XHRdLFxuXHRcdFx0XHRcdH0sXG5cdFx0XHRcdFx0e1xuXHRcdFx0XHRcdFx0RWZmZWN0OiBcIkFsbG93XCIsXG5cdFx0XHRcdFx0XHRBY3Rpb246IFtcImlvdDpQdWJsaXNoXCJdLFxuXHRcdFx0XHRcdFx0UmVzb3VyY2U6IFtcblx0XHRcdFx0XHRcdFx0YGFybjphd3M6aW90OiR7dGhpcy5yZWdpb259OiR7dGhpcy5hY2NvdW50fTp0b3BpYy9uZmMvdmlzaXRzLypgLFxuXHRcdFx0XHRcdFx0XSxcblx0XHRcdFx0XHR9LFxuXHRcdFx0XHRcdHtcblx0XHRcdFx0XHRcdEVmZmVjdDogXCJBbGxvd1wiLFxuXHRcdFx0XHRcdFx0QWN0aW9uOiBbXCJpb3Q6U3Vic2NyaWJlXCJdLFxuXHRcdFx0XHRcdFx0UmVzb3VyY2U6IFtcblx0XHRcdFx0XHRcdFx0YGFybjphd3M6aW90OiR7dGhpcy5yZWdpb259OiR7dGhpcy5hY2NvdW50fTp0b3BpY2ZpbHRlci9uZmMvY29tbWFuZHMvKmAsXG5cdFx0XHRcdFx0XHRdLFxuXHRcdFx0XHRcdH0sXG5cdFx0XHRcdFx0e1xuXHRcdFx0XHRcdFx0RWZmZWN0OiBcIkFsbG93XCIsXG5cdFx0XHRcdFx0XHRBY3Rpb246IFtcImlvdDpSZWNlaXZlXCJdLFxuXHRcdFx0XHRcdFx0UmVzb3VyY2U6IFtcblx0XHRcdFx0XHRcdFx0YGFybjphd3M6aW90OiR7dGhpcy5yZWdpb259OiR7dGhpcy5hY2NvdW50fTp0b3BpYy9uZmMvY29tbWFuZHMvKmAsXG5cdFx0XHRcdFx0XHRdLFxuXHRcdFx0XHRcdH0sXG5cdFx0XHRcdF0sXG5cdFx0XHR9LFxuXHRcdH0pO1xuXG5cdFx0Ly8g44OH44OQ44Kk44K55q+O44Gr6Ki85piO5pu444Go44Ki44K/44OD44OB44Oh44Oz44OI44KS5L2c5oiQXG5cdFx0Y29uc3QgY2VydGlmaWNhdGVzOiB7IFtrZXk6IHN0cmluZ106IGlvdC5DZm5DZXJ0aWZpY2F0ZSB9ID0ge307XG5cdFx0Y29uc3QgcG9saWN5QXR0YWNobWVudHM6IGlvdC5DZm5Qb2xpY3lQcmluY2lwYWxBdHRhY2htZW50W10gPSBbXTtcblx0XHRjb25zdCB0aGluZ0F0dGFjaG1lbnRzOiBpb3QuQ2ZuVGhpbmdQcmluY2lwYWxBdHRhY2htZW50W10gPSBbXTtcblxuXHRcdGZvciAoY29uc3QgY29uZmlnIG9mIGRldmljZUNvbmZpZ3MpIHtcblx0XHRcdC8vIElvVCBUaGluZ+S9nOaIkFxuXHRcdFx0Y29uc3QgbmZjVGhpbmcgPSBuZXcgaW90LkNmblRoaW5nKHRoaXMsIGBORkNUaGluZy0ke2NvbmZpZy5pZH1gLCB7XG5cdFx0XHRcdHRoaW5nTmFtZTogY29uZmlnLmlkLFxuXHRcdFx0XHRhdHRyaWJ1dGVQYXlsb2FkOiB7XG5cdFx0XHRcdFx0YXR0cmlidXRlczoge1xuXHRcdFx0XHRcdFx0Ym9vdGhJZDogY29uZmlnLmlkLFxuXHRcdFx0XHRcdH0sXG5cdFx0XHRcdH0sXG5cdFx0XHR9KTtcblxuXHRcdFx0Ly8g6Ki85piO5pu45L2c5oiQXG5cdFx0XHRjb25zdCBjZXJ0aWZpY2F0ZSA9IG5ldyBpb3QuQ2ZuQ2VydGlmaWNhdGUodGhpcywgYE5GQ0NlcnRpZmljYXRlLSR7Y29uZmlnLmlkfWAsIHtcblx0XHRcdFx0c3RhdHVzOiAnQUNUSVZFJyxcblx0XHRcdFx0Y2VydGlmaWNhdGVTaWduaW5nUmVxdWVzdDogdW5kZWZpbmVkLCAvLyBDREvjgYzoh6rli5XnlJ/miJBcblx0XHRcdH0pO1xuXHRcdFx0Y2VydGlmaWNhdGVzW2NvbmZpZy5pZF0gPSBjZXJ0aWZpY2F0ZTtcblxuXHRcdFx0Ly8gUG9saWN5IOOBqCBDZXJ0aWZpY2F0ZSDjga7jgqLjgr/jg4Pjg4Hjg6Hjg7Pjg4hcblx0XHRcdGNvbnN0IHBvbGljeUF0dGFjaG1lbnQgPSBuZXcgaW90LkNmblBvbGljeVByaW5jaXBhbEF0dGFjaG1lbnQodGhpcywgYFBvbGljeUF0dGFjaG1lbnQtJHtjb25maWcuaWR9YCwge1xuXHRcdFx0XHRwb2xpY3lOYW1lOiBpb3RQb2xpY3kucG9saWN5TmFtZSEsXG5cdFx0XHRcdHByaW5jaXBhbDogY2VydGlmaWNhdGUuYXR0ckFybixcblx0XHRcdH0pO1xuXHRcdFx0cG9saWN5QXR0YWNobWVudHMucHVzaChwb2xpY3lBdHRhY2htZW50KTtcblxuXHRcdFx0Ly8gQ2VydGlmaWNhdGUg44GoIFRoaW5nIOOBruOCouOCv+ODg+ODgeODoeODs+ODiFxuXHRcdFx0Y29uc3QgdGhpbmdBdHRhY2htZW50ID0gbmV3IGlvdC5DZm5UaGluZ1ByaW5jaXBhbEF0dGFjaG1lbnQodGhpcywgYFRoaW5nQXR0YWNobWVudC0ke2NvbmZpZy5pZH1gLCB7XG5cdFx0XHRcdHRoaW5nTmFtZTogbmZjVGhpbmcudGhpbmdOYW1lISxcblx0XHRcdFx0cHJpbmNpcGFsOiBjZXJ0aWZpY2F0ZS5hdHRyQXJuLFxuXHRcdFx0fSk7XG5cdFx0XHR0aGluZ0F0dGFjaG1lbnRzLnB1c2godGhpbmdBdHRhY2htZW50KTtcblxuXHRcdFx0Ly8g6Ki85piO5pu45oOF5aCx44KS5Ye65YqbXG5cdFx0XHRuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCBgQ2VydGlmaWNhdGVBcm4tJHtjb25maWcuaWR9YCwge1xuXHRcdFx0XHR2YWx1ZTogY2VydGlmaWNhdGUuYXR0ckFybixcblx0XHRcdFx0ZGVzY3JpcHRpb246IGBDZXJ0aWZpY2F0ZSBBUk4gZm9yICR7Y29uZmlnLmlkfWAsXG5cdFx0XHR9KTtcblxuXHRcdFx0bmV3IGNkay5DZm5PdXRwdXQodGhpcywgYENlcnRpZmljYXRlSWQtJHtjb25maWcuaWR9YCwge1xuXHRcdFx0XHR2YWx1ZTogY2VydGlmaWNhdGUucmVmLFxuXHRcdFx0XHRkZXNjcmlwdGlvbjogYENlcnRpZmljYXRlIElEIGZvciAke2NvbmZpZy5pZH1gLFxuXHRcdFx0fSk7XG5cdFx0fVxuXG5cdFx0Ly8gSW9UIFJvbGUgZm9yIFJ1bGUgQWN0aW9uXG5cdFx0Y29uc3QgaW90UnVsZVJvbGUgPSBuZXcgaWFtLlJvbGUodGhpcywgXCJJb1RSdWxlUm9sZVwiLCB7XG5cdFx0XHRhc3N1bWVkQnk6IG5ldyBpYW0uU2VydmljZVByaW5jaXBhbChcImlvdC5hbWF6b25hd3MuY29tXCIpLFxuXHRcdFx0aW5saW5lUG9saWNpZXM6IHtcblx0XHRcdFx0RHluYW1vREJBY2Nlc3M6IG5ldyBpYW0uUG9saWN5RG9jdW1lbnQoe1xuXHRcdFx0XHRcdHN0YXRlbWVudHM6IFtcblx0XHRcdFx0XHRcdG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcblx0XHRcdFx0XHRcdFx0ZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxuXHRcdFx0XHRcdFx0XHRhY3Rpb25zOiBbXG5cdFx0XHRcdFx0XHRcdFx0XCJkeW5hbW9kYjpQdXRJdGVtXCIsXG5cdFx0XHRcdFx0XHRcdFx0XCJkeW5hbW9kYjpVcGRhdGVJdGVtXCIsXG5cdFx0XHRcdFx0XHRcdFx0XCJkeW5hbW9kYjpHZXRJdGVtXCIsXG5cdFx0XHRcdFx0XHRcdFx0XCJkeW5hbW9kYjpRdWVyeVwiLFxuXHRcdFx0XHRcdFx0XHRdLFxuXHRcdFx0XHRcdFx0XHRyZXNvdXJjZXM6IFtcblx0XHRcdFx0XHRcdFx0XHRldmVudERhdGFUYWJsZS50YWJsZUFybixcblx0XHRcdFx0XHRcdFx0XHRgJHtldmVudERhdGFUYWJsZS50YWJsZUFybn0vaW5kZXgvKmAsXG5cdFx0XHRcdFx0XHRcdF0sXG5cdFx0XHRcdFx0XHR9KSxcblx0XHRcdFx0XHRdLFxuXHRcdFx0XHR9KSxcblx0XHRcdH0sXG5cdFx0fSk7XG5cblx0XHQvLyBJb1QgUnVsZSDkvZzmiJAgLSDoqKrllY/jg4fjg7zjgr/jgpJEeW5hbW9EQuOBq+S/neWtmFxuXHRcdGNvbnN0IHZpc2l0UnVsZSA9IG5ldyBpb3QuQ2ZuVG9waWNSdWxlKHRoaXMsIFwiVmlzaXRSdWxlXCIsIHtcblx0XHRcdHJ1bGVOYW1lOiBcIlByb2Nlc3NORkNWaXNpdHNcIixcblx0XHRcdHRvcGljUnVsZVBheWxvYWQ6IHtcblx0XHRcdFx0c3FsOiBcIlNFTEVDVCAqLCB0b3BpYygzKSBhcyBkZXZpY2VJZCBGUk9NICduZmMvdmlzaXRzLysnXCIsXG5cdFx0XHRcdGRlc2NyaXB0aW9uOiBcIlByb2Nlc3MgTkZDIHZpc2l0IGRhdGEgYW5kIHN0b3JlIGluIER5bmFtb0RCXCIsXG5cdFx0XHRcdGFjdGlvbnM6IFtcblx0XHRcdFx0XHR7XG5cdFx0XHRcdFx0XHRkeW5hbW9EYjoge1xuXHRcdFx0XHRcdFx0XHR0YWJsZU5hbWU6IGV2ZW50RGF0YVRhYmxlLnRhYmxlTmFtZSxcblx0XHRcdFx0XHRcdFx0cm9sZUFybjogaW90UnVsZVJvbGUucm9sZUFybixcblx0XHRcdFx0XHRcdFx0aGFzaEtleUZpZWxkOiBcIlBLXCIsXG5cdFx0XHRcdFx0XHRcdGhhc2hLZXlWYWx1ZTogXCJCT09USFMjJHtib290aElkfVwiLFxuXHRcdFx0XHRcdFx0XHRyYW5nZUtleUZpZWxkOiBcIlNLXCIsXG5cdFx0XHRcdFx0XHRcdHJhbmdlS2V5VmFsdWU6IFwiUkVDT1JEIyR7dGltZXN0YW1wfVwiLFxuXHRcdFx0XHRcdFx0fSxcblx0XHRcdFx0XHR9LFxuXHRcdFx0XHRdLFxuXHRcdFx0XHRydWxlRGlzYWJsZWQ6IGZhbHNlLFxuXHRcdFx0fSxcblx0XHR9KTtcblxuXHRcdGZvciAoY29uc3QgY29uZmlnIG9mIGRldmljZUNvbmZpZ3MpIHtcblx0XHRcdG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsIGBJb1RUaGluZ05hbWUtJHtjb25maWcuaWR9YCwge1xuXHRcdFx0XHR2YWx1ZTogY29uZmlnLmlkLFxuXHRcdFx0XHRkZXNjcmlwdGlvbjogYElvVCBUaGluZyBOYW1lIGZvciBORkMgUmVhZGVyICR7Y29uZmlnLmlkfWAsXG5cdFx0XHR9KTtcblx0XHR9XG5cblx0XHRuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCBcIklvVFBvbGljeU5hbWVcIiwge1xuXHRcdFx0dmFsdWU6IGlvdFBvbGljeS5wb2xpY3lOYW1lISxcblx0XHRcdGRlc2NyaXB0aW9uOiBcIklvVCBQb2xpY3kgTmFtZVwiLFxuXHRcdH0pO1xuXG5cdFx0bmV3IGNkay5DZm5PdXRwdXQodGhpcywgXCJEeW5hbW9EQlRhYmxlTmFtZVwiLCB7XG5cdFx0XHR2YWx1ZTogZXZlbnREYXRhVGFibGUudGFibGVOYW1lLFxuXHRcdFx0ZGVzY3JpcHRpb246IFwiRHluYW1vREIgVGFibGUgTmFtZVwiLFxuXHRcdH0pO1xuXG5cdFx0bmV3IGNkay5DZm5PdXRwdXQodGhpcywgXCJJb1RFbmRwb2ludFwiLCB7XG5cdFx0XHR2YWx1ZTogYGh0dHBzOi8vJHt0aGlzLmFjY291bnR9LmlvdC4ke3RoaXMucmVnaW9ufS5hbWF6b25hd3MuY29tYCxcblx0XHRcdGRlc2NyaXB0aW9uOiBcIklvVCBDb3JlIEVuZHBvaW50XCIsXG5cdFx0fSk7XG5cblx0XHQvLyDjgr/jgrDku5jjgZFcblx0XHRjZGsuVGFncy5vZih0aGlzKS5hZGQoXCJQcm9qZWN0XCIsIFwiTkZDVmlzaXRNYW5hZ2VtZW50XCIpO1xuXHRcdGNkay5UYWdzLm9mKHRoaXMpLmFkZChcIkVudmlyb25tZW50XCIsIFwiRGV2ZWxvcG1lbnRcIik7XG5cdH1cbn1cbiJdfQ==