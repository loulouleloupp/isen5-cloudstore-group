// This module must load before Express and node:http (first import in server.ts).
import { NodeSDK } from '@opentelemetry/sdk-node';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchSpanProcessor, SimpleSpanProcessor, SpanExporter } from '@opentelemetry/sdk-trace-base';
import { diag, DiagLogLevel } from '@opentelemetry/api';
import { log } from './logger';

// Sanitized diagnostics: exporter errors must never expose headers or secrets.
diag.setLogger({
  error: () => log('error', 'OpenTelemetry technical error (telemetry export may be unavailable).'),
  warn: () => log('warn', 'OpenTelemetry warning.'),
  info: () => {}, debug: () => {}, verbose: () => {},
}, DiagLogLevel.WARN);

// JSON export for local verification, without a collector or a banking call.
const localExporter: SpanExporter = {
  export(spans, callback) {
    if (process.env.OTEL_TRACES_EXPORTER === 'console') {
      for (const span of spans) {
        console.log(JSON.stringify({
          timestamp: new Date().toISOString(), level: 'info', service: 'service-d-payment',
          message: 'trace.export', name: span.name, kind: span.kind,
          trace_id: span.spanContext().traceId, span_id: span.spanContext().spanId,
          parent_span_id: span.parentSpanContext?.spanId,
          duration_seconds: span.duration[0] + span.duration[1] / 1e9,
          attributes: Object.fromEntries(Object.entries(span.attributes).filter(([key]) =>
            ['payment.status', 'payment.outcome', 'http.route', 'http.status_code', 'express.type'].includes(key))),
          status: { code: span.status.code },
        }));
      }
    }
    callback({ code: 0 });
  },
  async shutdown() {},
};

const endpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
  || process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
const useCollector = Boolean(endpoint) && process.env.OTEL_TRACES_EXPORTER !== 'console';
export const telemetry = new NodeSDK({
  resource: resourceFromAttributes({ 'service.name': 'service-d-payment' }),
  logRecordProcessors: [],
  // Metrics are exclusively exposed by prom-client on /metrics. An omitted option
  // enables SDK defaults: periodic OTLP HTTP/protobuf exports to the gRPC endpoint.
  metricReaders: [],
  spanProcessors: [useCollector
    ? new BatchSpanProcessor(new OTLPTraceExporter({ url: endpoint, timeoutMillis: 1000 }), {
      scheduledDelayMillis: 1000, exportTimeoutMillis: 2000,
    })
    : new SimpleSpanProcessor(localExporter)],
  instrumentations: [new HttpInstrumentation(), new ExpressInstrumentation()],
});
telemetry.start();
