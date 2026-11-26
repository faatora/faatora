/**
 * Boot-graph smoke test.
 *
 * Nothing exercised here; the test just asserts that the full `AppModule`
 * DI graph compiles within a bounded time. That's the signal we didn't
 * have on 2026-11-26 when a `useExisting` circular in `ClearanceModule`
 * (PR #20) and then a nullable-union constructor type in `StubAspProvider`
 * (PR #21) each shipped silently to prod and spent a full day in staging
 * before someone noticed the ALB was returning 503s.
 *
 * The real Nest resolver runs here the same way it runs in a staging
 * container, so a provider that never resolves, a circular DI the
 * `useExisting` resolver can't break, or a `design:paramtypes` `Object`
 * that Nest can't bind, all surface as a quick failure instead of a
 * silent `process.exit(0)` on staging:3000.
 *
 * SCOPE. We boot the DI graph only (`Test.createTestingModule(...).compile()`),
 * not an HTTP server; the goal is injector coverage, not route coverage.
 * We disable the clearance drain so the @Cron scheduler doesn't tick an
 * actual DB query during the 10-second window.
 *
 * NOT catching. This test does not validate business logic — unit specs
 * and the per-module integration specs do that. It is a regression guard
 * on *boot shape* only. Keep it short; a slow boot test erodes the fast
 * feedback the rest of the suite gives.
 */
import { Test, type TestingModule } from '@nestjs/testing';
import { AppModule } from '../src/app.module';

describe('AppModule boot shape', () => {
  // Suppress the clearance cron so the @Cron('*/10 * * * * *') tick in
  // ClearanceScheduler doesn't fire a drainOnce() against the test DB
  // in the middle of compile() on slower CI boxes.
  process.env.DISABLE_CLEARANCE_CRON = '1';

  let mod: TestingModule;

  afterAll(async () => {
    if (mod) await mod.close();
  });

  it('compiles the full DI graph within 15 s', async () => {
    const started = Date.now();
    mod = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const tookMs = Date.now() - started;
    // Soft budget: 15 s is the Jest timeout below. A healthy compile on
    // CI is ~1–2 s; a 10 s compile is already a yellow flag worth the
    // follow-up but not a failure here (the hang we care about parked
    // on the InstanceLoader for 150 s before our 2026-11-26 outage
    // hit its container timeout). Log so a slow regression is visible
    // in CI output.
    // eslint-disable-next-line no-console
    console.log(`[boot-smoke] AppModule compile took ${tookMs} ms`);
  }, 15_000);
});
