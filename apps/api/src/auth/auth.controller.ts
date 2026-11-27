/**
 * `POST /auth/login` — pre-auth endpoint used by the POS web UI
 * (`apps/web/src/features/auth/api/auth.ts`). Validates the request body
 * with class-validator, delegates to `CognitoAuthService.login`, and
 * returns `{ accessToken, tenantId, expiresIn }`.
 *
 * No guard: this is the entry point *into* the authenticated surface,
 * so no bearer token is required. Rate limiting is covered at the ALB
 * layer (per-source-IP) today and in a follow-up PR by `@nestjs/throttler`
 * once it is added to the api package — the dep is intentionally NOT
 * pulled in here (see runbook).
 */
import {
  Body,
  Controller,
  HttpCode,
  Logger,
  Post,
  Req,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { IsEmail, IsNotEmpty, IsString } from 'class-validator';
import type { IncomingMessage } from 'node:http';
import { CognitoAuthService, type LoginResult } from './cognito-auth.service';

export class LoginDto {
  @IsString()
  @IsEmail({}, { message: 'email must be a valid email' })
  email!: string;

  @IsString()
  @IsNotEmpty({ message: 'password must be a non-empty string' })
  password!: string;
}

/**
 * Minimal subset of the Express request the controller reads, so the
 * unit test can hand in a plain object without pulling a full Express
 * `Request` type.
 */
interface MinimalReq {
  headers?: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string };
  ip?: string;
}

@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(private readonly cognito: CognitoAuthService) {}

  @Post('login')
  @HttpCode(200)
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: false, transform: true }))
  async login(@Body() body: LoginDto, @Req() req: MinimalReq): Promise<LoginResult> {
    const ip = extractCallerIp(req);
    // Info-level attempt log. Email is logged in full here (not redacted)
    // so SOC/support can tie a login attempt to a user when triaging; the
    // same line appears in the Sentry / Cloudwatch stream the rest of the
    // API uses, so retention + access controls are the same as every
    // other auth event. Password is NEVER echoed — Nest's pino redact
    // config drops `req.body` anyway, but we also don't include it here.
    this.logger.log({ email: body.email, ip }, 'login attempt');
    try {
      const result = await this.cognito.login(body.email, body.password);
      this.logger.log({ email: body.email, ip, tenantId: result.tenantId }, 'login success');
      return result;
    } catch (err) {
      // Error class name only — never the message body (which may carry
      // Cognito internal detail) and never the error stack.
      const errClass = (err as { name?: string }).name ?? 'Error';
      this.logger.warn({ email: body.email, ip, errorClass: errClass }, 'login failed');
      throw err;
    }
  }
}

/**
 * Picks the first entry of X-Forwarded-For when ALB set it, otherwise the
 * socket's remote address. Mirrors the extractor in
 * `cleartax-partner.guard.ts` — same ALB fronts both. Exported for the
 * unit test.
 */
export function extractCallerIp(req: MinimalReq | IncomingMessage | undefined): string {
  if (!req) return '';
  const headers = (req as MinimalReq).headers ?? {};
  const xff = headers['x-forwarded-for'];
  const raw = Array.isArray(xff) ? xff[0] : xff;
  if (typeof raw === 'string' && raw.length > 0) {
    const first = raw.split(',')[0]?.trim();
    if (first) return first;
  }
  const socket = (req as MinimalReq).socket;
  return socket?.remoteAddress ?? (req as MinimalReq).ip ?? '';
}
