FROM node:24-alpine AS builder

WORKDIR /app

COPY package.json ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production

COPY package.json ./
RUN npm install --omit=dev

COPY --from=builder /app/dist ./dist

EXPOSE 8082

# Send traces and logs to the collector in gRPC, the protocol of port 4317
ENV OTEL_EXPORTER_OTLP_PROTOCOL=grpc
# Metrics are exposed on /metrics with prom-client, not pushed by OpenTelemetry
ENV OTEL_METRICS_EXPORTER=none

CMD ["node", "dist/server.js"]
