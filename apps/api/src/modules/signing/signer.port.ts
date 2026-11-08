export interface SignResult {
  signatureValue: string;
  algorithm: string;
  keyId: string;
}

export interface Signer {
  sign(bytes: Buffer): Promise<SignResult>;
  verify(bytes: Buffer, signatureValue: string): Promise<boolean>;
}

export const SIGNER = 'SIGNER';
