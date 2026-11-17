import pino from 'pino';
import * as client from 'prom-client';
import { trace, context } from '@opentelemetry/api';
import express, { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import cors from 'cors';

import {
  Product,
  ReservationItem,
  ReserveRequest,
  ReserveResponse,
  ReleaseRequest,
  ReleaseResponse,
  ErrorResponse,
} from './types';

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8082;
const SERVICE_NAME = 'service-b-catalog';
const products: Product[] = [
  {
    id: 'PROD-1',
    name: 'Clavier mécanique',
    price_cents: 7999,
    stock: 100,
  },
  {
    id: 'PROD-2',
    name: 'Souris gaming',
    price_cents: 4999,
    stock: 100,
  },
  {
    id: 'PROD-3',
    name: 'Écran 27 pouces',
    price_cents: 24999,
    stock: 100,
  },
  {
    id: 'PROD-4',
    name: 'Casque audio',
    price_cents: 8999,
    stock: 100,
  },
  {
    id: 'PROD-5',
    name: 'Webcam HD',
    price_cents: 5999,
    stock: 100,
  },
];
const reservations = new Map<string, ReservationItem[]>();
app.use(cors());
app.use(express.json());

const logger = pino({
  name: 'service-b-catalog',
  level: 'info',
});

const register = new client.Registry<client.OpenMetricsContentType>();
register.setContentType(client.Registry.OPENMETRICS_CONTENT_TYPE);

// Métriques par défaut : CPU, mémoire, event loop, etc.
client.collectDefaultMetrics({ register });

// RED - Rate et Errors
const httpRequestsTotal = new client.Counter<string>({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
  registers: [register],
  enableExemplars: true,
});

// RED - Duration
const httpRequestDuration = new client.Histogram<string>({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.5, 1, 2, 5],
  registers: [register],
  enableExemplars: true,
});

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
 * Public endpoint: exposes RED and runtime metrics without authentication.
 */
app.get('/metrics', async (_req: Request, res: Response) => {
  try {
    res.setHeader('Content-Type', register.contentType);
    res.status(200).send(await register.metrics());
  } catch (error) {
    logger.error({ err: error }, 'Failed to collect metrics');
    res.status(500).send('Failed to collect metrics');
  }
});
//middleware
app.use((req: Request, res: Response, next) => {
  // Ne pas mesurer le scraping Prometheus
  if (req.path === '/metrics') {
    return next();
  }

  const start = process.hrtime.bigint();
  const spanContext = trace.getSpan(context.active())?.spanContext();

  res.on('finish', () => {
    const duration =
      Number(process.hrtime.bigint() - start) / 1e9;

    const route = req.route?.path ?? 'unmatched';

    const labels = {
      method: req.method,
      route,
      status_code: String(res.statusCode),
    };

    const exemplarLabels = spanContext && (spanContext.traceFlags & 1)
      ? { trace_id: spanContext.traceId, span_id: spanContext.spanId }
      : undefined;
    httpRequestsTotal.inc({ labels, value: 1, exemplarLabels });
    httpRequestDuration.observe({ labels, value: duration, exemplarLabels });
    const fields = { ...labels, duration_seconds: duration, ...exemplarLabels };
    if (res.statusCode >= 500) logger.error(fields, 'HTTP request completed');
    else logger.info(fields, 'HTTP request completed');
  });

  next();
});

// ==========================================
// Service Endpoints (Skeleton - Unimplemented)
// ==========================================

/**
 * GET /products
 * Purpose: Returns product list with stock counts.
 * Skeleton: Returns 501 Not Implemented.
 */
app.get('/products', (_req: Request, res: Response<Product[] | ErrorResponse>) => {
  // TODO [Before day 2]:
  // 1. Fetch available products and inventory levels from catalog repository.
  // 2. Return product list (200 OK).
  trace.getTracer(SERVICE_NAME).startActiveSpan('catalog.list_products', span => {
    try {
      span.setAttribute('catalog.product_count', products.length);
      res.status(200).json(products);
    } finally { span.end(); }
  });

});

/**
 * POST /inventory/reserve
 * Purpose: Locks requested items in stock.
 * Skeleton: Returns 501 Not Implemented.
 */
app.post(
  '/inventory/reserve',
  (req: Request<{}, {}, ReserveRequest>, res: Response<ReserveResponse | ErrorResponse>) => {
    // TODO [Before day 2]:
    
    // 1. Validate requested items and stock availability.
    const items = req.body?.items;

    if (!Array.isArray(items) || items.length === 0 ||
        items.some(item =>
          !item ||
          typeof item.product_id !== 'string' ||
          !Number.isInteger(item.quantity) ||
          item.quantity <= 0
        )) {
      res.status(400).json({
        error: 'Bad Request',
        message: 'Invalid items',
        status_code: 400
      });
      return;
    }

    const requested = new Map<string, number>();

    for (const item of items) {
      requested.set(
        item.product_id,
        (requested.get(item.product_id) ?? 0) + item.quantity
      );
    }

    for (const [productId, quantity] of requested) {
      const product = products.find(p => p.id === productId);

      if (!product || product.stock < quantity) {
        res.status(409).json({
          error: 'Conflict',
          message: 'Insufficient stock',
          status_code: 409
        });
        return;
      }
      if (!Number.isSafeInteger(quantity)) {
        res.status(400).json({
          error: 'Bad Request',
          message: 'Invalid total quantity',
          status_code: 400
        });
        return;
      }
    }  

    // 2. Atomically acquire lock / reserve items in stock.
    for (const [productId, quantity] of requested) {
      const product = products.find(p => p.id === productId)!;
      product.stock -= quantity;
    }

    const reservationId = randomUUID();
    reservations.set(reservationId, items);

    // 3. Return 200 OK with reservation_id or 409 Conflict if stock is insufficient.
    res.status(200).json({
      reservation_id: reservationId,
      status: 'reserved'
    });
  }
);

/**
 * POST /inventory/release
 * Purpose: Releases previously reserved stock on rollback / checkout abort.
 * Skeleton: Returns 501 Not Implemented.
 */
app.post(
  '/inventory/release',
  (req: Request<{}, {}, ReleaseRequest>, res: Response<ReleaseResponse | ErrorResponse>) => {
    // TODO [Before day 2]:
// 1. Look up reservation by reservation_id.
    const reservationId = req.body?.reservation_id;
    const items = reservations.get(reservationId);

    if (!items) {
      res.status(404).json({
        error: 'Not Found',
        message: 'Reservation not found',
        status_code: 404
      });
      return;
    }

    // 2. Release locked items back to stock inventory.
    for (const item of items) {
      const product = products.find(p => p.id === item.product_id);

      if (product) {
        product.stock += item.quantity;
      }
    }

    reservations.delete(reservationId);

    // 3. Return 200 OK with confirmation.
    res.status(200).json({
      reservation_id: reservationId,
      status: 'released'
    });
  }
);

app.listen(PORT, '0.0.0.0', () => {
  logger.info({ port: PORT }, 'Service listening');
});
