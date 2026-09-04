import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/main/config.js', () => ({
  getConfig: () => ({
    sessions: { record: false },
    multiAgent: { enabled: false }
  })
}));

vi.mock('../src/main/toolchain.js', () => ({
  isGitRepository: () => false
}));

const { serverInstructions } = await import('../src/main/mcp/instructions.js');
const { DEFAULT_CAPABILITIES } = await import('../src/shared/types.js');

function coreContext(agentTools: boolean): any {
  return {
    roots: [],
    caps: { ...DEFAULT_CAPABILITIES },
    readOnly: true,
    sessionTools: false,
    agentTools,
    privacyScreenshots: false
  };
}

describe('multi-agent server instructions', () => {
  it('teaches sleeping-worker reuse instead of treating finish as terminal', () => {
    const instructions = serverInstructions(coreContext(true), 'core', 'linux');

    expect(instructions).toContain('action=finish');
    expect(instructions).toContain('normally puts it to sleep');
    expect(instructions).toContain('send action=message to that sleeping worker');
    expect(instructions).toContain('wake and reuse it');
    expect(instructions).toContain('use action=spawn for genuinely new independent work');
    expect(instructions).toContain('RESULT / CHANGES / VALIDATION / BLOCKERS');
    expect(instructions).not.toContain('A finished worker is finished');
  });

  it('does not advertise worker orchestration when multi-agent tools are absent', () => {
    const instructions = serverInstructions(coreContext(false), 'core', 'linux');

    expect(instructions).not.toContain('Multi-agent mode is on');
    expect(instructions).not.toContain('send action=message to that sleeping worker');
  });
});
