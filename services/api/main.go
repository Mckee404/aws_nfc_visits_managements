package main

import (
	"context"
	"fmt"
	"log"
	"net/http"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"
	"github.com/aws/aws-sdk-go/aws"
	"github.com/aws/aws-sdk-go/aws/session"
	"github.com/aws/aws-sdk-go/service/dynamodb"
	"github.com/aws/aws-sdk-go/service/dynamodb/dynamodbattribute"
	ginadapter "github.com/awslabs/aws-lambda-go-api-proxy/gin"
	"github.com/gin-gonic/gin"
)

var ginLambda *ginadapter.GinLambda
var dbClient *dynamodb.DynamoDB

const (
	tableName = "EventData"
)

// VisitRecord はDynamoDBの項目を表す構造体
type VisitRecord struct {
	PK        string `json:"PK"`
	SK        string `json:"SK"`
	BoothID   string `json:"boothId"`
	NFCUID    string `json:"nfcUid"`
	Timestamp int64  `json:"timestamp"`
	VisitID   string `json:"visitId"`
}

func init() {
	// stdout and stderr are sent to AWS CloudWatch Logs
	log.Printf("Gin cold start")

	// AWSセッションの初期化
	sess, err := session.NewSession()
	if err != nil {
		log.Fatalf("Failed to create session: %v", err)
	}
	dbClient = dynamodb.New(sess)

	// Ginルーターの設定
	r := gin.Default()
	r.GET("/visits/:boothId", getVisitsByBooth)
	r.GET("/visits/date/:date", getVisitsByDate) // YYYY-MM-DD形式

	ginLambda = ginadapter.New(r)
}

// getVisitsByBooth は特定のブースの訪問履歴を取得します
func getVisitsByBooth(c *gin.Context) {
	boothID := c.Param("boothId")
	pk := fmt.Sprintf("BOOTHS#%s", boothID)

	input := &dynamodb.QueryInput{
		TableName:              aws.String(tableName),
		KeyConditionExpression: aws.String("PK = :pk"),
		ExpressionAttributeValues: map[string]*dynamodb.AttributeValue{
			":pk": {
				S: aws.String(pk),
			},
		},
	}

	result, err := dbClient.Query(input)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to query DynamoDB", "details": err.Error()})
		return
	}

	var records []VisitRecord
	err = dynamodbattribute.UnmarshalListOfMaps(result.Items, &records)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to unmarshal DynamoDB items", "details": err.Error()})
		return
	}

	c.JSON(http.StatusOK, records)
}

// getVisitsByDate は特定の日付の訪問履歴をGSI2を使って取得します
func getVisitsByDate(c *gin.Context) {
	date := c.Param("date") // YYYY-MM-DD
	gsi2PK := fmt.Sprintf("DATE#%s", date)

	input := &dynamodb.QueryInput{
		TableName:              aws.String(tableName),
		IndexName:              aws.String("VisitRecordsByDateAndTimestamp"),
		KeyConditionExpression: aws.String("GSI_2_PK = :gsi2pk"),
		ExpressionAttributeValues: map[string]*dynamodb.AttributeValue{
			":gsi2pk": {
				S: aws.String(gsi2PK),
			},
		},
	}

	result, err := dbClient.Query(input)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to query GSI", "details": err.Error()})
		return
	}

	var records []VisitRecord
	err = dynamodbattribute.UnmarshalListOfMaps(result.Items, &records)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to unmarshal DynamoDB items", "details": err.Error()})
		return
	}

	c.JSON(http.StatusOK, records)
}

// Lambdaハンドラ
func Handler(ctx context.Context, req events.APIGatewayProxyRequest) (events.APIGatewayProxyResponse, error) {
	return ginLambda.ProxyWithContext(ctx, req)
}

func main() {
	lambda.Start(Handler)
}
