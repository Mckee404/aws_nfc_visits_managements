import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";

export interface ApiLambdaStackProps extends cdk.StackProps {
  readonly eventDataTable: dynamodb.Table;
}

export class ApiLambdaStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ApiLambdaStackProps) {
    super(scope, id, props);

    // Go/Gin Lambda関数
    const apiLambda = new lambda.DockerImageFunction(this, "ApiLambda", {
      code: lambda.DockerImageCode.fromImageAsset("../../services/api"),
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      architecture: cdk.aws_lambda.Architecture.ARM_64,
      environment: {
        GIN_MODE: "release",
        TABLE_NAME: props.eventDataTable.tableName,
      },
    });

    // DynamoDBへの読み取り権限をLambdaに付与
    props.eventDataTable.grantReadData(apiLambda);

    
    // API Gatewayの作成
    const api = new apigateway.LambdaRestApi(this, "NFCVisitsApi", {
      handler: apiLambda,
      proxy: true, // 全てのリクエストをLambdaにプロキシ
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
      },
    });

    // 出力
    new cdk.CfnOutput(this, "ApiEndpoint", {
      value: api.url,
      description: "API Gateway Endpoint URL",
    });
  }
}
