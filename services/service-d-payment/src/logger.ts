import { trace, isSpanContextValid } from '@opentelemetry/api';

export function log(level: 'info' | 'warn' | 'error', message: string,
  fields: Record<string, string | number | boolean> = {}): void {
  const spanContext = trace.getActiveSpan()?.spanContext();
  console.log(JSON.stringify({
    ...fields,
    timestamp: new Date().toISOString(), level,
    service: 'service-d-payment', message,
    ...(spanContext && isSpanContextValid(spanContext)
      ? { trace_id: spanContext.traceId, span_id: spanContext.spanId } : {}),
  }));
}
