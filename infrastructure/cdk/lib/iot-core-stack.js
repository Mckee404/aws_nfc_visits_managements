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
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.IoTCoreStack = void 0;
const cdk = __importStar(require("aws-cdk-lib"));
const dynamodb = __importStar(require("aws-cdk-lib/aws-dynamodb"));
const iam = __importStar(require("aws-cdk-lib/aws-iam"));
const iot = __importStar(require("@aws-cdk/aws-iot-alpha"));
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
            const certificate = new iot.CfnCertificate(this, `NFCReaderCertificate-${config.id}`, {
                status: "ACTIVE",
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW90LWNvcmUtc3RhY2suanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJpb3QtY29yZS1zdGFjay50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFBQSxpREFBbUM7QUFDbkMsbUVBQXFEO0FBQ3JELHlEQUEyQztBQUMzQyw0REFBOEM7QUFHOUMsTUFBYSxZQUFhLFNBQVEsR0FBRyxDQUFDLEtBQUs7SUFDMUMsWUFBWSxLQUFnQixFQUFFLEVBQVUsRUFBRSxLQUFzQjtRQUMvRCxLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsRUFBRSxLQUFLLENBQUMsQ0FBQztRQUV4QixrQkFBa0I7UUFDbEIsTUFBTSxjQUFjLEdBQUcsSUFBSSxRQUFRLENBQUMsS0FBSyxDQUFDLElBQUksRUFBRSxnQkFBZ0IsRUFBRTtZQUNqRSxTQUFTLEVBQUUsV0FBVztZQUN0QixZQUFZLEVBQUU7Z0JBQ2IsSUFBSSxFQUFFLGNBQWM7Z0JBQ3BCLElBQUksRUFBRSxRQUFRLENBQUMsYUFBYSxDQUFDLE1BQU07YUFDbkM7WUFDRCxPQUFPLEVBQUUsRUFBRSxJQUFJLEVBQUUsU0FBUyxFQUFFLElBQUksRUFBRSxRQUFRLENBQUMsYUFBYSxDQUFDLE1BQU0sRUFBRTtZQUNqRSxXQUFXLEVBQUUsUUFBUSxDQUFDLFdBQVcsQ0FBQyxlQUFlO1lBQ2pELGFBQWEsRUFBRSxHQUFHLENBQUMsYUFBYSxDQUFDLE9BQU8sRUFBRSxTQUFTO1NBQ25ELENBQUMsQ0FBQztRQUVILGNBQWMsQ0FBQyx1QkFBdUIsQ0FBQztZQUN0QyxTQUFTLEVBQUUscUJBQXFCLEVBQUUsNEJBQTRCO1lBQzlELFlBQVksRUFBRTtnQkFDYixJQUFJLEVBQUUsVUFBVTtnQkFDaEIsSUFBSSxFQUFFLFFBQVEsQ0FBQyxhQUFhLENBQUMsTUFBTTthQUNuQztZQUNELE9BQU8sRUFBRTtnQkFDUixJQUFJLEVBQUUsVUFBVTtnQkFDaEIsSUFBSSxFQUFFLFFB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TSxJQUFJLGFBQWEsRUFBRSxDQUFDO1lBQ3BDLElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUsZ0JBQWdCLE1BQU0sQ0FBQyxFQUFFLEVBQUUsRUFBRTtnQkFDcEQsS0FBSyxFQUFFLE1BQU0sQ0FBQyxFQUFFO2dCQUNoQixXQUFXLEVBQUUsaUNBQWlDLE1BQU0sQ0FBQyxFQUFFLEVBQUU7YUFDekQsQ0FBQyxDQUFDO1FBQ0osQ0FBQztRQUVELElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUsZUFBZSxFQUFFO1lBQ3hDLEtBQUssRUFBRSxTQUFTLENBQUMsVUFBVztZQUM1QixXQUFXLEVBQUUsaUJBQWlCO1NBQzlCLENBQUMsQ0FBQztRQUVILElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUsbUJBQW1CLEVBQUU7WUFDNUMsS0FBSyxFQUFFLGNBQWMsQ0FBQyxTQUFTO1lBQy9CLFdBQVcsRUFBRSxxQkFBcUI7U0FDbEMsQ0FBQyxDQUFDO1FBRUgsSUFBSSxHQUFHLENBQUMsU0FBUyxDQUFDLElBQUksRUFBRSxhQUFhLEVBQUU7WUFDdEMsS0FBSyxFQUFFLFdBQVcsSUFBSSxDQUFDLE9BQU8sUUFBUSxJQUFJLENBQUMsTUFBTSxnQkFBZ0I7WUFDakUsV0FBVyxFQUFFLG1CQUFtQjtTQUNoQyxDQUFDLENBQUM7UUFFSCxPQUFPO1FBQ1AsR0FBRyxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUMsSUFBSSxDQUFDLENBQUMsR0FBRyxDQUFDLFNBQVMsRUFBRSxvQkFBb0IsQ0FBQyxDQUFDO1FBQ3ZELEdBQUcsQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDLElBQUksQ0FBQyxDQUFDLEdBQUcsQ0FBQyxhQUFhLEVBQUUsYUFBYSxDQUFDLENBQUM7SUFDckQsQ0FBQztDQUNEO0FBNU5ELG9DQTROQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCAqIGFzIGNkayBmcm9tIFwiYXdzLWNkay1saWJcIjtcclxuaW1wb3J0ICogYXMgZHluYW1vZGIgZnJvbSBcImF3cy1jZGstbGliL2F3cy1keW5hbW9kYlwiO1xyXG5pbXBvcnQgKiBhcyBpYW0gZnJvbSBcImF3cy1jZGstbGliL2F3cy1pYW1cIjtcclxuaW1wb3J0ICogYXMgaW90IGZyb20gJ0Bhd3MtY2RrL2F3cy1pb3QtYWxwaGEnO1xyXG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tIFwiY29uc3RydWN0c1wiO1xyXG5cclxuZXhwb3J0IGNsYXNzIElvVENvcmVTdGFjayBleHRlbmRzIGNkay5TdGFjayB7XHJcblx0Y29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM/OiBjZGsuU3RhY2tQcm9wcykge1xyXG5cdFx0c3VwZXIoc2NvcGUsIGlkLCBwcm9wcyk7XHJcblxyXG5cdFx0Ly8gRHluYW1vREIg44OG44O844OW44Or5L2c5oiQXHJcblx0XHRjb25zdCBldmVudERhdGFUYWJsZSA9IG5ldyBkeW5hbW9kYi5UYWJsZSh0aGlzLCBcIkV2ZW50RGF0YVRhYmxlXCIsIHtcclxuXHRcdFx0dGFibGVOYW1lOiBcIkV2ZW50RGF0YVwiLFxyXG5cdFx0XHRwYXJ0aXRpb25LZXk6IHtcclxuXHRcdFx0XHRuYW1lOiBcInBhcnRpdGlvbktleVwiLFxyXG5cdFx0XHRcdHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuU1RSSU5HLFxyXG5cdFx0XHR9LFxyXG5cdFx0XHRzb3J0S2V5OiB7IG5hbWU6IFwic29ydEtleVwiLCB0eXBlOiBkeW5hbW9kYi5BdHRyaWJ1dGVUeXBlLlNUUklORyB9LFxyXG5cdFx0XHRiaWxsaW5nTW9kZTogZHluYW1vZGIuQmlsbGluZ01vZGUuUEFZX1BFUl9SRVFVRVNULFxyXG5cdFx0XHRyZW1vdmFsUG9saWN5OiBjZGsuUmVtb3ZhbFBvbGljeS5ERVNUUk9ZLCAvLyDplovnmbrnlKjjga7jgZ/jgoFcclxuXHRcdH0pO1xyXG5cclxuXHRcdGV2ZW50RGF0YVRhYmxlLmFkZEdsb2JhbFNlY29uZGFyeUluZGV4KHtcclxuXHRcdFx0aW5kZXhOYW1lOiBcIkdTSTEtR2VuZXJpY1F1ZXJpZXNcIiwgLy8g44KI44KK5rGO55So55qE44Gq44Ki44Kv44K744K544OR44K/44O844Oz44KS44K144Od44O844OI44GZ44KL5oSP5ZGz5ZCI44GEXHJcblx0XHRcdHBhcnRpdGlvbktleToge1xyXG5cdFx0XHRcdG5hbWU6IFwiR1NJXzFfUEtcIixcclxuXHRcdFx0XHR0eXBlOiBkeW5hbW9kYi5BdHRyaWJ1dGVUeXBlLlNUUklORyxcclxuXHRcdFx0fSxcclxuXHRcdFx0c29ydEtleToge1xyXG5cdFx0XHRcdG5hbWU6IFwiR1NJXzFfU0tcIixcclxuXHRcdFx0XHR0eXBlOiBkeW5hbW9kYi5BdHRyaWJ1dGVUeXBlLlNUUklORyxcclxuXHRcdFx0fSxcclxuXHRcdFx0cHJvamVjdGlvblR5cGU6IGR5bmFtb2RiLlByb2plY3Rpb25UeXBlLkFMTCwgLy8g44GT44GT44Gv5pys55Wq44Gn44Gv5pyA6YGp5YyW44KS5qSc6KiOXHJcblx0XHRcdC8vIOS7peS4i+OBruioreWumuOBr+S+i+OBp+OBmeOAguacrOeVqueSsOWig+OBp+OBr1Rocm91Z2hwdXTjga7mhY7ph43jgaropovnqY3jgoLjgorjgYzlv4XopoHjgafjgZnjgIJcclxuXHRcdFx0Ly8gcmVhZENhcGFjaXR5OiAxLCAvLyDjgqrjg7Pjg4fjg57jg7Pjg4njgarjga7jgafoqK3lrprkuI3opoHvvIjjg5fjg63jg5Pjgrjjg6fjg7Pjg4njg6Ljg7zjg4njga7loLTlkIjvvIlcclxuXHRcdFx0Ly8gd3JpdGVDYXBhY2l0eTogMSwgLy8g44Kq44Oz44OH44Oe44Oz44OJ44Gq44Gu44Gn6Kit5a6a5LiN6KaBXHJcblx0XHR9KTtcclxuXHJcblx0XHQvLyBHU0kyOiDnibnlrprjga7ml6Xku5jjga7lhajoqKrllY/lsaXmrbTjgpLmmYLns7vliJfjgaflj5blvpcgKOODluODvOOCueOCkuWVj+OCj+OBmilcclxuXHRcdC8vIFBLOiBEQVRFIzxZWVlZLU1NLUREPlxyXG5cdFx0Ly8gU0s6IFJFQ09SRCM8dGltZXN0YW1wPlxyXG5cdFx0ZXZlbnREYXRhVGFibGUuYWRkR2xvYmFsU2Vjb25kYXJ5SW5kZXgoe1xyXG5cdFx0XHRpbmRleE5hbWU6IFwiVmlzaXRSZWNvcmRzQnlEYXRlQW5kVGltZXN0YW1wXCIsIC8vIOaXpeS7mOOBqOOCv+OCpOODoOOCueOCv+ODs+ODl+OBp+OCouOCr+OCu+OCueOBmeOCi+adpeWgtOiomOmMslxyXG5cdFx0XHRwYXJ0aXRpb25LZXk6IHtcclxuXHRcdFx0XHRuYW1lOiBcIkdTSV8yX1BLXCIsXHJcblx0XHRcdFx0dHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcsXHJcblx0XHRcdH0sXHJcblx0XHRcdHNvcnRLZXk6IHtcclxuXHRcdFx0XHRuYW1lOiBcIkdTSV8yX1NLXCIsXHJcblx0XHRcdFx0dHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcsXHJcblx0XHRcdH0sXHJcblx0XHRcdHByb2plY3Rpb25UeXBlOiBkeW5hbW9kYi5Qcm9qZWN0aW9uVHlwZS5BTEwsIC8vIOOBk+OBk+OBr+acrOeVquOBp+OBr+acgOmBqeWMluOCkuaknOiojlxyXG5cdFx0fSk7XHJcblxyXG5cdFx0Y29uc3QgZGV2aWNlQ29uZmlncyA9IFt7IGlkOiBcImJvb3RoLTFcIiB9LCB7IGlkOiBcImJvb3RoLTJcIiB9XTtcclxuXHJcblx0XHQvLyBJb1QgUG9saWN5IOS9nOaIkO+8iOWFiOOBq+S9nOaIkO+8iVxyXG5cdFx0Y29uc3QgaW90UG9saWN5ID0gbmV3IGlvdC5DZm5Qb2xpY3kodGhpcywgXCJORkNJb1RQb2xpY3lcIiwge1xyXG5cdFx0XHRwb2xpY3lOYW1lOiBcIk5GQ0RldmljZVBvbGljeVwiLFxyXG5cdFx0XHRwb2xpY3lEb2N1bWVudDoge1xyXG5cdFx0XHRcdFZlcnNpb246IFwiMjAxMi0xMC0xN1wiLFxyXG5cdFx0XHRcdFN0YXRlbWVudDogW1xyXG5cdFx0XHRcdFx0e1xyXG5cdFx0XHRcdFx0XHRFZmZlY3Q6IFwiQWxsb3dcIixcclxuXHRcdFx0XHRcdFx0QWN0aW9uOiBbXCJpb3Q6Q29ubmVjdFwiXSxcclxuXHRcdFx0XHRcdFx0UmVzb3VyY2U6IFtcclxuXHRcdFx0XHRcdFx0XHRgYXJuOmF3czppb3Q6JHt0aGlzLnJlZ2lvbn06JHt0aGlzLmFjY291bnR9OmNsaWVudC9uZmMtcmVhZGVyLSpgLFxyXG5cdFx0XHRcdFx0XHRdLFxyXG5cdFx0XHRcdFx0fSxcclxuXHRcdFx0XHRcdHtcclxuXHRcdFx0XHRcdFx0RWZmZWN0OiBcIkFsbG93XCIsXHJcblx0XHRcdFx0XHRcdEFjdGlvbjogW1wiaW90OlB1Ymxpc2hcIl0sXHJcblx0XHRcdFx0XHRcdFJlc291cmNlOiBbXHJcblx0XHRcdFx0XHRcdFx0YGFybjphd3M6aW90OiR7dGhpcy5yZWdpb259OiR7dGhpcy5hY2NvdW50fTp0b3BpYy9uZmMvdmlzaXRzLypgLFxyXG5cdFx0XHRcdFx0XHRdLFxyXG5cdFx0XHRcdFx0fSxcclxuXHRcdFx0XHRcdHtcclxuXHRcdFx0XHRcdFx0RWZmZWN0OiBcIkFsbG93XCIsXHJcblx0XHRcdFx0XHRcdEFjdGlvbjogW1wiaW90OlN1YnNjcmliZVwiXSxcclxuXHRcdFx0XHRcdFx0UmVzb3VyY2U6IFtcclxuXHRcdFx0XHRcdFx0XHRgYXJuOmF3czppb3Q6JHt0aGlzLnJlZ2lvbn06JHt0aGlzLmFjY291bnR9OnRvcGljZmlsdGVyL25mYy9jb21tYW5kcy8qYCxcclxuXHRcdFx0XHRcdFx0XSxcclxuXHRcdFx0XHRcdH0sXHJcblx0XHRcdFx0XHR7XHJcblx0XHRcdFx0XHRcdEVmZmVjdDogXCJBbGxvd1wiLFxyXG5cdFx0XHRcdFx0XHRBY3Rpb246IFtcImlvdDpSZWNlaXZlXCJdLFxyXG5cdFx0XHRcdFx0XHRSZXNvdXJjZTogW1xyXG5cdFx0XHRcdFx0XHRcdGBhcm46YXdzOmlvdDoke3RoaXMucmVnaW9ufToke3RoaXMuYWNjb3VudH06dG9waWMvbmZjL2NvbW1hbmRzLypgLFxyXG5cdFx0XHRcdFx0XHRdLFxyXG5cdFx0XHRcdFx0fSxcclxuXHRcdFx0XHRdLFxyXG5cdFx0XHR9LFxyXG5cdFx0fSk7XHJcblxyXG5cdFx0Ly8g44OH44OQ44Kk44K55q+O44Gr6Ki85piO5pu444Go44Ki44K/44OD44OB44Oh44Oz44OI44KS5L2c5oiQXHJcblx0XHRjb25zdCBjZXJ0aWZpY2F0ZXM6IHsgW2tleTogc3RyaW5nXTogaW90LkNmbkNlcnRpZmljYXRlIH0gPSB7fTtcclxuXHRcdGNvbnN0IHBvbGljeUF0dGFjaG1lbnRzOiBpb3QuQ2ZuUG9saWN5UHJpbmNpcGFsQXR0YWNobWVudFtdID0gW107XHJcblx0XHRjb25zdCB0aGluZ0F0dGFjaG1lbnRzOiBpb3QuQ2ZuVGhpbmdQcmluY2lwYWxBdHRhY2htZW50W10gPSBbXTtcclxuXHJcblx0XHRmb3IgKGNvbnN0IGNvbmZpZyBvZiBkZXZpY2VDb25maWdzKSB7XHJcblx0XHRcdC8vIElvVCBUaGluZ+S9nOaIkFxyXG5cdFx0XHRjb25zdCBuZmNUaGluZyA9IG5ldyBpb3QuQ2ZuVGhpbmcodGhpcywgYE5GQ1RoaW5nLSR7Y29uZmlnLmlkfWAsIHtcclxuXHRcdFx0XHR0aGluZ05hbWU6IGNvbmZpZy5pZCxcclxuXHRcdFx0XHRhdHRyaWJ1dGVQYXlsb2FkOiB7XHJcblx0XHRcdFx0XHRhdHRyaWJ1dGVzOiB7XHJcblx0XHRcdFx0XHRcdGJvb3RoSWQ6IGNvbmZpZy5pZCxcclxuXHRcdFx0XHRcdH0sXHJcblx0XHRcdFx0fSxcclxuXHRcdFx0fSk7XHJcblxyXG5cdFx0XHQvLyDoqLzmmI7mm7jkvZzmiJBcclxuXHRcdFx0Y29uc3QgY2VydGlmaWNhdGUgPSBuZXcgaW90LkNmbkNlcnRpZmljYXRlKFxyXG5cdFx0XHRcdHRoaXMsXHJcblx0XHRcdFx0YE5GQ1JlYWRlckNlcnRpZmljYXRlLSR7Y29uZmlnLmlkfWAsXHJcblx0XHRcdFx0e1xyXG5cdFx0XHRcdFx0c3RhdHVzOiBcIkFDVElWRVwiLFxyXG5cdFx0XHRcdH1cclxuXHRcdFx0KTtcclxuXHRcdFx0Y2VydGlmaWNhdGVzW2NvbmZpZy5pZF0gPSBjZXJ0aWZpY2F0ZTtcclxuXHJcblx0XHRcdC8vIFBvbGljeSDjgaggQ2VydGlmaWNhdGUg44Gu44Ki44K/44OD44OB44Oh44Oz44OIXHJcblx0XHRcdGNvbnN0IHBvbGljeUF0dGFjaG1lbnQgPSBuZXcgaW90LkNmblBvbGljeVByaW5jaXBhbEF0dGFjaG1lbnQoXHJcblx0XHRcdFx0dGhpcyxcclxuXHRcdFx0XHRgUG9saWN5QXR0YWNobWVudC0ke2NvbmZpZy5pZH1gLFxyXG5cdFx0XHRcdHtcclxuXHRcdFx0XHRcdHBvbGljeU5hbWU6IGlvdFBvbGljeS5wb2xpY3lOYW1lISxcclxuXHRcdFx0XHRcdHByaW5jaXBhbDogY2VydGlmaWNhdGUuYXR0ckFybixcclxuXHRcdFx0XHR9XHJcblx0XHRcdCk7XHJcblx0XHRcdHBvbGljeUF0dGFjaG1lbnRzLnB1c2gocG9saWN5QXR0YWNobWVudCk7XHJcblxyXG5cdFx0XHQvLyBDZXJ0aWZpY2F0ZSDjgaggVGhpbmcg44Gu44Ki44K/44OD44OB44Oh44Oz44OIXHJcblx0XHRcdGNvbnN0IHRoaW5nQXR0YWNobWVudCA9IG5ldyBpb3QuQ2ZuVGhpbmdQcmluY2lwYWxBdHRhY2htZW50KFxyXG5cdFx0XHRcdHRoaXMsXHJcblx0XHRcdFx0YFRoaW5nQXR0YWNobWVudC0ke2NvbmZpZy5pZH1gLFxyXG5cdFx0XHRcdHtcclxuXHRcdFx0XHRcdHRoaW5nTmFtZTogbmZjVGhpbmcudGhpbmdOYW1lISxcclxuXHRcdFx0XHRcdHByaW5jaXBhbDogY2VydGlmaWNhdGUuYXR0ckFybixcclxuXHRcdFx0XHR9XHJcblx0XHRcdCk7XHJcblx0XHRcdHRoaW5nQXR0YWNobWVudHMucHVzaCh0aGluZ0F0dGFjaG1lbnQpO1xyXG5cclxuXHRcdFx0Ly8g6Ki85piO5pu45oOF5aCx44KS5Ye65YqbXHJcblx0XHRcdG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsIGBDZXJ0aWZpY2F0ZUFybi0ke2NvbmZpZy5pZH1gLCB7XHJcblx0XHRcdFx0dmFsdWU6IGNlcnRpZmljYXRlLmF0dHJBcm4sXHJcblx0XHRcdFx0ZGVzY3JpcHRpb246IGBDZXJ0aWZpY2F0ZSBBUk4gZm9yICR7Y29uZmlnLmlkfWAsXHJcblx0XHRcdH0pO1xyXG5cclxuXHRcdFx0bmV3IGNkay5DZm5PdXRwdXQodGhpcywgYENlcnRpZmljYXRlSWQtJHtjb25maWcuaWR9YCwge1xyXG5cdFx0XHRcdHZhbHVlOiBjZXJ0aWZpY2F0ZS5yZWYsXHJcblx0XHRcdFx0ZGVzY3JpcHRpb246IGBDZXJ0aWZpY2F0ZSBJRCBmb3IgJHtjb25maWcuaWR9YCxcclxuXHRcdFx0fSk7XHJcblx0XHR9XHJcblxyXG5cdFx0Ly8gSW9UIFJvbGUgZm9yIFJ1bGUgQWN0aW9uXHJcblx0XHRjb25zdCBpb3RSdWxlUm9sZSA9IG5ldyBpYW0uUm9sZSh0aGlzLCBcIklvVFJ1bGVSb2xlXCIsIHtcclxuXHRcdFx0YXNzdW1lZEJ5OiBuZXcgaWFtLlNlcnZpY2VQcmluY2lwYWwoXCJpb3QuYW1hem9uYXdzLmNvbVwiKSxcclxuXHRcdFx0aW5saW5lUG9saWNpZXM6IHtcclxuXHRcdFx0XHREeW5hbW9EQkFjY2VzczogbmV3IGlhbS5Qb2xpY3lEb2N1bWVudCh7XHJcblx0XHRcdFx0XHRzdGF0ZW1lbnRzOiBbXHJcblx0XHRcdFx0XHRcdG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcclxuXHRcdFx0XHRcdFx0XHRlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXHJcblx0XHRcdFx0XHRcdFx0YWN0aW9uczogW1xyXG5cdFx0XHRcdFx0XHRcdFx0XCJkeW5hbW9kYjpQdXRJdGVtXCIsXHJcblx0XHRcdFx0XHRcdFx0XHRcImR5bmFtb2RiOlVwZGF0ZUl0ZW1cIixcclxuXHRcdFx0XHRcdFx0XHRcdFwiZHluYW1vZGI6R2V0SXRlbVwiLFxyXG5cdFx0XHRcdFx0XHRcdFx0XCJkeW5hbW9kYjpRdWVyeVwiLFxyXG5cdFx0XHRcdFx0XHRcdF0sXHJcblx0XHRcdFx0XHRcdFx0cmVzb3VyY2VzOiBbXHJcblx0XHRcdFx0XHRcdFx0XHRldmVudERhdGFUYWJsZS50YWJsZUFybixcclxuXHRcdFx0XHRcdFx0XHRcdGAke2V2ZW50RGF0YVRhYmxlLnRhYmxlQXJufS9pbmRleC8qYCxcclxuXHRcdFx0XHRcdFx0XHRdLFxyXG5cdFx0XHRcdFx0XHR9KSxcclxuXHRcdFx0XHRcdF0sXHJcblx0XHRcdFx0fSksXHJcblx0XHRcdH0sXHJcblx0XHR9KTtcclxuXHJcblx0XHQvLyBJb1QgUnVsZSDkvZzmiJAgLSDoqKrllY/jg4fjg7zjgr/jgpJEeW5hbW9EQuOBq+S/neWtmFxyXG5cdFx0Y29uc3QgdmlzaXRSdWxlID0gbmV3IGlvdC5DZm5Ub3BpY1J1bGUodGhpcywgXCJWaXNpdFJ1bGVcIiwge1xyXG5cdFx0XHRydWxlTmFtZTogXCJQcm9jZXNzTkZDVmlzaXRzXCIsXHJcblx0XHRcdHRvcGljUnVsZVBheWxvYWQ6IHtcclxuXHRcdFx0XHRzcWw6IFwiU0VMRUNUICosIHRvcGljKDMpIGFzIGRldmljZUlkIEZST00gJ25mYy92aXNpdHMvKydcIixcclxuXHRcdFx0XHRkZXNjcmlwdGlvbjogXCJQcm9jZXNzIE5GQyB2aXNpdCBkYXRhIGFuZCBzdG9yZSBpbiBEeW5hbW9EQlwiLFxyXG5cdFx0XHRcdGFjdGlvbnM6IFtcclxuXHRcdFx0XHRcdHtcclxuXHRcdFx0XHRcdFx0ZHluYW1vRGI6IHtcclxuXHRcdFx0XHRcdFx0XHR0YWJsZU5hbWU6IGV2ZW50RGF0YVRhYmxlLnRhYmxlTmFtZSxcclxuXHRcdFx0XHRcdFx0XHRyb2xlQXJuOiBpb3RSdWxlUm9sZS5yb2xlQXJuLFxyXG5cdFx0XHRcdFx0XHRcdGhhc2hLZXlGaWVsZDogXCJQS1wiLFxyXG5cdFx0XHRcdFx0XHRcdGhhc2hLZXlWYWx1ZTogXCJCT09USFMjJHtib290aElkfVwiLFxyXG5cdFx0XHRcdFx0XHRcdHJhbmdlS2V5RmllbGQ6IFwiU0tcIixcclxuXHRcdFx0XHRcdFx0XHRyYW5nZUtleVZhbHVlOiBcIlJFQ09SRCMke3RpbWVzdGFtcH1cIixcclxuXHRcdFx0XHRcdFx0fSxcclxuXHRcdFx0XHRcdH0sXHJcblx0XHRcdFx0XSxcclxuXHRcdFx0XHRydWxlRGlzYWJsZWQ6IGZhbHNlLFxyXG5cdFx0XHR9LFxyXG5cdFx0fSk7XHJcblxyXG5cdFx0Zm9yIChjb25zdCBjb25maWcgb2YgZGV2aWNlQ29uZmlncykge1xyXG5cdFx0XHRuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCBgSW9UVGhpbmdOYW1lLSR7Y29uZmlnLmlkfWAsIHtcclxuXHRcdFx0XHR2YWx1ZTogY29uZmlnLmlkLFxyXG5cdFx0XHRcdGRlc2NyaXB0aW9uOiBgSW9UIFRoaW5nIE5hbWUgZm9yIE5GQyBSZWFkZXIgJHtjb25maWcuaWR9YCxcclxuXHRcdFx0fSk7XHJcblx0XHR9XHJcblxyXG5cdFx0bmV3IGNkay5DZm5PdXRwdXQodGhpcywgXCJJb1RQb2xpY3lOYW1lXCIsIHtcclxuXHRcdFx0dmFsdWU6IGlvdFBvbGljeS5wb2xpY3lOYW1lISxcclxuXHRcdFx0ZGVzY3JpcHRpb246IFwiSW9UIFBvbGljeSBOYW1lXCIsXHJcblx0XHR9KTtcclxuXHJcblx0XHRuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCBcIkR5bmFtb0RCVGFibGVOYW1lXCIsIHtcclxuXHRcdFx0dmFsdWU6IGV2ZW50RGF0YVRhYmxlLnRhYmxlTmFtZSxcclxuXHRcdFx0ZGVzY3JpcHRpb246IFwiRHluYW1vREIgVGFibGUgTmFtZVwiLFxyXG5cdFx0fSk7XHJcblxyXG5cdFx0bmV3IGNkay5DZm5PdXRwdXQodGhpcywgXCJJb1RFbmRwb2ludFwiLCB7XHJcblx0XHRcdHZhbHVlOiBgaHR0cHM6Ly8ke3RoaXMuYWNjb3VudH0uaW90LiR7dGhpcy5yZWdpb259LmFtYXpvbmF3cy5jb21gLFxyXG5cdFx0XHRkZXNjcmlwdGlvbjogXCJJb1QgQ29yZSBFbmRwb2ludFwiLFxyXG5cdFx0fSk7XHJcblxyXG5cdFx0Ly8g44K/44Kw5LuY44GRXHJcblx0XHRjZGsuVGFncy5vZih0aGlzKS5hZGQoXCJQcm9qZWN0XCIsIFwiTkZDVmlzaXRNYW5hZ2VtZW50XCIpO1xyXG5cdFx0Y2RrLlRhZ3Mub2YodGhpcykuYWRkKFwiRW52aXJvbm1lbnRcIiwgXCJEZXZlbG9wbWVudFwiKTtcclxuXHR9XHJcbn1cclxuIl19