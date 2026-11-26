// Sentry MUST be imported and initialised before any other module so
// that its auto-instrumentation can patch http/https + express before
// Nest wires them. Keep this at the top of the file.
import { initSentry } from './common/observability/sentry';
const sentryEnabled = initSentry();

import { NestFactory, HttpAdapterHost } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { Logger } from 'nestjs-pino';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { loadEnv } from './config/env';
import { SentryExceptionFilter } from './common/filters/sentry-exception.filter';

// --- Boot observability -----------------------------------------------------
//
// These primitives run BEFORE Nest's DI container is built, so they cannot
// use the pino logger. They write plain lines to stderr, which Fargate
// forwards verbatim to the CloudWatch log group bound to the task.
//
// WHY: on 2026-11-24 we spent a full day chasing a silent prod crash where
// the container exited with no diagnostic because `bufferLogs: true` (set
// below) held every log line in memory until `app.useLogger()` was called,
// but NestFactory.create() threw first (a dynamic `await import('cron')`
// from @nestjs/schedule hit a missing transitive dep — see PR #15). The
// buffer was discarded at process exit; CloudWatch saw nothing but the
// container-stop event. These stderr markers guarantee that even if
// create() hangs or throws before the pino logger is attached, we still
// have a timeline in the task log.
//
// Keep these lightweight: no JSON serialisation, no imports — a failure
// in a dependency here would defeat the point.
process.stderr.write(`[boot] main.ts loaded pid=${process.pid} node=${process.version}\n`);
process.stderr.write(`[boot] sentry ${sentryEnabled ? 'enabled' : 'disabled (no SENTRY_DSN)'}\n`);

// Top-level process-exit marker. Nest's shutdown hooks run before this and
// usually log through pino; this fires LAST and catches silent exits
// (unhandled rejection, OOM kill, `process.exit(1)` from a dep, etc.).
// Any code >0 that lands here without a preceding error log in CloudWatch
// is a boot-time failure the operator should treat as pageable.
process.on('exit', (code) => {
  process.stderr.write(`[boot] process exiting code=${code}\n`);
});

async function bootstrap() {
  const env = loadEnv();
  process.stderr.write(`[boot] env loaded NODE_ENV=${env.NODE_ENV} PORT=${env.PORT}\n`);
  // bufferLogs: FALSE (was true before the 2026-11-24 outage).
  //
  // `bufferLogs: true` tells Nest to collect every log line emitted during
  // module construction into an in-memory buffer and replay it through the
  // logger installed via `app.useLogger()`. If NestFactory.create() throws
  // BEFORE useLogger runs (which is what happened when @nestjs/schedule
  // tried to `await import('cron')` against a stripped node_modules), the
  // buffer is dropped on the floor and the operator sees nothing in
  // CloudWatch beyond the ECS task-stop reason. We trade slightly uglier
  // boot output (default Nest console logger prints the first few lines
  // before pino takes over) for a guaranteed log trail on failure. This is
  // the correct trade-off for a regulated e-invoicing service — observability
  // of prod incidents beats log aesthetics every time.
  //
  // rawBody: required so the billing webhook controller can verify
  // Stripe signatures against the unparsed body. The flag only exposes
  // `req.rawBody` to controllers that opt in via @Req()/RawBodyRequest;
  // other controllers keep the parsed body as before.
  process.stderr.write('[boot] calling NestFactory.create()\n');
  const app = await NestFactory.create(AppModule, { bufferLogs: false, rawBody: true });
  process.stderr.write('[boot] NestFactory.create() returned, wiring middleware\n');
  app.useLogger(app.get(Logger));
  app.use(helmet());
  app.enableShutdownHooks();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.setGlobalPrefix('api');

  // Global Sentry filter: forwards 5xx + uncaught errors to Sentry
  // (4xx are skipped — see filter). Attached whether or not the SDK
  // is initialised; when it isn't, Sentry.captureException is a
  // documented no-op and the filter just delegates to the default.
  app.useGlobalFilters(new SentryExceptionFilter(app.get(HttpAdapterHost)));

  // CORS. Allow the production Vercel deploy, Vercel preview URLs,
  // localhost for dev, and the planned custom domains. Add more via
  // the CORS_ORIGINS env var (comma-separated list of origins or
  // regex-safe origin strings) in staging/prod task definitions.
  const extraOrigins = (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  app.enableCors({
    origin: [
      /^https:\/\/faatora-[a-z0-9-]+\.vercel\.app$/,
      'https://faatora-ten.vercel.app',
      /^https?:\/\/localhost(:\d+)?$/,
      'https://app.faatora.om',
      'https://faatora.om',
      'https://www.faatora.om',
      ...extraOrigins,
    ],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-firm-id', 'x-request-id'],
    exposedHeaders: ['x-request-id'],
    maxAge: 3600,
  });

  if (sentryEnabled) {
    app.get(Logger).log(
      {
        env: env.NODE_ENV,
        tracesSampleRate: process.env.SENTRY_TRACES_SAMPLE_RATE ?? '0.1',
      },
      'Sentry initialised',
    );
  }

  await app.listen(env.PORT);
  process.stderr.write(`[boot] app.listen bound to :${env.PORT} — ready\n`);
}

// Catch bootstrap rejections and surface them on stderr BEFORE Node's
// default unhandled-rejection handler runs. Without this the stack trace
// still reaches CloudWatch (Node prints it on exit) but is interleaved
// with the "[boot] process exiting" line from the exit handler above —
// explicit is better.
bootstrap().catch((err: unknown) => {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`[boot] bootstrap() rejected: ${msg}\n`);
  process.exitCode = 1;
});
