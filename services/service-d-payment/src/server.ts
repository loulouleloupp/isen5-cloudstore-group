import { telemetry } from './instrumentation';
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { randomUUID } from 'node:crypto';
import { ChargeRequest, ChargeResponse, ErrorResponse } from './types';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import { registry, observeHttp } from './metrics';
import { log } from './logger';

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8084;
const SERVICE_NAME = 'service-d-payment';

app.use(observeHttp);
app.use(cors());
app.use(express.json());

// Operational health probe
app.get('/healthz', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    service: SERVICE_NAME,
    timestamp: new Date().toISOString(),
  });
});

/**
 * GET /metrics
 * Purpose: Prometheus exposition format endpoint.
 * Exposes RED metrics using prom-client; scrapes are excluded from HTTP metrics.
 */
app.get('/metrics', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.setHeader('Content-Type', registry.contentType);
    res.status(200).send(await registry.metrics());
  } catch (error) { next(error); }
});

// ==========================================
// Service Endpoints
// ==========================================

/**
 * POST /payments/charge
 * Purpose: Simulates payment authorization with idempotency keys.
 * PAYMENT_SIMULATION_RESULT=declined simulates a PSP refusal; success is the default.
 */
type PaymentResult = { statusCode: 200 | 402; body: ChargeResponse };
const payments = new Map<string, {
  order_id: string;
  amount_cents: number;
  result: Promise<PaymentResult>;
}>();

async function simulatePayment(): Promise<PaymentResult> {
  return trace.getTracer(SERVICE_NAME).startActiveSpan('payment.psp.simulate', async (span): Promise<PaymentResult> => {
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 150));
      const declined = process.env.PAYMENT_SIMULATION_RESULT === 'declined';
      span.setAttribute('payment.status', declined ? 'FAILED_DECLINED' : 'SUCCESS');
      return {
        statusCode: declined ? 402 : 200,
        body: {
          transaction_id: `TXN-${randomUUID()}`,
          status: declined ? 'FAILED_DECLINED' : 'SUCCESS',
        },
      };
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      log('error', 'PSP simulation failed.');
      throw error;
    } finally { span.end(); }
  });
}

app.post(
  '/payments/charge',
  (_req: Request, res: Response, next: NextFunction) => {
    trace.getTracer(SERVICE_NAME).startActiveSpan('payment.process', (span) => {
      res.once('finish', () => {
        span.setAttribute('http.status_code', res.statusCode);
        span.setAttribute('payment.outcome', {
          200: 'SUCCESS', 400: 'INVALID', 402: 'FAILED_DECLINED', 409: 'CONFLICT',
        }[res.statusCode] || 'TECHNICAL_ERROR');
        if (res.statusCode >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
        span.end();
      });
      next();
    });
  },
  async (req: Request<{}, {}, ChargeRequest>, res: Response<ChargeResponse | ErrorResponse>, next: NextFunction) => {
    const body = req.body;
    let message: string | undefined;
    if (typeof body?.order_id !== 'string' || !body.order_id.trim()) {
      message = 'order_id must be a non-empty string.';
    } else if (!Number.isSafeInteger(body.amount_cents) || body.amount_cents <= 0) {
      message = 'amount_cents must be a strictly positive safe integer.';
    } else if (typeof body.idempotency_key !== 'string' || !body.idempotency_key.trim()) {
      message = 'idempotency_key must be a non-empty string.';
    }
    if (message) {
      log('warn', 'Payment validation failed.', { reason: message });
      res.status(400).json({ error: 'Bad Request', message, status_code: 400 });
      return;
    }

    const order_id = body.order_id.trim();
    const idempotency_key = body.idempotency_key.trim();
    const amount_cents = body.amount_cents;
    let payment = payments.get(idempotency_key);
    if (payment && (payment.order_id !== order_id || payment.amount_cents !== amount_cents)) {
      log('warn', 'Payment idempotency conflict.');
      res.status(409).json({
        error: 'Conflict',
        message: 'idempotency_key has already been used with different payment data.',
        status_code: 409,
      });
      return;
    }
    const replayed = Boolean(payment);
    if (!payment) {
      log('info', 'Payment processing started.');
      // Reserve the key before awaiting so concurrent requests share one PSP call.
      payment = { order_id, amount_cents, result: simulatePayment() };
      payments.set(idempotency_key, payment);
    }
    let result: PaymentResult;
    try { result = await payment.result; } catch (error) { next(error); return; }
    log(result.statusCode === 200 ? 'info' : 'warn',
      result.statusCode === 200 ? 'Payment succeeded.' : 'Payment declined.', { replayed });
    res.status(result.statusCode).json(result.body);
  }
);

app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) { next(error); return; }
  log('error', 'HTTP technical error.');
  const errorStatus = (error as { status?: number })?.status;
  const status = typeof errorStatus === 'number' && errorStatus >= 400 && errorStatus < 500 ? errorStatus : 500;
  res.status(status).json({ error: status === 400 ? 'Bad Request' : 'Internal Server Error',
    message: status === 400 ? 'Invalid JSON request body.' : 'Unexpected technical error.', status_code: status });
});

const server = app.listen(PORT, '0.0.0.0', () => {
  log('info', 'Service listening.', { port: PORT });
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    server.close(() => {
      void telemetry.shutdown().catch(() => log('error', 'Telemetry shutdown failed.'));
    });
  });
}
