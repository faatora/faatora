import { z } from 'zod';
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  DATABASE_URL: z.string().url(),
  MIGRATION_DATABASE_URL: z.string().url().optional(),
  AWS_REGION: z.string().default('me-south-1'),
  COGNITO_USER_POOL_ID: z.string().optional(),
  COGNITO_CLIENT_ID: z.string().optional(),
  // SEC-003: shared secret used to HMAC-verify inbound ASP webhook callbacks
  // against `x-asp-signature`. In production this MUST be set — the callback
  // controller refuses to accept any payload without it (503). In dev/test
  // it may be left unset; the controller logs a warn and skips verification
  // so stub-ASP integration tests still work.
  ASP_WEBHOOK_SECRET: z.string().optional(),
  // Firm-console subscription billing. Defaults to `stripe`; the
  // module factory binds the matching adapter. Keep lowercase to
  // match the switch inside FirmBillingModule.
  BILLING_PROVIDER: z.enum(['stripe', 'paymob']).default('stripe'),
  // Required when BILLING_PROVIDER=stripe and NODE_ENV=production.
  // Optional in dev so unrelated test suites can boot without Stripe
  // credentials; the stub adapter throws on first use.
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  // Required when BILLING_PROVIDER=paymob and NODE_ENV=production.
  // Optional in dev so unrelated test suites can boot without Paymob
  // credentials. PAYMOB_HMAC_SECRET gets a special pass in dev only;
  // in prod it is mandatory (webhook verification refuses otherwise).
  // See docs/research/paymob-uat-integration-plan.md section 8 for how
  // Ahmed pulls these from the Paymob dashboard.
  PAYMOB_API_KEY: z.string().optional(),
  // PAYMOB_SECRET_KEY is the sk_test_... / sk_live_... value used on
  // the Intention API as `Authorization: Token <secret>`. Required in
  // production under BILLING_PROVIDER=paymob; the adapter boot refuses
  // without it. See docs/research/paymob-intention-api-refactor-design.md.
  PAYMOB_SECRET_KEY: z.string().optional(),
  // PAYMOB_PUBLIC_KEY is the pk_test_... / pk_live_... value that
  // goes on the Unified Checkout URL query string. Required in
  // production under BILLING_PROVIDER=paymob.
  PAYMOB_PUBLIC_KEY: z.string().optional(),
  PAYMOB_HMAC_SECRET: z.string().optional(),
  PAYMOB_INTEGRATION_ID: z.string().optional(),
  // Legacy iframe id. Unused by the new Unified Checkout flow but
  // still required to boot so the stub fallback matches historical
  // shape. Remove in a later wave once the firm-console UI is cut
  // over to the Unified Checkout redirect.
  PAYMOB_IFRAME_ID: z.string().optional(),
  // Override only when staging against Egypt/UAE instead of Oman.
  // This is the API host (where /v1/intention/ and /api/* live).
  PAYMOB_BASE_URL: z.string().url().optional(),
  // Unified Checkout host. Different from the API host: for Oman
  // production it is https://om.checkout.paymob.com (per-region
  // hosts are documented in the Unified Checkout docs). Override
  // when staging against another region.
  PAYMOB_CHECKOUT_URL: z.string().url().optional(),
  // Faatora-hosted customer portal route; Paymob has no hosted portal
  // (see research doc section 3).
  PAYMOB_PORTAL_RETURN_URL: z.string().url().optional(),
  // SEC-002 note: `NODE_ENV=production` plus a configured KMS implementation
  // is REQUIRED for the sign-in-prod path to boot. The signing module binds
  // KmsSigner on production and KmsSigner currently throws on every sign —
  // operators must wire the KMS KeyId before go-live.
});
export type Env = z.infer<typeof envSchema>;
let cached: Env | null = null;
export function loadEnv(): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error('Invalid env', parsed.error.flatten().fieldErrors);
    process.exit(1);
  }
  cached = parsed.data;
  return cached;
}
