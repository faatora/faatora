import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { loadEnv } from '../config/env';
let verifier: ReturnType<typeof CognitoJwtVerifier.create> | null = null;
export function getCognitoVerifier() {
  if (verifier) return verifier;
  const env = loadEnv();
  if (!env.COGNITO_USER_POOL_ID || !env.COGNITO_CLIENT_ID) {
    throw new Error('Cognito not configured');
  }
  verifier = CognitoJwtVerifier.create({
    userPoolId: env.COGNITO_USER_POOL_ID,
    tokenUse: 'access',
    clientId: env.COGNITO_CLIENT_ID,
  });
  return verifier;
}
