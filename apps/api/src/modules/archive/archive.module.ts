import { Logger, Module } from '@nestjs/common';
import { ArchiveController } from './archive.controller';
import { ArchiveService } from './archive.service';
import { ARCHIVE_STORAGE } from './storage.port';
import { FilesystemStorage } from './filesystem-storage';
import { S3Storage } from './s3-storage';

/**
 * Backend selection is env-driven:
 *
 *   - `ARCHIVE_STORAGE_BACKEND=s3` or `=filesystem` forces the choice.
 *   - Otherwise `NODE_ENV=production` picks S3; anything else picks
 *     filesystem.
 *
 * Production therefore boots `S3Storage` by default — the Object Lock
 * COMPLIANCE bucket from `infra/modules/archive` is where every signed
 * invoice must land to satisfy OTA Fawtara §5.7 (10-year retention).
 * Dev + CI keep the filesystem analogue.
 */
@Module({
  controllers: [ArchiveController],
  providers: [
    ArchiveService,
    {
      provide: ARCHIVE_STORAGE,
      useFactory: () => {
        const log = new Logger('ArchiveModule');
        const explicit = process.env.ARCHIVE_STORAGE_BACKEND;
        const nodeEnv = process.env.NODE_ENV ?? 'development';
        const choice = explicit ?? (nodeEnv === 'production' ? 's3' : 'filesystem');
        if (choice === 's3') {
          log.log(`Booting S3Storage (NODE_ENV=${nodeEnv}, explicit=${explicit ?? 'none'}).`);
          return new S3Storage();
        }
        log.log(`Booting FilesystemStorage (NODE_ENV=${nodeEnv}).`);
        return new FilesystemStorage();
      },
    },
  ],
  exports: [ArchiveService, ARCHIVE_STORAGE],
})
export class ArchiveModule {}
