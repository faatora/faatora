import { Logger, Module } from '@nestjs/common';
import { SigningController } from './signing.controller';
import { SigningService } from './signing.service';
import { SIGNER, type Signer } from './signer.port';
import { LocalSigner } from './local-signer';
import { KmsSigner } from './kms-signer';

/**
 * SigningModule — SEC-002 fix.
 *
 * The SIGNER provider is chosen by NODE_ENV. In production we bind the
 * `KmsSigner` whose methods currently THROW on every sign — this is
 * intentional: it is the hard refusal to run invoice signing with a
 * software key in prod, and forces an explicit KMS wiring before go-live.
 * In every other environment we fall back to `LocalSigner`, which is only
 * safe for dev/CI.
 */
@Module({
  controllers: [SigningController],
  providers: [
    SigningService,
    {
      provide: SIGNER,
      useFactory: (): Signer => {
        const log = new Logger('SigningModule');
        const nodeEnv = process.env.NODE_ENV ?? 'development';
        if (nodeEnv === 'production') {
          log.log(
            `Booting KmsSigner (NODE_ENV=${nodeEnv}). Software signing is refused in production.`,
          );
          return new KmsSigner();
        }
        log.log(`Booting LocalSigner (NODE_ENV=${nodeEnv}). DEV ONLY — not for production.`);
        return new LocalSigner();
      },
    },
  ],
  exports: [SigningService, SIGNER],
})
export class SigningModule {}
