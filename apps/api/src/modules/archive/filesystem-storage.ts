import { Injectable } from '@nestjs/common';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type {
  ArchiveStorage,
  ArchiveStoragePutInput,
  ArchiveStoragePutResult,
} from './storage.port';

/**
 * Filesystem archive backend — for dev and CI.
 *
 * NOTE: production uses S3 Object Lock in COMPLIANCE mode plus per-tenant
 * data keys (see `s3-storage.ts` and `infra/modules/archive`). This backend
 * is a local analogue: files are written with mode 0o400 (read-only, no
 * owner write) and the `put` call uses the `wx` flag so a second write to
 * the same path fails with EEXIST — the immutability property archive
 * verification depends on.
 *
 * Layout: `${baseDir}/${tenantId}/${YYYY}/${MM}/${documentUuid}.xml`.
 * `baseDir` is `FAWTARA_ARCHIVE_DIR` or `/tmp/fawtara-archive` by default.
 */
@Injectable()
export class FilesystemStorage implements ArchiveStorage {
  private readonly baseDir: string;

  constructor() {
    this.baseDir = process.env.FAWTARA_ARCHIVE_DIR ?? '/tmp/fawtara-archive';
  }

  getBaseDir(): string {
    return this.baseDir;
  }

  buildKey(tenantId: string, documentUuid: string, now: Date = new Date()): string {
    const year = now.getUTCFullYear().toString().padStart(4, '0');
    const month = (now.getUTCMonth() + 1).toString().padStart(2, '0');
    return path.posix.join(tenantId, year, month, `${documentUuid}.xml`);
  }

  async put(input: ArchiveStoragePutInput): Promise<ArchiveStoragePutResult> {
    const key = this.buildKey(input.tenantId, input.documentUuid);
    const absolute = path.join(this.baseDir, key);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    // `wx` flag: create and open for write; fails with EEXIST if path exists.
    // This gives us immutability-on-create at the filesystem layer.
    const handle = await fs.open(absolute, 'wx', 0o400);
    try {
      await handle.writeFile(input.content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    // Belt-and-braces: enforce read-only mode in case the umask stripped
    // bits off the open-time mode.
    await fs.chmod(absolute, 0o400);
    return {
      storageBackend: 'filesystem',
      storageKey: key,
    };
  }

  async get(key: string): Promise<Buffer> {
    const absolute = path.join(this.baseDir, key);
    return fs.readFile(absolute);
  }
}
