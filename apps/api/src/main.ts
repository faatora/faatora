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
  await app.listen(env.PORT);
}
void bootstrap();
