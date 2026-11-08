import { Injectable } from '@nestjs/common';
import * as forge from 'node-forge';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Signer, SignResult } from './signer.port';

/**
 * LocalSigner — software-based RSA-SHA256 signer for dev/CI use.
 *
 * On first use it generates a 2048-bit RSA keypair in memory. If the file at
 * `/tmp/fawtara-dev-signing.pem` exists on process start we load that keypair
 * instead, which gives stable keys across process restarts in a dev container.
 * On generation we persist the new keypair to that path so subsequent restarts
 * reuse it.
 *
 * NOT FOR PRODUCTION. Production swaps the SIGNER provider to KmsSigner so
 * keys never leave AWS KMS.
 */
@Injectable()
export class LocalSigner implements Signer {
  private static readonly ALGORITHM = 'RSA-SHA256';
  private static readonly KEY_ID = 'local-dev-key';
  private static readonly KEY_PATH = path.join('/tmp', 'fawtara-dev-signing.pem');

  private privateKey?: forge.pki.rsa.PrivateKey;
  private publicKey?: forge.pki.rsa.PublicKey;

  private ensureKeys(): { priv: forge.pki.rsa.PrivateKey; pub: forge.pki.rsa.PublicKey } {
    if (this.privateKey && this.publicKey) {
      return { priv: this.privateKey, pub: this.publicKey };
    }
    try {
      if (fs.existsSync(LocalSigner.KEY_PATH)) {
        const pem = fs.readFileSync(LocalSigner.KEY_PATH, 'utf8');
        const priv = forge.pki.privateKeyFromPem(pem);
        const pub = forge.pki.setRsaPublicKey(priv.n, priv.e);
        this.privateKey = priv;
        this.publicKey = pub;
        return { priv, pub };
      }
    } catch {
      // Fall through to generation.
    }
    const keypair = forge.pki.rsa.generateKeyPair({ bits: 2048, e: 0x10001 });
    try {
      fs.writeFileSync(LocalSigner.KEY_PATH, forge.pki.privateKeyToPem(keypair.privateKey), {
        mode: 0o600,
      });
    } catch {
      // Writing is best-effort; signing still works in-memory.
    }
    this.privateKey = keypair.privateKey;
    this.publicKey = keypair.publicKey;
    return { priv: keypair.privateKey, pub: keypair.publicKey };
  }

  async sign(bytes: Buffer): Promise<SignResult> {
    const { priv } = this.ensureKeys();
    const md = forge.md.sha256.create();
    md.update(bytes.toString('binary'));
    const sig = priv.sign(md);
    return {
      signatureValue: Buffer.from(sig, 'binary').toString('base64'),
      algorithm: LocalSigner.ALGORITHM,
      keyId: LocalSigner.KEY_ID,
    };
  }

  async verify(bytes: Buffer, signatureValue: string): Promise<boolean> {
    const { pub } = this.ensureKeys();
    const md = forge.md.sha256.create();
    md.update(bytes.toString('binary'));
    const sigBinary = Buffer.from(signatureValue, 'base64').toString('binary');
    try {
      return pub.verify(md.digest().bytes(), sigBinary);
    } catch {
      return false;
    }
  }

  getPublicKeyPem(): string {
    const { pub } = this.ensureKeys();
    return forge.pki.publicKeyToPem(pub);
  }
}
