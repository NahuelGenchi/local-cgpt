import { describe, expect, it } from 'vitest';
import {
  isHostCodeLoadingEnvironmentName,
  isSensitiveEnvironmentName,
  normalizeEnvironment,
  stripHostCodeLoadingEnvironment,
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

describe('host child code-loading authority scrubbing', () => {
  it.each([
    'LD_PRELOAD',
    'LD_LIBRARY_PATH',
    'LD_AUDIT',
    'GCONV_PATH',
    'BASH_ENV',
    'PYTHONPATH',
    'NODE_OPTIONS',
    'RUBYOPT',
    'PERL5OPT',
    'GIO_EXTRA_MODULES',
    'GTK_MODULES',
    'GDK_PIXBUF_MODULE_FILE',
    'QT_PLUGIN_PATH',
    'QT_QPA_PLATFORM_PLUGIN_PATH',
    'RIPGREP_CONFIG_PATH',
    'GIT_CONFIG_COUNT',
    'GIT_CONFIG_KEY_0',
    'GIT_CONFIG_VALUE_0'
  ])('classifies %s as ambient host code-loading/startup authority', (name) => {
    expect(isHostCodeLoadingEnvironmentName(name)).toBe(true);
  });

  it.each([
    'PATH',
    'HOME',
    'LANG',
    'LC_ALL',
    'DISPLAY',
    'WAYLAND_DISPLAY',
    'XAUTHORITY',
    'DBUS_SESSION_BUS_ADDRESS',
    'XDG_RUNTIME_DIR',
    'HTTPS_PROXY'
  ])('preserves required ordinary runtime variable %s', (name) => {
    expect(isHostCodeLoadingEnvironmentName(name)).toBe(false);
  });

  it('normalization removes inherited loader/plugin/startup authority but keeps GUI/runtime state', () => {
    const env = normalizeEnvironment({
      PATH: '/approved/bin:/usr/bin',
      HOME: '/home/example',
      DISPLAY: ':99',
      WAYLAND_DISPLAY: 'wayland-0',
      XAUTHORITY: '/run/user/1000/xauth',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
      XDG_RUNTIME_DIR: '/run/user/1000',
      HTTPS_PROXY: 'http://proxy.example:8080',
      LD_PRELOAD: '/approved/payload.so',
      LD_LIBRARY_PATH: '/approved/lib',
      GIO_EXTRA_MODULES: '/approved/gio',
      QT_PLUGIN_PATH: '/approved/qt',
      BASH_ENV: '/approved/bashrc',
      NODE_OPTIONS: '--require=/approved/hook.cjs',
      RIPGREP_CONFIG_PATH: '/approved/rg.conf'
    });

    expect(env.PATH).toBe('/approved/bin:/usr/bin');
    expect(env.DISPLAY).toBe(':99');
    expect(env.WAYLAND_DISPLAY).toBe('wayland-0');
    expect(env.XAUTHORITY).toBe('/run/user/1000/xauth');
    expect(env.DBUS_SESSION_BUS_ADDRESS).toBe('unix:path=/run/user/1000/bus');
    expect(env.XDG_RUNTIME_DIR).toBe('/run/user/1000');
    expect(env.HTTPS_PROXY).toBe('http://proxy.example:8080');
    for (const name of [
      'LD_PRELOAD',
      'LD_LIBRARY_PATH',
      'GIO_EXTRA_MODULES',
      'QT_PLUGIN_PATH',
      'BASH_ENV',
      'NODE_OPTIONS',
      'RIPGREP_CONFIG_PATH'
    ]) {
      expect(Object.prototype.hasOwnProperty.call(env, name)).toBe(false);
    }
  });

  it('scrubs host-code authority without exposing or altering ordinary entries', () => {
    expect(
      stripHostCodeLoadingEnvironment({
        SAFE: 'yes',
        LD_PRELOAD: '/approved/payload.so',
        GIT_CONFIG_KEY_7: 'core.sshCommand'
      })
    ).toEqual({ SAFE: 'yes' });
  });
});
