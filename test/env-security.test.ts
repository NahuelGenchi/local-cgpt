import { describe, expect, it } from 'vitest';
import {
  isHostCodeLoadingEnvironmentName,
  isSensitiveEnvironmentName,
  normalizeEnvironment,
  stripHostCodeLoadingEnvironment,
  stripSensitiveEnvironment
} from '../src/main/env.js';
import {
  browserHostEnvironment,
  ripgrepHostEnvironment,
  tunnelHostEnvironment
} from '../src/main/host-env.js';

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

describe('host child code-loading authority classification', () => {
  it.each([
    'LD_PRELOAD',
    'LD_LIBRARY_PATH',
    'LD_AUDIT',
    'GCONV_PATH',
    'BASH_ENV',
    'ENV',
    'PYTHONPATH',
    'NODE_OPTIONS',
    'RUBYOPT',
    'PERL5OPT',
    'GIO_EXTRA_MODULES',
    'GIO_MODULE_DIR',
    'GI_TYPELIB_PATH',
    'GTK_MODULES',
    'GTK_PATH',
    'GDK_PIXBUF_MODULE_FILE',
    'QT_PLUGIN_PATH',
    'QT_QPA_PLATFORM_PLUGIN_PATH',
    'QT_QPA_PLATFORMTHEME',
    'QT_STYLE_OVERRIDE',
    'RIPGREP_CONFIG_PATH',
    'GIT_CONFIG_GLOBAL',
    'GIT_CONFIG_SYSTEM',
    'GIT_CONFIG_COUNT',
    'GIT_CONFIG_KEY_0',
    'GIT_CONFIG_VALUE_0',
    'XDG_DATA_DIRS',
    'VK_LAYER_PATH',
    'GST_PLUGIN_PATH_1_0'
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
  ])('does not over-classify ordinary runtime variable %s', (name) => {
    expect(isHostCodeLoadingEnvironmentName(name)).toBe(false);
  });

  it('keeps generic command normalization separate from the host-helper code-loading policy', () => {
    const env = normalizeEnvironment({
      LANG: 'en_US.UTF-8',
      LD_PRELOAD: '/approved/model-command.so',
      NODE_OPTIONS: '--require=/approved/model-command.cjs',
      GITHUB_TOKEN: 'ambient-secret'
    });

    // The Bubblewrap launcher owns the sandbox-child contract. This issue must not silently
    // redefine generic command preparation merely because host helpers need a stricter boundary.
    expect(env.LD_PRELOAD).toBe('/approved/model-command.so');
    expect(env.NODE_OPTIONS).toBe('--require=/approved/model-command.cjs');
    expect(env.GITHUB_TOKEN).toBeUndefined();
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

const HOSTILE = {
  PATH: '/approved/bin:/usr/bin',
  HOME: '/approved/fake-home',
  LD_PRELOAD: '/approved/payload.so',
  LD_LIBRARY_PATH: '/approved/lib',
  BASH_ENV: '/approved/bashrc',
  NODE_OPTIONS: '--require=/approved/hook.cjs',
  RIPGREP_CONFIG_PATH: '/approved/rg.conf',
  GIO_MODULE_DIR: '/approved/gio',
  GIO_EXTRA_MODULES: '/approved/gio-extra',
  GI_TYPELIB_PATH: '/approved/typelib',
  GTK_PATH: '/approved/gtk',
  GTK_MODULES: 'attacker-module',
  QT_PLUGIN_PATH: '/approved/qt',
  QT_QPA_PLATFORM_PLUGIN_PATH: '/approved/qpa',
  QT_QPA_PLATFORMTHEME: 'attacker-theme',
  QT_STYLE_OVERRIDE: 'attacker-style',
  GITHUB_TOKEN: 'ghp-ambient',
  SSH_AUTH_SOCK: '/approved/ssh-agent.sock',
  AWS_SECRET_ACCESS_KEY: 'aws-ambient'
} satisfies NodeJS.ProcessEnv;

describe('browser host environment', () => {
  it('keeps required Linux GUI/session state and drops executable/config authority', () => {
    const env = browserHostEnvironment(
      {
        ...HOSTILE,
        DISPLAY: ':99',
        WAYLAND_DISPLAY: 'wayland-0',
        XAUTHORITY: '/run/user/1000/xauth',
        DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
        XDG_RUNTIME_DIR: '/run/user/1000',
        XDG_SESSION_TYPE: 'wayland',
        XDG_CURRENT_DESKTOP: 'GNOME',
        DESKTOP_SESSION: 'gnome',
        PULSE_SERVER: 'unix:/run/user/1000/pulse/native',
        PIPEWIRE_REMOTE: 'pipewire-0',
        LANG: 'en_US.UTF-8',
        LC_ALL: 'en_US.UTF-8',
        TZ: 'UTC',
        XDG_CONFIG_HOME: '/approved/browser-config',
        XDG_DATA_DIRS: '/approved/share'
      },
      '/home/example'
    );

    expect(env).toMatchObject({
      HOME: '/home/example',
      DISPLAY: ':99',
      WAYLAND_DISPLAY: 'wayland-0',
      XAUTHORITY: '/run/user/1000/xauth',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
      XDG_RUNTIME_DIR: '/run/user/1000',
      XDG_SESSION_TYPE: 'wayland',
      XDG_CURRENT_DESKTOP: 'GNOME',
      DESKTOP_SESSION: 'gnome',
      PULSE_SERVER: 'unix:/run/user/1000/pulse/native',
      PIPEWIRE_REMOTE: 'pipewire-0',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'en_US.UTF-8',
      TZ: 'UTC'
    });
    expect(env.PATH).toBeUndefined();
    expect(env.XDG_CONFIG_HOME).toBeUndefined();
    expect(env.XDG_DATA_DIRS).toBeUndefined();
    for (const name of Object.keys(HOSTILE).filter((name) => !['PATH', 'HOME'].includes(name))) {
      expect(env[name], name).toBeUndefined();
    }
  });

  it('fails closed when the account home cannot be represented as an absolute path', () => {
    expect(() => browserHostEnvironment({}, 'relative/home')).toThrow(/absolute account home/);
  });
});

describe('host ripgrep environment', () => {
  it('is purpose-built for locale only and cannot inherit ripgrep config, PATH or credentials', () => {
    const env = ripgrepHostEnvironment({
      ...HOSTILE,
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      LC_CTYPE: 'C.UTF-8',
      TZ: 'UTC',
      HTTPS_PROXY: 'http://proxy.example:8080'
    });

    expect(env).toEqual({ LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', LC_CTYPE: 'C.UTF-8', TZ: 'UTC' });
  });
});

describe('tunnel host environment', () => {
  it('keeps only networking/runtime state, then adds reviewed app-owned tunnel fields', () => {
    const env = tunnelHostEnvironment(
      {
        ...HOSTILE,
        HTTPS_PROXY: 'http://proxy.example:8080',
        NO_PROXY: '127.0.0.1,localhost',
        LANG: 'C.UTF-8',
        LC_CTYPE: 'C.UTF-8',
        TZ: 'UTC',
        SSL_CERT_FILE: '/approved/attacker-ca.pem',
        SSL_CERT_DIR: '/approved/attacker-certs'
      },
      {
        CONTROL_PLANE_API_KEY: 'trusted-key',
        MCP_SERVER_URL: 'url=http://127.0.0.1:43123/secret,channel=main',
        MCP_DISCOVERY_EXTRA_HEADERS: 'x-local-cgpt: trusted'
      }
    );

    expect(env).toEqual({
      HTTPS_PROXY: 'http://proxy.example:8080',
      NO_PROXY: '127.0.0.1,localhost',
      LANG: 'C.UTF-8',
      LC_CTYPE: 'C.UTF-8',
      TZ: 'UTC',
      CONTROL_PLANE_API_KEY: 'trusted-key',
      MCP_SERVER_URL: 'url=http://127.0.0.1:43123/secret,channel=main',
      MCP_DISCOVERY_EXTRA_HEADERS: 'x-local-cgpt: trusted'
    });
    expect(env.PATH).toBeUndefined();
    expect(env.HOME).toBeUndefined();
    expect(env.SSL_CERT_FILE).toBeUndefined();
    expect(env.SSL_CERT_DIR).toBeUndefined();
  });

  it('refuses an unreviewed explicit environment field instead of broadening authority', () => {
    expect(() => tunnelHostEnvironment({}, { LD_PRELOAD: '/approved/payload.so' })).toThrow(/Unreviewed tunnel/);
    expect(() => tunnelHostEnvironment({}, { GITHUB_TOKEN: 'secret' })).toThrow(/Unreviewed tunnel/);
  });
});
