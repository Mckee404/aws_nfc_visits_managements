FROM golang:latest AS build

WORKDIR /workspace/go

ARG ARCH="arm64"

RUN --mount=type=bind,source=.,target=/workspace/go go mod download
RUN --mount=type=bind,source=.,target=/workspace/go GOARCH=${ARCH} CGO_ENABLED=0 GIN_MODE=${GIN_MODE} go build -trimpath -ldflags="-s -w" -o /functions/api main.go

FROM public.ecr.aws/lambda/provided:al2 AS local
COPY --from=build /functions /functions
ENTRYPOINT ["/usr/local/bin/aws-lambda-rie"]

FROM gcr.io/distroless/static-debian11 AS production
COPY --from=build /functions /functions
ENTRYPOINT ["/functions/api"]
