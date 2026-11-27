/**
 * Prod-boot guard on StubAspProvider.
 *
 * The stub fabricates OTA clearance verdicts; shipping it in production
 * silently means invoices look cleared when they are not — a compliance
 * gap we must refuse, loudly, at boot time. These tests pin the three
 * paths of the constructor guard added 2026-11-27.
 */

import type { ModuleRef } from '@nestjs/core';
import { StubAspProvider } from '../src/modules/clearance/stub-asp';

const fakeModuleRef = {
  get(): never {
    throw new Error('fakeModuleRef.get() called from a test path that should not reach it');
  },
} as unknown as ModuleRef;

function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(overrides)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe('StubAspProvider prod-boot guard', () => {
  it('constructs without complaint in development', () => {
    withEnv({ NODE_ENV: 'development', ALLOW_STUB_ASP_IN_PRODUCTION: undefined }, () => {
      expect(() => new StubAspProvider(fakeModuleRef)).not.toThrow();
    });
  });

  it('constructs without complaint in test', () => {
    withEnv({ NODE_ENV: 'test', ALLOW_STUB_ASP_IN_PRODUCTION: undefined }, () => {
      expect(() => new StubAspProvider(fakeModuleRef)).not.toThrow();
    });
  });

  it('refuses to boot under NODE_ENV=production without the escape hatch', () => {
    withEnv({ NODE_ENV: 'production', ALLOW_STUB_ASP_IN_PRODUCTION: undefined }, () => {
      expect(() => new StubAspProvider(fakeModuleRef)).toThrow(
        /StubAspProvider: refusing to boot under NODE_ENV=production/,
      );
    });
  });

  it('boots in production when the explicit escape hatch is set to 1', () => {
    withEnv({ NODE_ENV: 'production', ALLOW_STUB_ASP_IN_PRODUCTION: '1' }, () => {
      expect(() => new StubAspProvider(fakeModuleRef)).not.toThrow();
    });
  });

  it('refuses in production when the escape hatch is any value other than exactly 1', () => {
    for (const v of ['true', 'yes', '0', '']) {
      withEnv({ NODE_ENV: 'production', ALLOW_STUB_ASP_IN_PRODUCTION: v }, () => {
        expect(() => new StubAspProvider(fakeModuleRef)).toThrow(/refusing to boot/);
      });
    }
  });
});
