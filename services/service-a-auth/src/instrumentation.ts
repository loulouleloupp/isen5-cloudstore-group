import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-grpc';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { HostMetrics } from '@opentelemetry/host-metrics';
import { metrics } from '@opentelemetry/api';

// Metrics: exposed on the /metrics route of server.ts, where Prometheus scrapes them.
// preventServerStart: do not open a separate port, Express serves them instead.
export const prometheusExporter = new PrometheusExporter({ preventServerStart: true });

const sdk = new NodeSDK({
  serviceName: 'service-a-auth',
  // Traces: sent to the collector, which forwards them to Jaeger.
  // The collector address comes from OTEL_EXPORTER_OTLP_ENDPOINT (docker-compose.yml).
  traceExporter: new OTLPTraceExporter(),
  // Logs: sent to the collector, which forwards them to Loki
  logRecordProcessors: [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter() })],
  metricReader: prometheusExporter,
  // Automatic spans for http and express, logs bridge for pino, event loop metrics (USE)
  instrumentations: [getNodeAutoInstrumentations()],
});

sdk.start();

// USE: CPU and memory usage of the process
new HostMetrics({ meterProvider: metrics.getMeterProvider(), name: 'service-a-auth' }).start();