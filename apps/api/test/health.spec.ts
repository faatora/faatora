import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { Global, Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import request from 'supertest';
import { HealthController } from '../src/modules/health/health.controller';
import { DB } from '../src/db/db.module';

/**
 * The health endpoint used to be a tautology (`check([])` → always ok);
 * it is now a real database ping. These tests exercise both the happy
 * path and the DB-down path so the ALB health-check contract is pinned.
 *
 * In production DbModule is `@Global` and provides the real `DB` token.
 * Here we stand up a minimal `@Global` stub module per case that
 * exports a mocked drizzle handle, then compose it with TerminusModule
 * + HealthController just like HealthModule does in prod.
 */
function buildStubDbModule(db: unknown) {
  @Global()
  @Module({
    providers: [{ provide: DB, useValue: db }],
    exports: [DB],
  })
  class StubDbModule {}
  return StubDbModule;
}

describe('Health', () => {
  describe('with a healthy database', () => {
    let app: INestApplication;
    const okDb = { execute: jest.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }) };

    beforeAll(async () => {
      const m = await Test.createTestingModule({
        imports: [TerminusModule, buildStubDbModule(okDb)],
        controllers: [HealthController],
      }).compile();
      app = m.createNestApplication();
      await app.init();
    });
    afterAll(async () => {
      await app.close();
    });

    it('GET /health returns 200 and status ok', async () => {
      const res = await request(app.getHttpServer()).get('/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.info).toHaveProperty('database');
      expect(res.body.info.database.status).toBe('up');
      expect(okDb.execute).toHaveBeenCalledWith('SELECT 1');
    });
  });

  describe('with a broken database', () => {
    let app: INestApplication;
    const brokenDb = {
      execute: jest.fn().mockRejectedValue(new Error('ECONNREFUSED 127.0.0.1:5432')),
    };

    beforeAll(async () => {
      const m = await Test.createTestingModule({
        imports: [TerminusModule, buildStubDbModule(brokenDb)],
        controllers: [HealthController],
      }).compile();
      app = m.createNestApplication();
      await app.init();
    });
    afterAll(async () => {
      await app.close();
    });

    it('GET /health returns 503 and reports the DB as down', async () => {
      const res = await request(app.getHttpServer()).get('/health');
      expect(res.status).toBe(503);
      expect(res.body.status).toBe('error');
      expect(res.body.error).toHaveProperty('database');
      expect(res.body.error.database.status).toBe('down');
    });
  });
});
