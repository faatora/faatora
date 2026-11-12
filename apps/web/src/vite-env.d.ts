/// <reference types="vite/client" />

/**
 * Typed Vite env for the web app. Every `VITE_*` var we read at
 * runtime must have an entry here; TypeScript otherwise widens
 * `import.meta.env.VITE_FOO` to `any`.
 *
 * All members are optional because Vite inlines whatever is set at
 * build time — a missing var is `undefined`, not an error.
 */
interface ImportMetaEnv {
  /** Sentry DSN for the browser SDK. Unset disables Sentry entirely. */
  readonly VITE_SENTRY_DSN?: string;
  /** 0..1 traces sample rate; parsed as float. Default "0.1". */
  readonly VITE_SENTRY_TRACES_SAMPLE_RATE?: string;
  /** API base URL (apps/web/src/lib/api.ts). */
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
