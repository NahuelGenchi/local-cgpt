import { describe, expect, it } from 'vitest';
import {
  isSensitiveEnvironmentName,
  normalizeEnvironment,
  stripSensitiveEnvironment
} from '../src/main/env.js';

describe('child environment credential scrubbing', () => {
  it.each([
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'GITHUB_TOKEN',
    'GH_AUTH_TOKEN',
    'AWS_SECRET_ACCESS_KEY',
    'MY_CLIENT_SECRET',
    'DATABASE_PASSWORD',
    'PRIVATE_KEY',
    'SSH_AUTH_SOCK',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'KUBECONFIG'
  ])('classifies %s as sensitive', (name) => {
    expect(isSensitiveEnvironmentName(name)).toBe(true);
  });

  it.each(['PATH', 'HOME', 'LANG', 'SHELL', 'TERM', 'JAVA_HOME', 'CARGO_HOME', 'RUSTUP_HOME'])(
    'does not classify ordinary development variable %s as sensitive',
    (name) => {
      expect(isSensitiveEnvironmentName(name)).toBe(false);
    }
  );

  it('removes ambient credentials while preserving ordinary environment values', () => {
    const env = normalizeEnvironment({
      PATH: '/usr/bin:/bin',
      HOME: '/home/example',
      GITHUB_TOKEN: 'ghp-do-not-inherit',
      ANTHROPIC_API_KEY: 'sk-ant-do-not-inherit',
      AWS_SECRET_ACCESS_KEY: 'aws-do-not-inherit',
      NORMAL_PROJECT_SETTING: 'safe-value'
    });

    expect(env.PATH).toBe('/usr/bin:/bin');
    expect(env.HOME).toBe('/home/example');
    expect(env.NORMAL_PROJECT_SETTING).toBe('safe-value');
    expect(Object.keys(env).some((key) => key.toUpperCase() === 'GITHUB_TOKEN')).toBe(false);
    expect(Object.keys(env).some((key) => key.toUpperCase() === 'ANTHROPIC_API_KEY')).toBe(false);
    expect(Object.keys(env).some((key) => key.toUpperCase() === 'AWS_SECRET_ACCESS_KEY')).toBe(false);
  });

  it('does not expose names or values while scrubbing', () => {
    const env = {
      SAFE: 'yes',
      CUSTOM_PASSWORD: 'top-secret',
      CUSTOM_API_KEY: 'key-secret'
    };
    const result = stripSensitiveEnvironment(env);
    expect(result).toEqual({ SAFE: 'yes' });
  });
});
