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

# Variables de configuration OpenTelemetry lues automatiquement au lancement
ENV OTEL_SERVICE_NAME=service-c-order
ENV OTEL_TRACES_EXPORTER=otlp
ENV OTEL_EXPORTER_OTLP_PROTOCOL=grpc
ENV OTEL_NODE_ENABLED_INSTRUMENTATIONS=http,express
ENV OTEL_METRICS_EXPORTER=none
ENV OTEL_LOGS_EXPORTER=otlp

COPY package.json ./
RUN npm install --omit=dev

COPY --from=builder /app/dist ./dist

EXPOSE 8083

# Injection de l'agent OpenTelemetry avant le démarrage du serveur
CMD ["node", "--require", "./dist/instrumentation.js", "dist/server.js"]