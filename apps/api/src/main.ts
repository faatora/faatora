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
async function bootstrap() {
  const env = loadEnv();
  // rawBody: required so the billing webhook controller can verify
  // Stripe signatures against the unparsed body. The flag only exposes
  // `req.rawBody` to controllers that opt in via @Req()/RawBodyRequest;
  // other controllers keep the parsed body as before.
  const app = await NestFactory.create(AppModule, { bufferLogs: true, rawBody: true });
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
}
void bootstrap();
