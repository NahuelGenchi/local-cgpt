import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflow = readFileSync(path.join(root, '.github', 'workflows', 'linux-test-build.yml'), 'utf8');
const logger = readFileSync(path.join(root, 'src', 'main', 'logger.ts'), 'utf8');
const ipc = readFileSync(path.join(root, 'src', 'main', 'ipc.ts'), 'utf8');

describe('Linux M0 candidate issuance gate', () => {
  it('keeps package diagnostics observable without issuing from failed source verification', () => {
    expect(workflow).toContain('verify-source:');
    expect(workflow).toContain('needs: verify-source');
    expect(workflow).toContain('if: ${{ always() }}');
    expect(workflow).toContain('source_verification=${{ needs.verify-source.result }}');
    expect(workflow).toContain("if: ${{ needs.verify-source.result != 'success' }}");
    expect(workflow).toContain('controlled candidate upload remains disabled');
    expect(workflow).toContain("if: ${{ success() && needs.verify-source.result == 'success' }}");
    expect(workflow).not.toContain('continue-on-error: true');
  });

  it('binds PR and manual candidates to one exact source SHA', () => {
    expect(workflow).toContain('source_sha:');
    expect(workflow).toContain('Exact reviewed 40-character source SHA to package');
    expect(workflow).toContain("SOURCE_SHA: ${{ github.event_name == 'pull_request' && github.event.pull_request.head.sha || inputs.source_sha }}");
    expect(workflow).toContain("SOURCE_REF: ${{ github.event_name == 'pull_request' && github.event.pull_request.head.ref || github.ref_name }}");
    expect(workflow).toContain('ref: ${{ env.SOURCE_SHA }}');
    expect(workflow).toContain('persist-credentials: false');
    expect(workflow).toContain('[[ "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]]');
    expect(workflow).toContain('test "$(git rev-parse HEAD)" = "$SOURCE_SHA"');
    expect(workflow).toContain('source_sha=${SOURCE_SHA}');
    expect(workflow).toContain('name: local-cgpt-m0-linux-x64-${{ env.SOURCE_SHA }}');
    expect(workflow).not.toContain('source_sha=${GITHUB_SHA}');
  });

  it('issues only the fixed Linux x64 DEB identity', () => {
    expect(workflow).toContain('npm run dist:linux:x64:deb');
    expect(workflow).toContain("test \"$(find release -maxdepth 1 -type f -name '*.deb' -printf '%f\\n' | sort)\" = 'Local-CGPT-Linux-x64.deb'");
    expect(workflow).toContain('dpkg-deb --field "$deb" Package)" = local-cgpt');
    expect(workflow).toContain('dpkg-deb --field "$deb" Architecture)" = amd64');
    expect(workflow).toContain('dpkg-deb --field "$deb" Version)');
    expect(workflow).toContain('appId: com.localcgpt.app');
    expect(workflow).toContain('executable=/usr/bin/local-cgpt');
    expect(workflow).toContain('artifact=Local-CGPT-Linux-x64.deb');
    expect(workflow).not.toContain('.AppImage');
  });

  it('requires renderer and privileged-state readiness instead of timeout survival', () => {
    expect(workflow).toContain('setsid env -i');
    expect(workflow).toContain('CLF_DEBUG=1');
    expect(workflow).toContain('xvfb-run -a /usr/bin/local-cgpt');
    expect(workflow).toContain("grep -Fq '[info] app started'");
    expect(workflow).toContain("grep -Fq '[info] window loaded'");
    expect(workflow).toContain("grep -Fq '[info] renderer state ready'");
    expect(workflow).toContain('never crossed the renderer privileged-state readiness barrier');
    expect(workflow).toContain('sleep 3');
    expect(workflow).toContain('exited immediately after renderer readiness');
    expect(workflow).not.toContain('if [ "$status" -ne 124 ]');
    expect(workflow).not.toContain('--no-sandbox');

    expect(logger).toContain('const ECHO_TO_CONSOLE = process.env[\'CLF_DEBUG\'] === \'1\';');
    expect(logger).toContain('message: redact(message)');
    expect(logger).toContain('process.stderr.write(`[${level}] ${entry.message}\\n`)');

    const handler = ipc.indexOf("handle('state:get', async () => {");
    const state = ipc.indexOf('const state = await buildState();', handler);
    const ready = ipc.indexOf("logInfo('renderer state ready');", state);
    expect(handler).toBeGreaterThan(-1);
    expect(state).toBeGreaterThan(handler);
    expect(ready).toBeGreaterThan(state);
  });

  it('keeps candidate publication read-only, short-lived, and non-release', () => {
    expect(workflow).toContain('permissions:\n  contents: read');
    expect(workflow).toContain('candidate_kind=controlled-m0-test');
    expect(workflow).toContain('public_release=false');
    expect(workflow).toContain('retention-days: 7');
    expect(workflow).not.toMatch(/\bgh\s+release\s+create\b|\bnpm\s+publish\b|\bgit\s+push\b|contents:\s*write/);
  });
});
