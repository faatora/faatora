import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { Logger } from 'nestjs-pino';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { loadEnv } from './config/env';
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

  await app.listen(env.PORT);
}
void bootstrap();
