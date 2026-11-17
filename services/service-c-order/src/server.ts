import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import client from 'prom-client';
import { CheckoutRequest, CheckoutResponse, ErrorResponse } from './types';
import { logs, SeverityNumber } from '@opentelemetry/api-logs';

const app = express();

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8083;
const SERVICE_NAME = 'service-c-order';
const otelLogger = logs.getLogger(SERVICE_NAME);

// Collecte des métriques par défaut de Prometheus (compteurs, histogrammes, etc.)
client.collectDefaultMetrics();

// Rate et Error metrics
const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
});

// Duration metrics
const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
});

// Middleware RED metrics + Logging OTel vers Loki
app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.path === '/metrics') return next();
  const end = httpRequestDuration.startTimer();

  res.on('finish', () => {
    const labels = {
      method: req.method,
      route: req.route ? req.route.path : 'unmatched',
      status_code: String(res.statusCode),
    };
    httpRequestsTotal.inc(labels);
    end(labels);

    // Émission du log OTLP vers le collecteur
    otelLogger.emit({
      severityNumber: res.statusCode >= 500 ? SeverityNumber.ERROR : SeverityNumber.INFO,
      severityText: res.statusCode >= 500 ? 'ERROR' : 'INFO',
      body: `HTTP ${req.method} ${req.originalUrl} finished with status ${res.statusCode}`,
      attributes: {
        'http.method': req.method,
        'http.status_code': res.statusCode,
        'http.target': req.originalUrl,
      },
    });
  });

  next();
});

// Downstream service configuration
const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://service-a:8081';
const CATALOG_SERVICE_URL = process.env.CATALOG_SERVICE_URL || 'http://service-b:8082';
const PAYMENT_SERVICE_URL = process.env.PAYMENT_SERVICE_URL || 'http://service-d:8084';

app.use(cors());
app.use(express.json());

// Operational health probe
app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    service: SERVICE_NAME,
    downstreams: {
      auth: AUTH_SERVICE_URL,
      catalog: CATALOG_SERVICE_URL,
      payment: PAYMENT_SERVICE_URL,
    },
    timestamp: new Date().toISOString(),
  });
});

app.get('/metrics', async (_req: Request, res: Response) => {
  res.set('Content-Type', client.register.contentType);
  res.end(await client.register.metrics());
});

// ==========================================
// Service Endpoints
// ==========================================

app.post(
  '/orders/checkout',
  async (req: Request<{}, {}, CheckoutRequest>, res: Response<CheckoutResponse | ErrorResponse>) => {
    const { user_id, items, payment_method } = req.body;

    if (!user_id || !Array.isArray(items) || !payment_method) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Missing required fields: user_id, items, payment_method',
        status_code: 400,
      });
    }

    for (const item of items) {
      if (!item.product_id || typeof item.quantity !== 'number' || item.quantity <= 0) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Each item must have a valid product_id and a positive quantity',
          status_code: 400,
        });
      }
    }

    const traceHeaders: Record<string, string> = {};
    if (req.headers['traceparent']) {
      traceHeaders['traceparent'] = req.headers['traceparent'] as string;
    }
    if (req.headers['tracestate']) {
      traceHeaders['tracestate'] = req.headers['tracestate'] as string;
    }

    let reservationId: string | undefined;

    try {
      const authRes = await fetch(`${AUTH_SERVICE_URL}/auth/verify?user-id=${encodeURIComponent(user_id)}`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          ...traceHeaders,
        },
      });

      if (!authRes.ok) {
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'User authentication failed',
          status_code: 401,
        });
      }

      const inventoryRes = await fetch(`${CATALOG_SERVICE_URL}/inventory/reserve`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...traceHeaders,
        },
        body: JSON.stringify({ user_id, items }),
      });

      if (!inventoryRes.ok) {
        return res.status(409).json({
          error: 'Conflict',
          message: 'Inventory reservation failed',
          status_code: 409,
        });
      }

      const inventoryData = (await inventoryRes.json()) as { reservation_id?: string; total_cents?: number };
      reservationId = inventoryData.reservation_id;
      const totalCents = inventoryData.total_cents || 0;

      const paymentRes = await fetch(`${PAYMENT_SERVICE_URL}/payments/charge`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...traceHeaders,
        },
        body: JSON.stringify({ user_id, amount_cents: totalCents, payment_method, reservation_id: reservationId }),
      });

      if (!paymentRes.ok) {
        if (reservationId) {
          try {
            await fetch(`${CATALOG_SERVICE_URL}/inventory/release`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                ...traceHeaders,
              },
              body: JSON.stringify({ reservation_id: reservationId }),
            });
          } catch (comptError) {
            console.error(`[${SERVICE_NAME}] Error during inventory release:`, comptError);
          }
        }

        return res.status(402).json({
          error: 'Payment Required',
          message: 'Payment processing failed',
          status_code: 402,
        });
      }

      const paymentData = (await paymentRes.json()) as { transaction_id?: string };
      const orderId = `ORD-${Date.now()}-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;

      return res.status(201).json({
        order_id: orderId,
        status: 'CONFIRMED',
        total_cents: totalCents,
        reservation_id: reservationId,
        transaction_id: paymentData.transaction_id,
        message: 'Order created and payment processed successfully',
      });
    } catch (err: any) {
      console.error(`[${SERVICE_NAME}] Checkout saga encountered an internal error:`, err);

      if (reservationId) {
        try {
          await fetch(`${CATALOG_SERVICE_URL}/inventory/release`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...traceHeaders,
            },
            body: JSON.stringify({ reservation_id: reservationId }),
          });
        } catch (releaseError) {
          console.error(`[${SERVICE_NAME}] Secondary compensation failure:`, releaseError);
        }
      }

      return res.status(500).json({
        error: 'Internal Server Error',
        message: err.message || 'An unexpected error occurred during the checkout process',
        status_code: 500,
      });
    }
  }
);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[${SERVICE_NAME}] listening on port ${PORT}`);
  console.log(`[${SERVICE_NAME}] Downstream targets: Auth=${AUTH_SERVICE_URL}, Catalog=${CATALOG_SERVICE_URL}, Payment=${PAYMENT_SERVICE_URL}`);
});