package main

import (
	"context"
	"fmt"
	"log"
	"strings"

	"github.com/aws/aws-lambda-go/lambda"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/iot"
	"github.com/aws/aws-sdk-go-v2/service/iot/types"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

type CertificateData struct {
	CertificateArn string `json:"certificateArn"`
	CertificateId  string `json:"certificateId"`
	PublicKey      string `json:"publicKey,omitempty"`
	PrivateKey     string `json:"privateKey,omitempty"`
}

// CloudFormationCustomResourceEvent is a minimal struct for custom resource events
type CloudFormationCustomResourceEvent struct {
	RequestType        string                 `json:"RequestType"`
	ResourceProperties map[string]interface{} `json:"ResourceProperties"`
	PhysicalResourceId string                 `json:"PhysicalResourceId"`
	LogicalResourceId  string                 `json:"LogicalResourceId"`
	RequestId          string                 `json:"RequestId"`
	StackId            string                 `json:"StackId"`
}

// CloudFormationCustomResourceResponse is a minimal struct for custom resource responses
type CloudFormationCustomResourceResponse struct {
	Status             string                 `json:"Status"`
	Reason             string                 `json:"Reason,omitempty"`
	PhysicalResourceId string                 `json:"PhysicalResourceId"`
	LogicalResourceId  string                 `json:"LogicalResourceId"`
	RequestId          string                 `json:"RequestId"`
	StackId            string                 `json:"StackId"`
	Data               map[string]interface{} `json:"Data,omitempty"`
}

func handler(ctx context.Context, event CloudFormationCustomResourceEvent) (CloudFormationCustomResourceResponse, error) {
	log.Printf("Received event: %+v", event)

	cfg, err := config.LoadDefaultConfig(ctx)
	if err != nil {
		log.Printf("Failed to load AWS config: %v", err)
		return failureResponse(event, fmt.Sprintf("AWS config load failed: %v", err)), nil
	}

	client := iot.NewFromConfig(cfg)

	switch event.RequestType {
	case "Create":
		return handleCreate(ctx, client, event)
	case "Update":
		return handleUpdate(ctx, client, event)
	case "Delete":
		return handleDelete(ctx, client, event)
	default:
		return failureResponse(event, "Unknown RequestType"), nil
	}
}

func handleCreate(ctx context.Context, client *iot.Client, event CloudFormationCustomResourceEvent) (CloudFormationCustomResourceResponse, error) {
	boothIdRaw, ok := event.ResourceProperties["BoothId"]
	if !ok {
		log.Printf("BoothId is missing in ResourceProperties")
		return failureResponse(event, "BoothId is missing in ResourceProperties"), nil
	}
	boothId, ok := boothIdRaw.(string)
	if !ok || boothId == "" {
		log.Printf("BoothId is not a valid string: %v", boothIdRaw)
		return failureResponse(event, "BoothId is not a valid string"), nil
	}

	log.Printf("Creating certificate for device: %s", boothId)

	// 証明書とキーペア作成
	result, err := client.CreateKeysAndCertificate(ctx, &iot.CreateKeysAndCertificateInput{
		SetAsActive: true,
	})
	if err != nil {
		log.Printf("Failed to create certificate: %v", err)
		return failureResponse(event, fmt.Sprintf("Certificate creation failed: %v", err)), nil
	}

	if result.CertificateArn == nil || result.CertificateId == nil || result.KeyPair == nil || result.KeyPair.PublicKey == nil || result.KeyPair.PrivateKey == nil {
		log.Printf("Certificate response contains nil fields: %+v", result)
		return failureResponse(event, "Certificate response contains nil fields"), nil
	}

	log.Printf("Certificate created successfully: %s", *result.CertificateId)

	saveKeyPairToS3(ctx, boothId, *result.KeyPair)
	// レスポンスデータ
	data := map[string]interface{}{
		"CertificateArn": *result.CertificateArn,
		"CertificateId":  *result.CertificateId,
		"PublicKey":      *result.KeyPair.PublicKey,
		"PrivateKey":     *result.KeyPair.PrivateKey,
	}

	return successResponse(event, data), nil
}
func handleUpdate(ctx context.Context, client *iot.Client, event CloudFormationCustomResourceEvent) (CloudFormationCustomResourceResponse, error) {
	// 証明書の更新は基本的に作り直し
	return handleCreate(ctx, client, event)
}
func handleDelete(ctx context.Context, client *iot.Client, event CloudFormationCustomResourceEvent) (CloudFormationCustomResourceResponse, error) {
	certificateId := event.PhysicalResourceId

	log.Printf("Deleting certificate: %s", certificateId)

	// 証明書を非アクティブ化
	_, err := client.UpdateCertificate(ctx, &iot.UpdateCertificateInput{
		CertificateId: &certificateId,
		NewStatus:     types.CertificateStatusInactive,
	})
	if err != nil {
		log.Printf("Failed to deactivate certificate: %v", err)
		// 削除時はエラーでも成功扱いにする場合がある
	}

	// 証明書削除
	_, err = client.DeleteCertificate(ctx, &iot.DeleteCertificateInput{
		CertificateId: &certificateId,
		ForceDelete:   true,
	})
	if err != nil {
		log.Printf("Failed to delete certificate: %v", err)
		// 既に削除済みの場合は成功扱い
	}

	log.Printf("Certificate deleted successfully: %s", certificateId)

	return successResponse(event, map[string]interface{}{}), nil
}
func successResponse(event CloudFormationCustomResourceEvent, data map[string]interface{}) CloudFormationCustomResourceResponse {
	physicalId := event.PhysicalResourceId
	if event.RequestType == "Create" {
		if certId, ok := data["CertificateId"].(string); ok {
			physicalId = certId
		}
	}

	return CloudFormationCustomResourceResponse{
		Status:             "SUCCESS",
		PhysicalResourceId: physicalId,
		Data:               data,
		LogicalResourceId:  event.LogicalResourceId,
		RequestId:          event.RequestId,
		StackId:            event.StackId,
	}
}
func failureResponse(event CloudFormationCustomResourceEvent, reason string) CloudFormationCustomResourceResponse {
	return CloudFormationCustomResourceResponse{
		Status:             "FAILED",
		Reason:             reason,
		PhysicalResourceId: event.PhysicalResourceId,
		LogicalResourceId:  event.LogicalResourceId,
		RequestId:          event.RequestId,
		StackId:            event.StackId,
		Data:               nil,
	}
}
func saveKeyPairToS3(ctx context.Context, boothId string, keyPair types.KeyPair) error {
	// AWS Configのロード
	cfg, err := config.LoadDefaultConfig(ctx)
	if err != nil {
		log.Printf("Failed to load AWS config for S3: %v", err)
		return err
	}

	// S3クライアント作成
	s3Client := s3.NewFromConfig(cfg)

	// 公開鍵保存
	_, err = s3Client.PutObject(ctx, &s3.PutObjectInput{
		Bucket:      aws.String("aws-nfc-visits-management-certs"),
		Key:         aws.String(fmt.Sprintf("certs/%s-public.pem", boothId)),
		Body:        strings.NewReader(aws.ToString(keyPair.PublicKey)),
		ContentType: aws.String("application/x-pem-file"),
	})
	if err != nil {
		log.Printf("Failed to save public key to S3: %v", err)
		return err
	}
	// 秘密鍵保存
	_, err = s3Client.PutObject(ctx, &s3.PutObjectInput{
		Bucket:      aws.String("aws-nfc-visits-management-certs"),
		Key:         aws.String(fmt.Sprintf("certs/%s-private.pem", boothId)),
		Body:        strings.NewReader(aws.ToString(keyPair.PrivateKey)),
		ContentType: aws.String("application/x-pem-file"),
	})
	if err != nil {
		log.Printf("Failed to save private key to S3: %v", err)
		return err
	}
	return nil
}

func main() {
	lambda.Start(handler)
}
