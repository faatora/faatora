/**
 * Unit tests for `CognitoAuthService`.
 *
 * The Cognito SDK client is mocked with `aws-sdk-client-mock` (already a
 * devDep from #27) so we never touch AWS. Each test asserts one branch
 * of the service's error mapping and the happy path. Style follows
 * `cleartax-partner.guard.spec.ts`.
 *
 * `loadEnv` is mocked so we can swap COGNITO_CLIENT_ID / AWS_REGION per
 * test without fighting the real env schema's cache.
 */
import { createHmac } from 'node:crypto';
import { InternalServerErrorException, UnauthorizedException } from '@nestjs/common';
import { mockClient } from 'aws-sdk-client-mock';
import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
} from '@aws-sdk/client-cognito-identity-provider';

jest.mock('../config/env', () => ({
  loadEnv: jest.fn(),
}));

import { loadEnv } from '../config/env';
import { CognitoAuthService, computeSecretHash, decodeJwtPayload } from './cognito-auth.service';

const mockedLoadEnv = loadEnv as jest.MockedFunction<typeof loadEnv>;
const cognitoMock = mockClient(CognitoIdentityProviderClient);

const CLIENT_ID = 'test-client-id';
const EMAIL = 'clerk@shop.example.com';
const PASSWORD = 'correct horse battery staple';

/** Build a JWT whose payload carries the given fields. Signature is
 * irrelevant — the service never verifies it. */
