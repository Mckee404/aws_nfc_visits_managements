package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"strconv"
	"time"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"
	"github.com/aws/aws-sdk-go/aws"
	"github.com/aws/aws-sdk-go/aws/session"
	"github.com/aws/aws-sdk-go/service/dynamodb"
	"github.com/aws/aws-sdk-go/service/dynamodb/dynamodbattribute"
	"github.com/aws/aws-sdk-go/service/dynamodb/expression"
	ginadapter "github.com/awslabs/aws-lambda-go-api-proxy/gin"
	"github.com/gin-gonic/gin"
)

var ginLambda *ginadapter.GinLambda
var dbClient *dynamodb.DynamoDB
var tableName string

// --- Struct Definitions based on gemini.md ---

type VisitorInfo struct {
	Name  string `json:"name"`
	Email string `json:"email"`
}

type Visit struct {
	VisitID   string `json:"visitId"`
	BoothID   string `json:"boothId"`
	NfcUID    string `json:"nfcUid"` // Add nfcUid
	Timestamp string `json:"timestamp"`
	// VisitorInfo will be populated by joining with visitor data
	VisitorInfo *Visitor `json:"visitorInfo,omitempty"` // Pointer to Visitor to allow nil
}

type VisitsResponse struct {
	Visits    []Visit `json:"visits"`
	NextToken *string `json:"nextToken,omitempty"`
}

type Booth struct {
	BoothID     string `json:"boothId"`
	BoothName   string `json:"boothName"`
	Description string `json:"description"`
	Location    string `json:"location"`
	HostName    string `json:"hostName"`
	HostEmail   string `json:"hostEmail"`
}

type BoothsResponse struct {
	Booths []Booth `json:"booths"`
}

type Visitor struct {
	Name             string `json:"name"`
	Email            string `json:"email"`
	RegistrationDate string `json:"registrationDate"`
}

type VisitorsResponse struct {
	Visitors  []Visitor `json:"visitors"`
	NextToken *string   `json:"nextToken,omitempty"`
}

// --- DynamoDB Structs ---
// Assuming a denormalized structure for Visits and a GSI for entity types.

// DynamoDBVisitItem corresponds to a visit record in DynamoDB.
// It's assumed that visitorInfo is denormalized and stored within the visit item.
type DynamoDBVisitItem struct {
	PK      string                 `dynamodbav:"PK"`      // BOOTHS#<boothId>
	SK      string                 `dynamodbav:"SK"`      // RECORD#<timestamp>
	Payload map[string]interface{} `dynamodbav:"payload"` // Raw payload from IoT Core
}

// DynamoDBBoothItem corresponds to a booth metadata record.
type DynamoDBBoothItem struct {
	PK          string `dynamodbav:"PK"`         // BOOTHS#<boothId>
	SK          string `dynamodbav:"SK"`         // METADATA
	EntityType  string `dynamodbav:"EntityType"` // "BOOTH" (for GSI)
	BoothID     string `dynamodbav:"boothId"`
	BoothName   string `dynamodbav:"boothName"`
	Description string `dynamodbav:"description"`
	Location    string `dynamodbav:"location"`
	HostName    string `dynamodbav:"hostName"`
	HostEmail   string `dynamodbav:"hostEmail"`
}

// DynamoDBVisitorItem corresponds to a visitor metadata record.
type DynamoDBVisitorItem struct {
	PK               string `dynamodbav:"PK"`         // VISITORS#<nfcUid> or VISITORS#<visitorId>
	SK               string `dynamodbav:"SK"`         // METADATA
	EntityType       string `dynamodbav:"EntityType"` // "VISITOR" (for GSI)
	Name             string `dynamodbav:"name"`
	Email            string `dynamodbav:"email"`
	RegistrationDate string `dynamodbav:"registrationDate"`
}

