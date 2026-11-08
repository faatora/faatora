import { Injectable } from '@nestjs/common';
import type { Signer, SignResult } from './signer.port';

/**
 * KmsSigner — production signer backed by AWS KMS asymmetric keys.
 *
 * STUB: not yet wired. In production the SIGNER provider is rebound in
 * `signing.module.ts` (useClass: KmsSigner) and this class uses the AWS KMS
 * SDK to call `Sign`/`Verify` against a configured KeyId with
 * `SigningAlgorithm: RSASSA_PKCS1_V1_5_SHA_256` so the signature wire format
 * matches LocalSigner.
 */
@Injectable()
export class KmsSigner implements Signer {
  async sign(_bytes: Buffer): Promise<SignResult> {
    throw new Error('Not yet implemented — KMS wiring in production');
  }

  async verify(_bytes: Buffer, _signatureValue: string): Promise<boolean> {
    throw new Error('Not yet implemented — KMS wiring in production');
  }
}
