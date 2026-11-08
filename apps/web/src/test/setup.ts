import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

// Ensure a UUID is always available (jsdom supports crypto, but older envs may not)
if (!globalThis.crypto) {
  // @ts-expect-error -- polyfill for jsdom
  globalThis.crypto = {};
}
if (typeof globalThis.crypto.randomUUID !== 'function') {
  (globalThis.crypto as any).randomUUID = () =>
    '00000000-0000-4000-8000-000000000000';
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
