import { Module } from '@nestjs/common';
import { ArchiveController } from './archive.controller';
import { ArchiveService } from './archive.service';
import { ARCHIVE_STORAGE } from './storage.port';
import { FilesystemStorage } from './filesystem-storage';

/**
 * Default backend is filesystem (dev + CI). Production wiring flips the
 * `ARCHIVE_STORAGE` provider to `S3Storage` (see `s3-storage.ts`) and the
 * infra side provisions the Object Lock bucket via `infra/modules/archive`.
 *
 *   providers: [
 *     ArchiveService,
 *     { provide: ARCHIVE_STORAGE, useClass: S3Storage },  // prod
 *   ],
 */
@Module({
  controllers: [ArchiveController],
  providers: [ArchiveService, { provide: ARCHIVE_STORAGE, useClass: FilesystemStorage }],
  exports: [ArchiveService, ARCHIVE_STORAGE],
})
export class ArchiveModule {}
