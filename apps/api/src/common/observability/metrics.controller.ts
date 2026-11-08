import { Controller, Get, Header, Res } from '@nestjs/common';
import { defaultRegistry } from './metrics';

/**
 * Prometheus scrape endpoint.
 *
 * NO AUTH BY DESIGN — Prometheus clients cannot easily carry a Cognito
 * JWT, and the response contains only aggregate counters/gauges (no
 * PII, no tenant data beyond opaque tenant_id labels). In production
 * this route is network-restricted at the ALB level to the scraper's
 * security-group CIDR; the README documents the deployment contract.
 *
 * Content-Type is `text/plain; version=0.0.4` — Prometheus's expected
 * exposition format version.
 */
interface MinimalResponse {
  status(code: number): unknown;
}

@Controller('metrics')
export class MetricsController {
  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  async scrape(@Res({ passthrough: true }) res: MinimalResponse): Promise<string> {
    // `metrics()` is async because of the default-metric async hooks.
    const body = await defaultRegistry.metrics();
    res.status(200);
    return body;
  }
}
