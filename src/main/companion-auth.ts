/**
 * Install-local identity for the reviewed Chrome companion.
 *
 * This is deliberately separate from the bridge bearer token. The bearer authorizes ordinary
 * bridge requests after pairing; this proof is used only to prove that a pairing request came
 * from the app-materialized companion. It is generated per installation, never shipped in
 * source, and copied only into the app-controlled Chrome extension directory.
 *
 * Security assumptions:
 * - same-user native filesystem compromise is outside this browser-identity boundary;
 * - ChatGPT page JavaScript and separately installed extensions cannot read arbitrary files in
 *   Electron userData or non-web-accessible resources belonging to this extension;
 * - the service worker is trusted extension code, while content scripts/MAIN-world page helpers
 *   are not given this proof;
 * - HTTP Origin remains defense in depth only and is never used as companion identity.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const PROOF_BYTES = 32;
const PROOF_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const RESPONSE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CHALLENGE_TTL_MS = 30_000;
const MAX_CHALLENGES = 64;
const PAIRING_DOMAIN = 'local-cgpt-companion-v1';
export const COMPANION_AUTH_RESOURCE = 'companion-auth.json';

let proofPath: string | null = null;
let stableExtensionDir: string | null = null;
const challenges = new Map<string, { expiresAt: number }>();

function requireProofPath(): string {
  if (!proofPath) throw new Error('Companion authentication path is not initialized');
  return proofPath;
}

function assertRegularFile(target: string): void {
  if (!existsSync(target)) return;
  const stat = lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Refusing non-regular companion authentication file: ${target}`);
  }
}

function atomicPrivateWrite(target: string, content: string): void {
  mkdirSync(path.dirname(target), { recursive: true });
  assertRegularFile(target);
  const temporary = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  try {
    renameSync(temporary, target);
    chmodSync(target, 0o600);
  } catch (error) {
    try {
      if (existsSync(temporary)) {
        // The temporary contains credential material, so leave no stale copy on ordinary errors.
        // A process crash is handled by the random temporary name and never treated as authority.
        rmSync(temporary, { force: true });
      }
    } catch {
      // Preserve the original failure; cleanup is best effort only.
    }
    throw error;
  }
}

function newProof(): string {
  return randomBytes(PROOF_BYTES).toString('base64url');
}

function readValidProof(): string | null {
  const target = requireProofPath();
  try {
    assertRegularFile(target);
    const proof = readFileSync(target, 'utf8').trim();
    return PROOF_PATTERN.test(proof) ? proof : null;
  } catch {
    return null;
  }
}

export function initCompanionAuthPath(userData: string): void {
  proofPath = path.join(userData, 'companion-pairing-proof');
  stableExtensionDir = path.join(userData, 'extension');
}

export function ensureCompanionPairingProof(): string {
  const existing = readValidProof();
  if (existing) {
    chmodSync(requireProofPath(), 0o600);
    return existing;
  }
  const proof = newProof();
  atomicPrivateWrite(requireProofPath(), `${proof}\n`);
  return proof;
}

export function writeCompanionAuthResource(extensionDir: string, proof = ensureCompanionPairingProof()): void {
  if (!PROOF_PATTERN.test(proof)) throw new Error('Refusing invalid companion pairing proof');
  atomicPrivateWrite(
    path.join(extensionDir, COMPANION_AUTH_RESOURCE),
    `${JSON.stringify({ version: 1, proof })}\n`
  );
}

/**
 * Rotate install identity after explicit unpair/revocation.
 *
 * The master proof is published first. If updating the Chrome-visible copy then fails, pairing
 * fails closed until materialization repairs it; an old companion proof never regains authority.
 */
export function rotateCompanionPairingProof(): string {
  const proof = newProof();
  atomicPrivateWrite(requireProofPath(), `${proof}\n`);
  clearCompanionPairingChallenges();
  if (stableExtensionDir && existsSync(path.join(stableExtensionDir, 'manifest.json'))) {
    writeCompanionAuthResource(stableExtensionDir, proof);
  }
  return proof;
}

function pruneChallenges(now: number): void {
  for (const [challenge, record] of challenges) {
    if (record.expiresAt <= now) challenges.delete(challenge);
  }
  while (challenges.size >= MAX_CHALLENGES) {
    const oldest = challenges.keys().next().value as string | undefined;
    if (!oldest) break;
    challenges.delete(oldest);
  }
}

export function issueCompanionPairingChallenge(now = Date.now()): string {
  pruneChallenges(now);
  const challenge = randomBytes(PROOF_BYTES).toString('base64url');
  challenges.set(challenge, { expiresAt: now + CHALLENGE_TTL_MS });
  return challenge;
}

export function companionPairingResponse(proof: string, challenge: string): string {
  return createHmac('sha256', Buffer.from(proof, 'utf8'))
    .update(`${PAIRING_DOMAIN}\npair\n${challenge}`, 'utf8')
    .digest('base64url');
}

export type CompanionProofResult = 'ok' | 'invalid_challenge' | 'invalid_proof';

/**
 * Verify and consume one challenge. Consumption happens before proof comparison so a wrong guess
 * can never be retried against the same server nonce. App restart/bridge reset clears the map,
 * which also makes every pre-restart transcript unredeemable.
 */
export function verifyCompanionPairingResponse(
  challenge: unknown,
  response: unknown,
  now = Date.now()
): CompanionProofResult {
  pruneChallenges(now);
  if (typeof challenge !== 'string' || !CHALLENGE_PATTERN.test(challenge)) return 'invalid_challenge';
  const issued = challenges.get(challenge);
  if (!issued || issued.expiresAt <= now) {
    challenges.delete(challenge);
    return 'invalid_challenge';
  }
  challenges.delete(challenge);
  if (typeof response !== 'string' || !RESPONSE_PATTERN.test(response)) return 'invalid_proof';

  const expected = companionPairingResponse(ensureCompanionPairingProof(), challenge);
  const actualBuffer = Buffer.from(response, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  if (actualBuffer.length !== expectedBuffer.length) return 'invalid_proof';
  return timingSafeEqual(actualBuffer, expectedBuffer) ? 'ok' : 'invalid_proof';
}

export function clearCompanionPairingChallenges(): void {
  challenges.clear();
}

/** Test-only reset for module state. Production initializes once from Electron userData. */
export function resetCompanionAuthForTests(): void {
  proofPath = null;
  stableExtensionDir = null;
  challenges.clear();
}