function makeAccessToken(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.sig`;
}

/** Default env shape good enough for every branch. */
function envWith(extra: Partial<Record<string, string>> = {}): any {
  return {
    NODE_ENV: 'test',
    AWS_REGION: 'me-south-1',
    COGNITO_USER_POOL_ID: 'me-south-1_Test123',
    COGNITO_CLIENT_ID: CLIENT_ID,
    ...extra,
  };
}

describe('CognitoAuthService', () => {
  let service: CognitoAuthService;
  const origSecret = process.env.COGNITO_CLIENT_SECRET;

  beforeEach(() => {
    cognitoMock.reset();
    mockedLoadEnv.mockReset();
    mockedLoadEnv.mockReturnValue(envWith());
    delete process.env.COGNITO_CLIENT_SECRET;
    service = new CognitoAuthService();
  });

  afterAll(() => {
    if (origSecret === undefined) delete process.env.COGNITO_CLIENT_SECRET;
    else process.env.COGNITO_CLIENT_SECRET = origSecret;
  });

  it('happy path: returns parsed accessToken + tenantId + expiresIn (seconds)', async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600; // +1h
    const token = makeAccessToken({ sub: 'u-1', 'custom:tenant_id': 'tenant-abc', exp });
    cognitoMock.on(InitiateAuthCommand).resolves({
      AuthenticationResult: { AccessToken: token },
    });

    const res = await service.login(EMAIL, PASSWORD);

    expect(res.accessToken).toBe(token);
    expect(res.tenantId).toBe('tenant-abc');
    // Allow a wide window — test boxes may be slow.
    expect(res.expiresIn).toBeGreaterThan(3500);
    expect(res.expiresIn).toBeLessThanOrEqual(3600);

    // Confirm the command was sent with USER_PASSWORD_AUTH and no SECRET_HASH
    // (we did not set a client secret in beforeEach).
    const calls = cognitoMock.commandCalls(InitiateAuthCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0].args[0].input;
    expect(input.AuthFlow).toBe('USER_PASSWORD_AUTH');
    expect(input.ClientId).toBe(CLIENT_ID);
    expect(input.AuthParameters?.USERNAME).toBe(EMAIL);
    expect(input.AuthParameters?.PASSWORD).toBe(PASSWORD);
    expect(input.AuthParameters?.SECRET_HASH).toBeUndefined();
  });

  it('NotAuthorizedException -> 401 "invalid credentials"', async () => {
    cognitoMock.on(InitiateAuthCommand).rejects(
      Object.assign(new Error('bad'), {
        name: 'NotAuthorizedException',
      }),
    );
    const err: UnauthorizedException = await service.login(EMAIL, PASSWORD).catch((e) => e);
    expect(err).toBeInstanceOf(UnauthorizedException);
    expect(err.message).toBe('invalid credentials');
    expect(err.getStatus()).toBe(401);
  });

  it('UserNotFoundException -> 401 with SAME generic message (no enumeration)', async () => {
    cognitoMock.on(InitiateAuthCommand).rejects(
      Object.assign(new Error('nope'), {
        name: 'UserNotFoundException',
      }),
    );
    const err: UnauthorizedException = await service.login(EMAIL, PASSWORD).catch((e) => e);
    expect(err).toBeInstanceOf(UnauthorizedException);
    // Must be byte-identical to the NotAuthorizedException message so an
    // attacker cannot distinguish "wrong password" from "no such user".
    expect(err.message).toBe('invalid credentials');
    expect(err.getStatus()).toBe(401);
  });

  it('PasswordResetRequiredException -> 401 with distinct message', async () => {
    cognitoMock.on(InitiateAuthCommand).rejects(
      Object.assign(new Error('reset'), {
        name: 'PasswordResetRequiredException',
      }),
    );
    const err: UnauthorizedException = await service.login(EMAIL, PASSWORD).catch((e) => e);
    expect(err).toBeInstanceOf(UnauthorizedException);
    expect(err.message).toBe('password reset required');
    expect(err.getStatus()).toBe(401);
  });

  it('UserNotConfirmedException -> 401 with distinct message', async () => {
    cognitoMock.on(InitiateAuthCommand).rejects(
      Object.assign(new Error('unconfirmed'), {
        name: 'UserNotConfirmedException',
      }),
    );
    const err: UnauthorizedException = await service.login(EMAIL, PASSWORD).catch((e) => e);
    expect(err).toBeInstanceOf(UnauthorizedException);
    expect(err.message).toBe('account not confirmed');
    expect(err.getStatus()).toBe(401);
  });

  it('ChallengeName on response -> 401 "mfa required" (no challenge flow in POS)', async () => {
    cognitoMock.on(InitiateAuthCommand).resolves({
      ChallengeName: 'SOFTWARE_TOKEN_MFA',
      Session: 'opaque',
    });
    const err: UnauthorizedException = await service.login(EMAIL, PASSWORD).catch((e) => e);
    expect(err).toBeInstanceOf(UnauthorizedException);
    expect(err.message).toBe('mfa required; use the full web sign-in flow');
    expect(err.getStatus()).toBe(401);
  });

  it('unknown Cognito error -> 500 (generic, no detail leak)', async () => {
    cognitoMock.on(InitiateAuthCommand).rejects(
      Object.assign(new Error('xyz'), {
        name: 'InvalidParameterException',
      }),
    );
    const err = await service.login(EMAIL, PASSWORD).catch((e) => e);
    expect(err).toBeInstanceOf(InternalServerErrorException);
    expect(err.getStatus()).toBe(500);
  });

  it('missing custom:tenant_id claim -> 401 "no tenant assigned"', async () => {
    const exp = Math.floor(Date.now() / 1000) + 600;
    const token = makeAccessToken({ sub: 'u-1', exp });
    cognitoMock.on(InitiateAuthCommand).resolves({
      AuthenticationResult: { AccessToken: token },
    });
    const err: UnauthorizedException = await service.login(EMAIL, PASSWORD).catch((e) => e);
    expect(err).toBeInstanceOf(UnauthorizedException);
    expect(err.message).toBe('no tenant assigned');
    expect(err.getStatus()).toBe(401);
  });

  it('no AccessToken on success response -> 500', async () => {
    cognitoMock.on(InitiateAuthCommand).resolves({ AuthenticationResult: {} });
    const err = await service.login(EMAIL, PASSWORD).catch((e) => e);
    expect(err).toBeInstanceOf(InternalServerErrorException);
  });

  it('missing COGNITO_CLIENT_ID -> 500 (misconfig)', async () => {
    mockedLoadEnv.mockReturnValue(envWith({ COGNITO_CLIENT_ID: undefined as any }));
    const err = await service.login(EMAIL, PASSWORD).catch((e) => e);
    expect(err).toBeInstanceOf(InternalServerErrorException);
  });

  it('computes SECRET_HASH when COGNITO_CLIENT_SECRET is set', async () => {
    process.env.COGNITO_CLIENT_SECRET = 'super-secret-value';

    const exp = Math.floor(Date.now() / 1000) + 3600;
    const token = makeAccessToken({ sub: 'u-1', 'custom:tenant_id': 'tenant-abc', exp });
    cognitoMock.on(InitiateAuthCommand).resolves({
      AuthenticationResult: { AccessToken: token },
    });

    await service.login(EMAIL, PASSWORD);

    const calls = cognitoMock.commandCalls(InitiateAuthCommand);
    expect(calls).toHaveLength(1);
    const hash = calls[0].args[0].input.AuthParameters?.SECRET_HASH;
    expect(hash).toBeDefined();
    const expected = createHmac('sha256', 'super-secret-value')
      .update(EMAIL + CLIENT_ID)
      .digest('base64');
    expect(hash).toBe(expected);
  });

  describe('helpers', () => {
    it('computeSecretHash matches the AWS formula', () => {
      // Golden value: HMAC_SHA256('s', 'u' + 'c') base64.
      const h = computeSecretHash('u', 'c', 's');
      const expected = createHmac('sha256', 's').update('uc').digest('base64');
      expect(h).toBe(expected);
    });

    it('decodeJwtPayload returns {} on malformed input', () => {
      expect(decodeJwtPayload('not-a-jwt')).toEqual({});
      expect(decodeJwtPayload('a')).toEqual({});
    });

    it('decodeJwtPayload base64url-decodes the payload', () => {
      const t = makeAccessToken({ sub: 'u-1', 'custom:tenant_id': 't-1', exp: 123 });
      expect(decodeJwtPayload(t)).toEqual({ sub: 'u-1', 'custom:tenant_id': 't-1', exp: 123 });
    });
  });
});