func init() {
	log.Printf("Gin cold start")

	tableName = os.Getenv("TABLE_NAME")
	if tableName == "" {
		tableName = "EventData" // Fallback for local testing
	}

	sess, err := session.NewSession()
	if err != nil {
		log.Fatalf("Failed to create session: %v", err)
	}
	dbClient = dynamodb.New(sess)

	r := gin.Default()
	r.GET("/visits", getVisits)
	r.GET("/booths", getBooths)
	r.GET("/visitors", getVisitors)

	ginLambda = ginadapter.New(r)
}

func getVisits(c *gin.Context) {
	// --- Parse Query Parameters ---
	boothID := c.Query("boothId")
	startDate := c.Query("startDate")
	endDate := c.Query("endDate")
	limitStr := c.Query("limit")
	nextToken := c.Query("nextToken")
	sortBy := c.Query("sortBy")       // Only "timestamp" is supported
	sortOrder := c.Query("sortOrder") // "asc" or "desc"

	// --- Build DynamoDB Query ---
	keyCond := expression.KeyAnd(
		expression.Key("PK").Equal(expression.Value(fmt.Sprintf("VISITS#%s", boothID))),
		expression.Key("SK").BeginsWith("RECORD#"),
	)

	if startDate != "" && endDate != "" {
		keyCond = expression.KeyAnd(
			expression.Key("PK").Equal(expression.Value(fmt.Sprintf("VISITS#%s", boothID))),
			expression.Key("SK").Between(
				expression.Value(fmt.Sprintf("VISITS#%s", startDate)),
				expression.Value(fmt.Sprintf("VISITS#%s", endDate)),
			),
		)
	} else if startDate != "" {
		keyCond = expression.KeyAnd(
			expression.Key("PK").Equal(expression.Value(fmt.Sprintf("VISITS#%s", boothID))),
			expression.Key("SK").GreaterThanEqual(expression.Value(fmt.Sprintf("VISITS#%s", startDate))),
		)
	} else if endDate != "" {
		keyCond = expression.KeyAnd(
			expression.Key("PK").Equal(expression.Value(fmt.Sprintf("VISITS#%s", boothID))),
			expression.Key("SK").LessThanEqual(expression.Value(fmt.Sprintf("VISITS#%s", endDate))),
		)
	}

	if boothID == "" {
		// A boothId is required to query visits in this data model.
		// Alternatively, we would need a GSI on timestamp.
		c.JSON(http.StatusBadRequest, gin.H{"error": "boothId query parameter is required"})
		return
	}

	expr, err := expression.NewBuilder().WithKeyCondition(keyCond).Build()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to build DynamoDB expression", "details": err.Error()})
		return
	}

	input := &dynamodb.QueryInput{
		TableName:                 aws.String(tableName),
		KeyConditionExpression:    expr.KeyCondition(),
		ExpressionAttributeNames:  expr.Names(),
		ExpressionAttributeValues: expr.Values(),
	}

	// Pagination
	if limitStr != "" {
		limit, err := strconv.ParseInt(limitStr, 10, 64)
		if err == nil {
			input.Limit = aws.Int64(limit)
		}
	}

	if nextToken != "" {
		decodedToken, err := base64.StdEncoding.DecodeString(nextToken)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid nextToken format"})
			return
		}
		var lastEvaluatedKey map[string]*dynamodb.AttributeValue
		if err := json.Unmarshal(decodedToken, &lastEvaluatedKey); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid nextToken content"})
			return
		}
		input.ExclusiveStartKey = lastEvaluatedKey
	}

	// Sorting
	if sortBy == "timestamp" && sortOrder == "asc" {
		input.ScanIndexForward = aws.Bool(true)
	} else {
		// Default to descending order by timestamp (SK)
		input.ScanIndexForward = aws.Bool(false)
	}

	// --- Execute Query ---
	result, err := dbClient.Query(input)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to query DynamoDB", "details": err.Error()})
		return
	}

	dbItems := result.Items // Directly assign result.Items
	if dbItems == nil {     // Add a check for nil to avoid panic
		dbItems = []map[string]*dynamodb.AttributeValue{}
	}

	visits := make([]Visit, 0)
	for _, item := range dbItems {
		pk := *item["PK"].S
		sk := *item["SK"].S

		// Extract timestamp from SK (e.g., RECORD#1751298042379)
		timestampStr := ""
		if len(sk) > 7 && sk[:7] == "RECORD#" {
			timestampStr = sk[7:]
		}

		// Unmarshal payload
		payloadMap := make(map[string]interface{})
		if payloadAttr, ok := item["payload"]; ok && payloadAttr.M != nil {
			if err := dynamodbattribute.UnmarshalMap(payloadAttr.M, &payloadMap); err != nil {
				log.Printf("Failed to unmarshal payload: %v", err)
				continue // Skip this item if payload unmarshalling fails
			}
		}

		visitID, _ := payloadMap["visitId"].(string)
		boothID := ""
		if len(pk) > 7 && pk[:7] == "VISITS#" {
			boothID = pk[7:]
		}
		nfcUid, _ := payloadMap["nfcUid"].(string)

		// Create a temporary Visit struct
		v := Visit{
			VisitID:   visitID,
			BoothID:   boothID,
			NfcUID:    nfcUid,
			Timestamp: timestampStr,
		}

		// Fetch visitor info if nfcUid exists
		if nfcUid != "" {
			visitor, err := getVisitorByNfcUid(nfcUid)
			if err != nil {
				log.Printf("Error fetching visitor for nfcUid %s: %v", nfcUid, err)
				// Continue without visitor info if there's an error
			} else {
				v.VisitorInfo = visitor
			}
		}
		visits = append(visits, v)
	}

	// --- Prepare Response ---
	response := VisitsResponse{
		Visits: visits,
	}

	if result.LastEvaluatedKey != nil {
		tokenBytes, err := json.Marshal(result.LastEvaluatedKey)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create nextToken"})
			return
		}
		encodedToken := base64.StdEncoding.EncodeToString(tokenBytes)
		response.NextToken = &encodedToken
	}

	c.JSON(http.StatusOK, response)
}

