import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeTempDir, removeTempDir } from './helpers.js';
import {
  companionPairingResponse,
  ensureCompanionPairingProof,
  initCompanionAuthPath,
  issueCompanionPairingChallenge,
  resetCompanionAuthForTests,
  rotateCompanionPairingProof,
  verifyCompanionPairingResponse,
  writeCompanionAuthResource
} from '../src/main/companion-auth.js';

let dir: string | null = null;
afterEach(async () => {
  resetCompanionAuthForTests();
  if (dir) await removeTempDir(dir);
  dir = null;
});

describe('install-local companion identity', () => {
  it('persists one private proof across an app restart and materializes only the generated companion resource', async () => {
    dir = await makeTempDir('clf-companion-auth-');
    initCompanionAuthPath(dir);
    const proof = ensureCompanionPairingProof();
    expect(proof).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // A desktop restart discards module memory but keeps the install-local identity on disk.
    resetCompanionAuthForTests();
    initCompanionAuthPath(dir);
    expect(ensureCompanionPairingProof()).toBe(proof);

    const extension = path.join(dir, 'extension');
    await fs.mkdir(extension, { recursive: true });
    writeCompanionAuthResource(extension, proof);
    expect(JSON.parse(await fs.readFile(path.join(extension, 'companion-auth.json'), 'utf8'))).toEqual({ version: 1, proof });
  });

  it('accepts a challenge once and rejects wrong proof, replay, and pre-restart transcripts', async () => {
    dir = await makeTempDir('clf-companion-challenge-');
    initCompanionAuthPath(dir);
    const proof = ensureCompanionPairingProof();
    const wrongChallenge = issueCompanionPairingChallenge(1000);
    expect(verifyCompanionPairingResponse(wrongChallenge, companionPairingResponse('A'.repeat(43), wrongChallenge), 1001)).toBe('invalid_proof');
    expect(verifyCompanionPairingResponse(wrongChallenge, companionPairingResponse(proof, wrongChallenge), 1002)).toBe('invalid_challenge');

    const challenge = issueCompanionPairingChallenge(2000);
    const response = companionPairingResponse(proof, challenge);
    expect(verifyCompanionPairingResponse(challenge, response, 2001)).toBe('ok');
    expect(verifyCompanionPairingResponse(challenge, response, 2002)).toBe('invalid_challenge');

    const beforeRestart = issueCompanionPairingChallenge(3000);
    const beforeRestartResponse = companionPairingResponse(proof, beforeRestart);
    resetCompanionAuthForTests();
    initCompanionAuthPath(dir);
    expect(ensureCompanionPairingProof()).toBe(proof);
    expect(verifyCompanionPairingResponse(beforeRestart, beforeRestartResponse, 3001)).toBe('invalid_challenge');
  });

  it('rotates proof on revocation so old proof can no longer answer new challenges', async () => {
    dir = await makeTempDir('clf-companion-rotate-');
    initCompanionAuthPath(dir);
    const extension = path.join(dir, 'extension');
    await fs.mkdir(extension, { recursive: true });
    await fs.writeFile(path.join(extension, 'manifest.json'), '{}');
    const oldProof = ensureCompanionPairingProof();
    writeCompanionAuthResource(extension, oldProof);
    const next = rotateCompanionPairingProof();
    expect(next).not.toBe(oldProof);
    expect(JSON.parse(await fs.readFile(path.join(extension, 'companion-auth.json'), 'utf8'))).toEqual({ version: 1, proof: next });
    const challenge = issueCompanionPairingChallenge();
    expect(verifyCompanionPairingResponse(challenge, companionPairingResponse(oldProof, challenge))).toBe('invalid_proof');
  });
});
