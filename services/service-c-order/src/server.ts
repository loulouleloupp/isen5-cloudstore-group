
import express, { Request, Response, NextFunction } from 'express';
import http from 'http';
import cors from 'cors';
import client from 'prom-client';
import { CheckoutRequest, CheckoutResponse, ErrorResponse } from './types';
import { logs, SeverityNumber } from '@opentelemetry/api-logs';

const app = express();

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8083;
const SERVICE_NAME = 'service-c-order';
const otelLogger = logs.getLogger(SERVICE_NAME);

client.collectDefaultMetrics();

const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
});

const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
});

function httpJson(
  urlStr: string,
  options: { method?: string; headers?: Record<string, string>; body?: unknown } = {}
): Promise<{ ok: boolean; status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const payload = options.body !== undefined ? JSON.stringify(options.body) : undefined;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    };

    if (payload) {
      headers['Content-Length'] = Buffer.byteLength(payload).toString();
    }

    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname + url.search,
        method: options.method || 'GET',
        headers,
      },
      (res) => {
        let raw = '';

        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => {
          let data: any = {};

          try {
            data = raw ? JSON.parse(raw) : {};
          } catch {
            data = { raw };
          }

          const status = res.statusCode || 500;
          resolve({ ok: status >= 200 && status < 300, status, data });
        });
      }
    );

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

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

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://service-a:8081';
const CATALOG_SERVICE_URL = process.env.CATALOG_SERVICE_URL || 'http://service-b:8082';
const PAYMENT_SERVICE_URL = process.env.PAYMENT_SERVICE_URL || 'http://service-d:8084';

app.use(cors());
app.use(express.json());

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

app.post(
  '/orders/checkout',
  async (req: Request<{}, {}, CheckoutRequest>, res: Response<CheckoutResponse | ErrorResponse>) => {
    const { user_id, items, payment_method } = req.body;

    if (!user_id || !Array.isArray(items) || items.length === 0 || !payment_method) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Missing required fields: user_id, items, payment_method',
        status_code: 400,
      });
    }

    for (const item of items) {
      if (
        !item ||
        typeof item.product_id !== 'string' ||
        !item.product_id ||
        !Number.isSafeInteger(item.quantity) ||
        item.quantity <= 0
      ) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Each item must have a valid product_id and a positive integer quantity',
          status_code: 400,
        });
      }
    }

    let reservationId: string | undefined;

    try {
      // 1. Auth verification
      let authHeader = req.headers.authorization;

      if (!authHeader) {
        const match = /^USER-(\d+)$/i.exec(user_id);

        if (match) {
          const num = match[1];

          const loginRes = await httpJson(`${AUTH_SERVICE_URL}/auth/login`, {
            method: 'POST',
            body: { username: `user${num}`, password: `password${num}` },
          });

          if (loginRes.ok && loginRes.data?.token) {
            authHeader = `Bearer ${loginRes.data.token}`;
          }
        }
      }

      const authRes = await httpJson(`${AUTH_SERVICE_URL}/auth/verify`, {
        method: 'GET',
        headers: authHeader ? { Authorization: authHeader } : {},
      });

      if (!authRes.ok) {
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'User authentication failed',
          status_code: 401,
        });
      }

      // 2. Get real prices from catalog
      const catalogRes = await httpJson(`${CATALOG_SERVICE_URL}/products`);

      if (!catalogRes.ok || !Array.isArray(catalogRes.data)) {
        return res.status(502).json({
          error: 'Bad Gateway',
          message: 'Cannot get product prices',
          status_code: 502,
        });
      }

      let totalCents = 0;

      for (const item of items) {
        const product = catalogRes.data.find(
          (p: any) => p.id === item.product_id
        );

        if (
          !product ||
          !Number.isSafeInteger(product.price_cents) ||
          product.price_cents <= 0
        ) {
          return res.status(400).json({
            error: 'Bad Request',
            message: 'Invalid product or price',
            status_code: 400,
          });
        }

        totalCents += product.price_cents * item.quantity;

        if (!Number.isSafeInteger(totalCents)) {
          return res.status(400).json({
            error: 'Bad Request',
            message: 'Invalid order total',
            status_code: 400,
          });
        }
      }

      // 3. Inventory reservation
      const inventoryRes = await httpJson(`${CATALOG_SERVICE_URL}/inventory/reserve`, {
        method: 'POST',
        body: { user_id, items },
      });

      if (!inventoryRes.ok) {
        return res.status(409).json({
          error: 'Conflict',
          message: 'Inventory reservation failed',
          status_code: 409,
        });
      }

      reservationId = inventoryRes.data?.reservation_id;

      if (!reservationId) {
        return res.status(502).json({
          error: 'Bad Gateway',
          message: 'Missing reservation ID',
          status_code: 502,
        });
      }

      // 4. Payment charge
      const orderId = `ORD-${Date.now()}-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;
      const idempotencyKey = reservationId;

      const paymentRes = await httpJson(`${PAYMENT_SERVICE_URL}/payments/charge`, {
        method: 'POST',
        body: {
          order_id: orderId,
          amount_cents: totalCents,
          idempotency_key: idempotencyKey,
        },
      });

      if (!paymentRes.ok) {
        try {
          const releaseRes = await httpJson(`${CATALOG_SERVICE_URL}/inventory/release`, {
            method: 'POST',
            body: { reservation_id: reservationId },
          });

          if (!releaseRes.ok) {
            console.error(`[${SERVICE_NAME}] Inventory release failed: HTTP ${releaseRes.status}`);
          }
        } catch (compError) {
          console.error(`[${SERVICE_NAME}] Error during inventory release:`, compError);
        }

        return res.status(402).json({
          error: 'Payment Required',
          message: 'Payment processing failed',
          status_code: 402,
        });
      }

      return res.status(201).json({
        order_id: orderId,
        status: 'CONFIRMED',
        total_cents: totalCents,
        reservation_id: reservationId,
        transaction_id: paymentRes.data?.transaction_id,
        message: 'Order created and payment processed successfully',
      });
    } catch (err: any) {
      console.error(`[${SERVICE_NAME}] Checkout saga encountered an internal error:`, err);

      if (reservationId) {
        try {
          const releaseRes = await httpJson(`${CATALOG_SERVICE_URL}/inventory/release`, {
            method: 'POST',
            body: { reservation_id: reservationId },
          });

          if (!releaseRes.ok) {
            console.error(`[${SERVICE_NAME}] Secondary compensation failed: HTTP ${releaseRes.status}`);
          }
        } catch (releaseError) {
          console.error(`[${SERVICE_NAME}] Secondary compensation failure:`, releaseError);
        }
      }

      return res.status(500).json({
        error: 'Internal Server Error',
        message: 'An unexpected error occurred during the checkout process',
        status_code: 500,
      });
    }
  }
);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[${SERVICE_NAME}] listening on port ${PORT}`);
  console.log(`[${SERVICE_NAME}] Downstream targets: Auth=${AUTH_SERVICE_URL}, Catalog=${CATALOG_SERVICE_URL}, Payment=${PAYMENT_SERVICE_URL}`);
});
