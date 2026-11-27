import { Injectable } from '@nestjs/common';
import { KMSClient, SignCommand, VerifyCommand } from '@aws-sdk/client-kms';
import type { Signer, SignResult } from './signer.port';

/**
 * KmsSigner — production signer backed by AWS KMS asymmetric keys.
 *
 * All signing happens inside KMS so the private key never leaves the HSM —
 * compliance requirement for the §5.7 declared-subcontractor arrangement
 * with ClearTax (the OTA e-invoicing scheme Faatora operates under).
 *
 * The wire format mirrors `LocalSigner`:
 *   - `signatureValue`: base64 of the raw RSA-PKCS1-v1_5 signature bytes
 *   - `algorithm`:      the string `'RSA-SHA256'`
 *   - `keyId`:          the configured KMS key id (ARN or alias)
 *
 * Config (from env, resolved once in the constructor):
 *   - `KMS_SIGNING_KEY_ID` — required. KMS KeyId, which may be a full
 *                            ARN like `arn:aws:kms:me-south-1:…:key/…` or
 *                            an alias like `alias/faatora-signing-prod`.
 *   - `AWS_REGION`         — AWS region for the KMSClient. When unset the
 *                            SDK falls back to its own default chain.
 *
 * The KMS client is instantiated lazily on first use so unit tests can
 * `new KmsSigner('alias/test-key')` cheaply.
 */
@Injectable()
export class KmsSigner implements Signer {
  private static readonly ALGORITHM = 'RSA-SHA256';
  private static readonly SIGNING_ALGORITHM = 'RSASSA_PKCS1_V1_5_SHA_256';

  private readonly keyId: string;
  private readonly region: string | undefined;
  private _client?: KMSClient;

  constructor(keyId?: string) {
    const resolved = keyId ?? process.env.KMS_SIGNING_KEY_ID;
    if (!resolved) {
      throw new Error('KmsSigner: KMS_SIGNING_KEY_ID is required');
    }
    this.keyId = resolved;
    this.region = process.env.AWS_REGION;
  }

  private kmsClient(): KMSClient {
    if (!this._client) {
      this._client = new KMSClient(this.region ? { region: this.region } : {});
    }
    return this._client;
  }

  async sign(bytes: Buffer): Promise<SignResult> {
    const resp = await this.kmsClient().send(
      new SignCommand({
        KeyId: this.keyId,
        Message: bytes,
        MessageType: 'RAW',
        SigningAlgorithm: KmsSigner.SIGNING_ALGORITHM,
      }),
    );
    if (!resp.Signature) {
      throw new Error('KmsSigner: KMS Sign returned no Signature');
    }
    return {
      signatureValue: Buffer.from(resp.Signature).toString('base64'),
      algorithm: KmsSigner.ALGORITHM,
      keyId: this.keyId,
    };
  }

  async verify(bytes: Buffer, signatureValue: string): Promise<boolean> {
    try {
      const resp = await this.kmsClient().send(
        new VerifyCommand({
          KeyId: this.keyId,
          Message: bytes,
          MessageType: 'RAW',
          Signature: Buffer.from(signatureValue, 'base64'),
          SigningAlgorithm: KmsSigner.SIGNING_ALGORITHM,
        }),
      );
      return resp.SignatureValid === true;
    } catch {
      // KMS raises KMSInvalidSignatureException for bad signatures. Mirror
      // LocalSigner: never surface a verify error, just report "not valid".
      return false;
    }
  }
}
