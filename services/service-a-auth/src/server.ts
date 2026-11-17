import { prometheusExporter } from './instrumentation';
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import pino from 'pino';
import { metrics, trace } from '@opentelemetry/api';
import { LoginRequest, TokenResponse, AuthVerifyResponse, ErrorResponse } from './types';

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8081;
const SERVICE_NAME = 'service-a-auth';
const logger = pino({
  base: { service: SERVICE_NAME },
  formatters: { level: (label) => ({ level: label }) },
});
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const TOKEN_TTL_SECONDS =  3600;


const meter = metrics.getMeter(SERVICE_NAME);

// R and E: counts every request, split by method, route and status code
// OpenTelemetry adds the _total suffix itself: exported as http_requests_total
const httpRequestsTotal = meter.createCounter('http_requests', {
  description: 'Total number of HTTP requests',
});

// D: measures how long each request takes, in seconds
const httpRequestDuration = meter.createHistogram('http_request_duration_seconds', {
  description: 'HTTP request duration in seconds',
  unit: 's',
  advice: { explicitBucketBoundaries: [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1] },
});

// Measures every request for the RED metrics, and writes one JSON log line per request
app.use((req: Request, res: Response, next: NextFunction) => {
  // Skip Prometheus's own visits to /metrics so they do not pollute the numbers
  if (req.path === '/metrics') return next();
  // Remember the trace ID now, while the request's span is active
  const traceId = trace.getActiveSpan()?.spanContext().traceId;
  // Start the stopwatch (milliseconds since the process started)
  const start = performance.now();
  // 'finish' fires once the response has been sent
  res.on('finish', () => {
    const labels = {
      method: req.method,
      // The route pattern, or 'unmatched' for unknown URLs
      route: req.route ? req.route.path : 'unmatched',
      status_code: String(res.statusCode),
    };
    // Stop the stopwatch and convert milliseconds to seconds
    const seconds = (performance.now() - start) / 1000;
    httpRequestsTotal.add(1, labels);
    httpRequestDuration.record(seconds, labels);
    const logFields = { ...labels, duration_ms: Math.round(seconds * 1000), trace_id: traceId };
    if (res.statusCode >= 500) logger.error(logFields, 'request failed');
    else if (res.statusCode >= 400) logger.warn(logFields, 'request rejected');
    else logger.info(logFields, 'request completed');
  });
  // Let the request continue to the next middleware and to the route
  next();
});

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
 * Skeleton: Returns 501 Not Implemented.
 * TODO [Lab 2]: Install prom-client and implement RED metrics collection (http_requests_total, http_request_duration_seconds).
 */
app.get('/metrics', (req: Request, res: Response) => {
  prometheusExporter.getMetricsRequestHandler(req, res);
});

// ==========================================
// Service Endpoints (Skeleton - Unimplemented)
// ==========================================
const users = new Map<string, { user_id: string; password: string }>();
for (let i = 1; i <= 20; i++) {
  users.set(`user${i}`, { user_id: `USER-${i}`, password: `password${i}` });
}
/**
 * POST /auth/login
 * Purpose: Accepts customer credentials, issues JWT or session token.
 * Skeleton: Returns 501 Not Implemented.
 */
app.post('/auth/login', (req: Request<{}, {}, LoginRequest>, res: Response<TokenResponse | ErrorResponse>) => {
  // TODO [Before day 2]:
  // 1. Validate credentials payload.
  const { username, password } = req.body;
  if (!username || !password || typeof username !== 'string' || typeof password !== 'string' || username.trim().length === 0 || password.trim().length === 0) {
    res.status(400).json({
      error: 'Bad Request', 
      message: 'Username and password are required and must be non-empty strings.',
      status_code: 400,
    });
    return;
  }

  const user = users.get(username);
  if (!user || user.password !== password) {
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid username or password.',
      status_code: 401,
    });
    return;
  }
   // 3. Inject trace context and baggage.
  trace.getActiveSpan()?.setAttribute('enduser.id', user.user_id);

  // 2. Issue signed JWT/session token containing user ID.
  const token = jwt.sign({ user_id: user.user_id }, JWT_SECRET, { expiresIn: TOKEN_TTL_SECONDS });
  res.status(200).json({
    token,
    user_id: user.user_id,
    expires_in: TOKEN_TTL_SECONDS,
  });

  // 4. Return TokenResponse (200 OK) or Unauthorized (401).
 
});

/**
 * GET /auth/verify
 * Purpose: Validates token in Authorization header: Bearer <token>.
 * Skeleton: Returns 501 Not Implemented.
 */
app.get('/auth/verify', (req: Request, res: Response<AuthVerifyResponse | ErrorResponse>) => {
  // TODO [Before day 2]:
  // 1. Extract Bearer token from req.headers.authorization.
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Missing or invalid Authorization header. Expected format: Bearer <token>.',
      status_code: 401,
    });
    return;
  }
  const token = authHeader.split(' ')[1]; 
  // 2. Verify signature and expiry.
  let payload : {user_id:string}
  try {
    payload = jwt.verify(token, JWT_SECRET) as { user_id: string };
  } catch (err) {
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid or expired token.',
      status_code: 401,
    });
    return;
  }
  
  // 3. Inject user context into span / baggage.
  trace.getActiveSpan()?.setAttribute('enduser.id', payload.user_id);
  // 4. Return AuthVerifyResponse (200 OK) or Unauthorized (401).
  res.status(200).json({
    user_id: payload.user_id,
    valid: true,
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[${SERVICE_NAME}] listening on port ${PORT}`);
});
