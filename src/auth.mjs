import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

// Standard primitives only: high-entropy opaque tokens (CSPRNG) with SHA-256
// verifiers stored server-side. No ad hoc cryptography, no password schemes.
// Raw secrets are shown once at creation and never logged or re-readable.
export function newSecret(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

export function hashSecret(secret) {
  return createHash('sha256').update(String(secret), 'utf8').digest();
}

export function verifySecret(secret, storedHash) {
  if (typeof secret !== 'string' || !secret) return false;
  const candidate = hashSecret(secret);
  const stored = Buffer.isBuffer(storedHash)
    ? storedHash
    : Buffer.from(storedHash);
  if (candidate.length !== stored.length) return false;
  return timingSafeEqual(candidate, stored);
}

// Bearer format for short-lived session tokens: "ht1_<base64url>".
// Device credentials presented to POST /v1/sessions are JSON fields, not
// bearer tokens, so the two credential kinds are never confused.
export function newSessionToken() {
  return `ht1_${newSecret(32)}`;
}

export function isSessionTokenFormat(token) {
  return typeof token === 'string' && /^ht1_[A-Za-z0-9_-]{40,60}$/.test(token);
}
