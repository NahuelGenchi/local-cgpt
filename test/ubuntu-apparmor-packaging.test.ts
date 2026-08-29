import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const builder = readFileSync(path.join(root, 'electron-builder.yml'), 'utf8');
const postInstallPath = path.join(root, 'build', 'deb-after-install.sh');
const postInstall = readFileSync(postInstallPath, 'utf8');
const verifier = readFileSync(path.join(root, 'scripts', 'verify-linux-sandbox.mjs'), 'utf8');

describe('Ubuntu 24.04 Bubblewrap AppArmor packaging contract', () => {
  it('ships the distro policy source as a DEB dependency and wires the guarded post-install hook', () => {
    expect(builder).toContain('afterInstall: build/deb-after-install.sh');
    expect(builder).toContain('- bubblewrap');
    expect(builder).toContain('- apparmor-profiles');
  });

  it('keeps the post-install hook fail-closed and never disables the global AppArmor restriction', () => {
    const syntax = spawnSync('/bin/sh', ['-n', postInstallPath], { encoding: 'utf8' });
    expect(syntax.status, syntax.stderr).toBe(0);

    expect(postInstall).toContain('PATH=/usr/sbin:/usr/bin:/sbin:/bin');
    expect(postInstall).toContain('/proc/sys/kernel/apparmor_restrict_unprivileged_userns');
    expect(postInstall).toContain('/sys/module/apparmor/parameters/enabled');
    expect(postInstall).toContain('/sys/kernel/security/apparmor/profiles');
    expect(postInstall).toContain('/usr/share/apparmor/extra-profiles/bwrap-userns-restrict');
    expect(postInstall).toContain('/etc/apparmor.d/bwrap-userns-restrict');
    expect(postInstall).toContain("grep -q '^bwrap '");
    expect(postInstall).toContain('another AppArmor profile already targets /usr/bin/bwrap');
    expect(postInstall).toContain('dpkg-query -S "$DISTRO_PROFILE"');
    expect(postInstall).toContain('apparmor_parser -r "$PROFILE"');
    expect(postInstall).toContain('do not disable AppArmor or the global unprivileged-userns restriction');

    expect(postInstall).not.toMatch(/sysctl\s+-w|apparmor_restrict_unprivileged_userns\s*=\s*0|systemctl\s+(stop|disable)\s+apparmor/i);
  });

  it('requires the canonical policy and refuses competing or unknown loaded bwrap policy', () => {
    const canonical = postInstall.indexOf('canonical_present=0');
    const conflict = postInstall.indexOf('another AppArmor profile already targets /usr/bin/bwrap');
    const loaded = postInstall.indexOf("grep -q '^bwrap '");
    const unknownLoaded = postInstall.indexOf('refusing to trust unknown loaded policy');
    const link = postInstall.indexOf('ln -s "$DISTRO_PROFILE" "$PROFILE"');

    expect(canonical).toBeGreaterThan(-1);
    expect(conflict).toBeGreaterThan(canonical);
    expect(loaded).toBeGreaterThan(conflict);
    expect(unknownLoaded).toBeGreaterThan(loaded);
    expect(link).toBeGreaterThan(unknownLoaded);
    expect(postInstall).toContain('canonical bwrap AppArmor policy is already loaded; leaving it unchanged');
    expect(postInstall).toContain('refusing to overwrite it');
    expect(postInstall).not.toContain('install -m 0644 "$DISTRO_PROFILE" "$PROFILE"');
  });

  it('gives source-tree verification an actionable AppArmor failure without suggesting a weaker boundary', () => {
    expect(verifier).toContain("['/usr/bin/bwrap', '/bin/bwrap']");
    expect(verifier).toContain("['--unshare-user', '--unshare-net', '--ro-bind', '/', '/', '/bin/true']");
    expect(verifier).toContain('/proc/sys/kernel/apparmor_restrict_unprivileged_userns');
    expect(verifier).toContain('install/activate the distro bwrap-userns-restrict profile');
    expect(verifier).toContain('Do not disable AppArmor');
    expect(verifier).toContain('do not run local-cgpt with sudo');
    expect(verifier).not.toContain('sysctl -w');
  });
});
