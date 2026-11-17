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
# OpenTelemetry configuration, read by the auto-instrumentation at startup
# OTEL_EXPORTER_OTLP_ENDPOINT is already provided by docker-compose.yml
ENV OTEL_NODE_ENABLED_INSTRUMENTATIONS=http,express,pino,runtime-node
ENV OTEL_NODE_RESOURCE_DETECTORS=env,host,os,process,container
COPY package.json ./
RUN npm install --omit=dev
COPY --from=builder /app/dist ./dist
EXPOSE 8081
# Load OpenTelemetry before the app so it can instrument express
CMD ["node", "dist/server.js"]