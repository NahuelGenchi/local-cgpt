import { beforeAll, beforeEach } from 'vitest';
import { defaultConfig, setConfigForTests } from '../src/main/config.js';
import { setCommandSandboxBypassForTests } from '../src/main/command-sandbox.js';
import { capabilitiesForPlatform } from '../src/main/platform.js';
import { CAPABILITIES, type Capabilities } from '../src/shared/types.js';

/** Behavioral suites model a user who explicitly opted in; production defaults stay fail-closed. */
function optedInTestConfig() {
  const base = defaultConfig();
  const granted = Object.fromEntries(CAPABILITIES.map((capability) => [capability, true])) as Capabilities;
  return {
    ...base,
    capabilities: capabilitiesForPlatform(granted),
    readOnly: false,
    sessions: { ...base.sessions, record: true },
    compaction: { ...base.compaction, auto: true },
    multiAgent: { ...base.multiAgent, enabled: true, maxWorkers: 3 }
  };
}

function installOptedInConfig() {
  setConfigForTests(optedInTestConfig());
  setCommandSandboxBypassForTests(true);
}

beforeAll(installOptedInConfig);
beforeEach(installOptedInConfig);