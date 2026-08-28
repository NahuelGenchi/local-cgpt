import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflow = readFileSync(path.join(root, '.github', 'workflows', 'linux-test-build.yml'), 'utf8');

describe('Linux M0 candidate issuance gate', () => {
  it('keeps package diagnostics observable without issuing a candidate from failed source verification', () => {
    expect(workflow).toContain('verify-source:');
    expect(workflow).toContain('needs: verify-source');
    expect(workflow).toContain('if: ${{ always() }}');
    expect(workflow).toContain('source_verification=${{ needs.verify-source.result }}');
    expect(workflow).toContain("if: ${{ needs.verify-source.result != 'success' }}");
    expect(workflow).toContain('controlled candidate upload remains disabled');
    expect(workflow).toContain("if: ${{ needs.verify-source.result == 'success' }}");
    expect(workflow).not.toContain('continue-on-error: true');
  });

  it('binds the issued artifact to exact-source provenance and a non-production identity', () => {
    expect(workflow).toContain('SOURCE_SHA: ${{ github.event.pull_request.head.sha || github.sha }}');
    expect(workflow).toContain('ref: ${{ env.SOURCE_SHA }}');
    expect(workflow).toContain('persist-credentials: false');
    expect(workflow).toContain('test "$(git rev-parse HEAD)" = "$SOURCE_SHA"');
    expect(workflow).toContain('candidate_kind=controlled-m0-test');
    expect(workflow).toContain('public_release=false');
    expect(workflow).toContain('source_sha=${SOURCE_SHA}');
    expect(workflow).toContain('name: local-cgpt-m0-linux-x64-${{ env.SOURCE_SHA }}');
    expect(workflow).not.toMatch(/\bgh\s+release\s+create\b|\bnpm\s+publish\b/);
  });
});
