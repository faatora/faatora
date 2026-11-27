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
          const keyId = process.env.KMS_SIGNING_KEY_ID;
          if (!keyId) {
            throw new Error(
              'SigningModule: KMS_SIGNING_KEY_ID must be set when NODE_ENV=production',
            );
          }
          log.log(`Booting KmsSigner (NODE_ENV=${nodeEnv}, keyId=${keyId}).`);
          return new KmsSigner(keyId);
        }
        log.log(`Booting LocalSigner (NODE_ENV=${nodeEnv}). DEV ONLY — not for production.`);
        return new LocalSigner();
      },
    },
  ],
  exports: [SigningService, SIGNER],
})
export class SigningModule {}