func getBooths(c *gin.Context) {
	boothID := c.Query("boothId")

	var dbItems []DynamoDBBoothItem

	if boothID != "" {
		// Get a specific booth
		input := &dynamodb.GetItemInput{
			TableName: aws.String(tableName),
			Key: map[string]*dynamodb.AttributeValue{
				"PK": {S: aws.String(fmt.Sprintf("BOOTHS#%s", boothID))},
				"SK": {S: aws.String("METADATA")},
			},
		}
		result, err := dbClient.GetItem(input)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to get item from DynamoDB", "details": err.Error()})
			return
		}
		if result.Item != nil {
			var item DynamoDBBoothItem
			if err := dynamodbattribute.UnmarshalMap(result.Item, &item); err == nil {
				dbItems = append(dbItems, item)
			} else {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to unmarshal DynamoDB item", "details": err.Error()})
				return
			}
		}
	} else {
		// Get all booths using a GSI
		// Assumes a GSI named "EntityTypeIndex" with PK=EntityType
		keyCond := expression.Key("EntityType").Equal(expression.Value("BOOTH"))
		expr, err := expression.NewBuilder().WithKeyCondition(keyCond).Build()
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to build expression", "details": err.Error()})
			return
		}
		input := &dynamodb.QueryInput{
			TableName:                 aws.String(tableName),
			IndexName:                 aws.String("EntityTypeIndex"),
			KeyConditionExpression:    expr.KeyCondition(),
			ExpressionAttributeNames:  expr.Names(),
			ExpressionAttributeValues: expr.Values(),
		}
		result, err := dbClient.Query(input)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to query GSI", "details": err.Error()})
			return
		}
		if err := dynamodbattribute.UnmarshalListOfMaps(result.Items, &dbItems); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to unmarshal items", "details": err.Error()})
			return
		}
	}

	// Map to response format
	booths := make([]Booth, len(dbItems))
	for i, item := range dbItems {
		booths[i] = Booth{
			BoothID:     item.BoothID,
			BoothName:   item.BoothName,
			Description: item.Description,
			Location:    item.Location,
			HostName:    item.HostName,
			HostEmail:   item.HostEmail,
		}
	}

	c.JSON(http.StatusOK, BoothsResponse{Booths: booths})
}

