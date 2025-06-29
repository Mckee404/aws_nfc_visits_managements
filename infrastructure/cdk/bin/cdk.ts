#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { IoTCoreStack } from "../lib/iot-core-stack";
import { ApiLambdaStack } from "../lib/api-lambda-stack";

const app = new cdk.App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

const iotCoreStack = new IoTCoreStack(app, "IoTCoreStack", { env });

new ApiLambdaStack(app, "ApiLambdaStack", {
  env,
  eventDataTable: iotCoreStack.eventDataTable,
});