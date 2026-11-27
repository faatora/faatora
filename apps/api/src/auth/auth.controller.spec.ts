/**
 * Unit tests for `AuthController` (POST /auth/login).
 *
 * Uses Nest's testing kit end-to-end so the global ValidationPipe actually
 * runs and the controller's own `@UsePipes` wiring is exercised. The
 * `CognitoAuthService` is replaced with a hand-rolled mock.
 */
import type { INestApplication } from '@nestjs/common';
import { UnauthorizedException, ValidationPipe } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import request from 'supertest';

import { AuthController, extractCallerIp } from './auth.controller';
import { CognitoAuthService } from './cognito-auth.service';

describe('AuthController', () => {
  let app: INestApplication;
  let cognito: { login: jest.Mock };

  beforeEach(async () => {
    cognito = { login: jest.fn() };
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [{ provide: CognitoAuthService, useValue: cognito }],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    // Global pipe matches main.ts (so 400s shape the same way).
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }),
    );
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('happy path -> 200 with { accessToken, tenantId, expiresIn }', async () => {
    cognito.login.mockResolvedValue({
      accessToken: 'tok.abc.def',
      tenantId: 'tenant-1',
      expiresIn: 3_600_000,
    });
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'clerk@shop.example.com', password: 'hunter22' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      accessToken: 'tok.abc.def',
      tenantId: 'tenant-1',
      expiresIn: 3_600_000,
    });
    expect(cognito.login).toHaveBeenCalledWith('clerk@shop.example.com', 'hunter22');
  });

  it('missing email -> 400', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ password: 'hunter22' });
    expect(res.status).toBe(400);
    expect(cognito.login).not.toHaveBeenCalled();
  });

  it('non-email email -> 400', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'not an email', password: 'hunter22' });
    expect(res.status).toBe(400);
    expect(cognito.login).not.toHaveBeenCalled();
  });

  it('empty password -> 400', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'ok@ok.example.com', password: '' });
    expect(res.status).toBe(400);
    expect(cognito.login).not.toHaveBeenCalled();
  });

  it('non-string password -> 400', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'ok@ok.example.com', password: 12345 });
    expect(res.status).toBe(400);
    expect(cognito.login).not.toHaveBeenCalled();
  });

  it('service throws UnauthorizedException -> 401 with the thrown message', async () => {
    cognito.login.mockRejectedValue(new UnauthorizedException('invalid credentials'));
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'clerk@shop.example.com', password: 'bad' });
    expect(res.status).toBe(401);
    expect(res.body.message).toBe('invalid credentials');
  });

  it('service throws UnauthorizedException("mfa required") -> 401 with that message', async () => {
    cognito.login.mockRejectedValue(
      new UnauthorizedException('mfa required; use the full web sign-in flow'),
    );
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'clerk@shop.example.com', password: 'good' });
    expect(res.status).toBe(401);
    expect(res.body.message).toBe('mfa required; use the full web sign-in flow');
  });
});

describe('AuthController helpers', () => {
  describe('extractCallerIp', () => {
    it('prefers first X-Forwarded-For entry', () => {
      expect(
        extractCallerIp({
          headers: { 'x-forwarded-for': '1.2.3.4, 10.0.0.1' },
          socket: { remoteAddress: '10.0.0.1' },
        }),
      ).toBe('1.2.3.4');
    });

    it('falls back to socket.remoteAddress', () => {
      expect(extractCallerIp({ headers: {}, socket: { remoteAddress: '10.0.0.5' } })).toBe(
        '10.0.0.5',
      );
    });

    it('returns empty string when nothing is set', () => {
      expect(extractCallerIp({ headers: {} })).toBe('');
      expect(extractCallerIp(undefined)).toBe('');
    });
  });
});
