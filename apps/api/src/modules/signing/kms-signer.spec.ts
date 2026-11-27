import { KMSClient, SignCommand, VerifyCommand } from '@aws-sdk/client-kms';
import { mockClient } from 'aws-sdk-client-mock';
import { KmsSigner } from './kms-signer';

/**
 * Unit tests for KmsSigner.
 *
 * Uses `aws-sdk-client-mock` to intercept the KMSClient `send()` without
 * any live AWS call. The signer must produce the exact same wire format
 * as LocalSigner (base64 signatureValue, algorithm='RSA-SHA256', keyId),
 * and must swallow verify-time KMS exceptions by returning false — this
 * mirrors LocalSigner's behaviour so callers can treat any Signer the
 * same way.
 */
describe('KmsSigner', () => {
  const KEY_ID = 'alias/faatora-signing-test';
  const kmsMock = mockClient(KMSClient);

  // `aws-sdk-client-mock` installs a per-test interceptor on the
  // KMSClient *class*, which means the mock sees sends from any
  // client instance (including ones built lazily by our constructor).
  beforeEach(() => {
    kmsMock.reset();
    delete process.env.KMS_SIGNING_KEY_ID;
  });

  describe('sign', () => {
    it('calls SignCommand with the right params and returns base64 + algorithm + keyId', async () => {
      const rawSig = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05]);
      kmsMock.on(SignCommand).resolves({ Signature: rawSig });

      const signer = new KmsSigner(KEY_ID);
      const payload = Buffer.from('<?xml version="1.0"?><Invoice/>', 'utf8');
      const result = await signer.sign(payload);

      expect(result).toEqual({
        signatureValue: rawSig.toString('base64'),
        algorithm: 'RSA-SHA256',
        keyId: KEY_ID,
      });

      const calls = kmsMock.commandCalls(SignCommand);
      expect(calls).toHaveLength(1);
      const sent = calls[0].args[0].input;
      expect(sent.KeyId).toBe(KEY_ID);
      expect(sent.MessageType).toBe('RAW');
      expect(sent.SigningAlgorithm).toBe('RSASSA_PKCS1_V1_5_SHA_256');
      // The SDK accepts a Buffer as Message; it is passed through unchanged.
      expect(Buffer.from(sent.Message as Uint8Array).equals(payload)).toBe(true);
    });
  });

  describe('verify', () => {
    it('returns true when KMS reports SignatureValid=true', async () => {
      kmsMock.on(VerifyCommand).resolves({ SignatureValid: true });
      const signer = new KmsSigner(KEY_ID);

      const ok = await signer.verify(
        Buffer.from('payload', 'utf8'),
        Buffer.from('sig').toString('base64'),
      );
      expect(ok).toBe(true);

      const calls = kmsMock.commandCalls(VerifyCommand);
      expect(calls).toHaveLength(1);
      const sent = calls[0].args[0].input;
      expect(sent.KeyId).toBe(KEY_ID);
      expect(sent.MessageType).toBe('RAW');
      expect(sent.SigningAlgorithm).toBe('RSASSA_PKCS1_V1_5_SHA_256');
      expect(Buffer.from(sent.Signature as Uint8Array).toString('utf8')).toBe('sig');
    });

    it('returns false when KMS reports SignatureValid=false', async () => {
      kmsMock.on(VerifyCommand).resolves({ SignatureValid: false });
      const signer = new KmsSigner(KEY_ID);

      const ok = await signer.verify(
        Buffer.from('payload', 'utf8'),
        Buffer.from('sig').toString('base64'),
      );
      expect(ok).toBe(false);
    });

    it('returns false when KMS throws (e.g. KMSInvalidSignatureException)', async () => {
      // Shape of a real KMSInvalidSignatureException — name is what callers
      // typically match on. We throw it from the mock to confirm the
      // adapter swallows it instead of leaking it to the caller.
      const err = new Error('The signature is invalid.');
      err.name = 'KMSInvalidSignatureException';
      kmsMock.on(VerifyCommand).rejects(err);

      const signer = new KmsSigner(KEY_ID);
      const ok = await signer.verify(
        Buffer.from('payload', 'utf8'),
        Buffer.from('sig').toString('base64'),
      );
      expect(ok).toBe(false);
    });
  });

  describe('constructor', () => {
    it('throws when no keyId is provided and KMS_SIGNING_KEY_ID is unset', () => {
      delete process.env.KMS_SIGNING_KEY_ID;
      expect(() => new KmsSigner()).toThrow('KmsSigner: KMS_SIGNING_KEY_ID is required');
    });

    it('falls back to KMS_SIGNING_KEY_ID when no constructor arg is given', async () => {
      process.env.KMS_SIGNING_KEY_ID = 'alias/from-env';
      kmsMock.on(SignCommand).resolves({ Signature: Buffer.from([0xaa]) });

      const signer = new KmsSigner();
      const result = await signer.sign(Buffer.from('x', 'utf8'));
      expect(result.keyId).toBe('alias/from-env');

      const sent = kmsMock.commandCalls(SignCommand)[0].args[0].input;
      expect(sent.KeyId).toBe('alias/from-env');
    });
  });
});
