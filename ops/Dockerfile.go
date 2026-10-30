# Image for apps/settlement. Multi-stage: the Go toolchain never reaches the
# small server (a `go build` on the box filled its 2 GB disk once already).
FROM golang:1.22-bookworm AS build
WORKDIR /src
COPY apps/settlement/go.mod apps/settlement/go.sum ./
RUN go mod download
COPY apps/settlement/ ./
# Static binary; the Asia/Bahrain zone is embedded via time/tzdata.
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/settlement ./cmd/settlement

FROM gcr.io/distroless/static-debian12:nonroot
WORKDIR /app
COPY --from=build /out/settlement /app/settlement
ENTRYPOINT []
