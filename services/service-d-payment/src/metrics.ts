import type { Request, Response, NextFunction } from 'express';
import { Counter, Histogram, Registry } from 'prom-client';

export const registry = new Registry();
const labels = ['method', 'route', 'status_code'] as const;
const requests = new Counter({
  name: 'http_requests_total', help: 'Completed HTTP requests.',
  labelNames: labels, registers: [registry],
});
const durations = new Histogram({
  name: 'http_request_duration_seconds', help: 'HTTP request duration in seconds.',
  labelNames: labels, registers: [registry],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.15, 0.25, 0.5, 1, 2, 5],
});

export function observeHttp(req: Request, res: Response, next: NextFunction): void {
  // Scrapes are excluded, so observing the service does not inflate its traffic.
  if (req.path === '/metrics') { next(); return; }
  const start = process.hrtime.bigint();
  res.once('finish', () => {
    const method = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(req.method)
      ? req.method : 'OTHER';
    const values = { method, route: req.route?.path || 'unmatched', status_code: String(res.statusCode) };
    requests.inc(values);
    durations.observe(values, Number(process.hrtime.bigint() - start) / 1e9);
  });
  next();
}