func getVisitors(c *gin.Context) {
	// --- Parse Query Parameters ---
	visitorID := c.Query("visitorId")
	limitStr := c.Query("limit")
	nextToken := c.Query("nextToken")

	if visitorID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "visitorId query parameter is required"})
		return
	}

	// --- Build DynamoDB Query ---
	keyCond := expression.Key("PK").Equal(expression.Value(fmt.Sprintf("VISITORS#%s", visitorID)))
	builder := expression.NewBuilder().WithKeyCondition(keyCond)

	expr, err := builder.Build()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to build expression", "details": err.Error()})
		return
	}

	input := &dynamodb.QueryInput{
		TableName:                 aws.String(tableName),
		KeyConditionExpression:    expr.KeyCondition(),
		ExpressionAttributeNames:  expr.Names(),
		ExpressionAttributeValues: expr.Values(),
	}
	// Pagination
	if limitStr != "" {
		limit, err := strconv.ParseInt(limitStr, 10, 64)
		if err == nil {
			input.Limit = aws.Int64(limit)
		}
	}
	if nextToken != "" {
		decodedToken, err := base64.StdEncoding.DecodeString(nextToken)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid nextToken format"})
			return
		}
		var lastEvaluatedKey map[string]*dynamodb.AttributeValue
		if err := json.Unmarshal(decodedToken, &lastEvaluatedKey); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid nextToken content"})
			return
		}
		input.ExclusiveStartKey = lastEvaluatedKey
	}

	// --- Execute Query ---
	result, err := dbClient.Query(input)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to query visitor", "details": err.Error()})
		return
	}

	var dbItems []DynamoDBVisitorItem
	if err := dynamodbattribute.UnmarshalListOfMaps(result.Items, &dbItems); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to unmarshal items", "details": err.Error()})
		return
	}

	// Map to response format
	visitors := make([]Visitor, len(dbItems))
	for i, item := range dbItems {
		visitors[i] = Visitor{
			Name:             item.Name,
			Email:            item.Email,
			RegistrationDate: item.RegistrationDate,
		}
	}

	// --- Prepare Response ---
	response := VisitorsResponse{
		Visitors: visitors,
	}

	if result.LastEvaluatedKey != nil {
		tokenBytes, err := json.Marshal(result.LastEvaluatedKey)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create nextToken"})
			return
		}
		encodedToken := base64.StdEncoding.EncodeToString(tokenBytes)
		response.NextToken = &encodedToken
	}

	c.JSON(http.StatusOK, response)
}

func getVisitorByNfcUid(nfcUid string) (*Visitor, error) {
	input := &dynamodb.GetItemInput{
		TableName: aws.String(tableName),
		Key: map[string]*dynamodb.AttributeValue{
			"PK": {S: aws.String(fmt.Sprintf("VISITORS#%s", nfcUid))},
			"SK": {S: aws.String("METADATA")},
		},
	}
	result, err := dbClient.GetItem(input)
	if err != nil {
		return nil, fmt.Errorf("failed to get visitor item from DynamoDB: %w", err)
	}
	if result.Item == nil {
		return nil, nil // Visitor not found
	}

	var dbItem DynamoDBVisitorItem
	if err := dynamodbattribute.UnmarshalMap(result.Item, &dbItem); err != nil {
		return nil, fmt.Errorf("failed to unmarshal DynamoDB visitor item: %w", err)
	}

	visitor := &Visitor{
		Name:             dbItem.Name,
		Email:            dbItem.Email,
		RegistrationDate: dbItem.RegistrationDate,
	}
	return visitor, nil
}

func Handler(ctx context.Context, req events.APIGatewayProxyRequest) (events.APIGatewayProxyResponse, error) {
	// Add a timeout to the context
	timeoutCtx, cancel := context.WithTimeout(ctx, 25*time.Second)
	defer cancel()
	return ginLambda.ProxyWithContext(timeoutCtx, req)
}

func main() {
	lambda.Start(Handler)
}
