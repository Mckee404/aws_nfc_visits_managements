#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { IoTCoreStack } from "../lib/iot-core-stack";

const app = new cdk.App();
new IoTCoreStack(app, "IoTCoreStack", {
	env: {
		account: process.env.CDK_DEFAULT_ACCOUNT,
		region: process.env.CDK_DEFAULT_REGION,
	},
});
