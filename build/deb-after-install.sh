#!/bin/bash

# This script intentionally preserves electron-builder 26.15.7's complete default
# packages/app-builder-lib/templates/linux/after-install.tpl behavior before applying the
# local-cgpt Bubblewrap policy addition below. deb.afterInstall replaces (rather than composes
# with) that template, so omitting any of these operations would regress package installation.
# Keep command lookup rooted in system-managed directories because this script runs as root.
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH

if type update-alternatives >/dev/null 2>&1; then
    # Remove previous link if it doesn't use update-alternatives
    if [ -L '/usr/bin/${executable}' -a -e '/usr/bin/${executable}' -a "`readlink '/usr/bin/${executable}'`" != '/etc/alternatives/${executable}' ]; then
        rm -f '/usr/bin/${executable}'
    fi
    update-alternatives --install '/usr/bin/${executable}' '${executable}' '/opt/${sanitizedProductName}/${executable}' 100 || ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
else
    ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
fi
# Check if user namespaces are supported by the kernel and working with a quick test:
if ! { [[ -L /proc/self/ns/user ]] && unshare --user true; }; then
    # Use SUID chrome-sandbox only on systems without user namespaces:
    chmod 4755 '/opt/${sanitizedProductName}/chrome-sandbox' || true
else
    chmod 0755 '/opt/${sanitizedProductName}/chrome-sandbox' || true
fi

if hash update-mime-database 2>/dev/null; then
    update-mime-database /usr/share/mime || true
fi
if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi
# Install apparmor profile. (Ubuntu 24+)
# First check if the version of AppArmor running on the device supports our profile.
# This is in order to keep backwards compatibility with Ubuntu 22.04 which does not support abi/4.0.
# In that case, we just skip installing the profile since the app runs fine without it on 22.04.
#
# Those apparmor_parser flags are akin to performing a dry run of loading a profile.
# https://wiki.debian.org/AppArmor/HowToUse#Dumping_profiles
#
# Unfortunately, at the moment AppArmor doesn't have a good story for backwards compatibility.
# https://askubuntu.com/questions/1517272/writing-a-backwards-compatible-apparmor-profile
if apparmor_status --enabled > /dev/null 2>&1; then
  APPARMOR_PROFILE_SOURCE='/opt/${sanitizedProductName}/resources/apparmor-profile'
  APPARMOR_PROFILE_TARGET='/etc/apparmor.d/${executable}'
  if apparmor_parser --skip-kernel-load --debug "$APPARMOR_PROFILE_SOURCE" > /dev/null 2>&1; then
    cp -f "$APPARMOR_PROFILE_SOURCE" "$APPARMOR_PROFILE_TARGET"
    # Updating the current AppArmor profile is not possible and probably not meaningful in a chroot'ed environment.
    # Use cases are for example environments where images for clients are maintained.
    # There, AppArmor might correctly be installed, but live updating makes no sense.
    if ! { [ -x '/usr/bin/ischroot' ] && /usr/bin/ischroot; } && hash apparmor_parser 2>/dev/null; then
      # Extra flags taken from dh_apparmor:
      # > By using '-W -T' we ensure that any abstraction updates are also pulled in.
      # https://wiki.debian.org/AppArmor/Contribute/FirstTimeProfileImport
      apparmor_parser --replace --write-cache --skip-read-cache "$APPARMOR_PROFILE_TARGET"
    fi
  else
    echo "Skipping the installation of the AppArmor profile as this version of AppArmor does not seem to support the bundled profile"
  fi
fi

# local-cgpt M0 addition: Ubuntu 24.04 can keep unprivileged user namespaces restricted through
# AppArmor while allowing Bubblewrap to create its setup namespace through the distro's dedicated
# bwrap-userns-restrict policy. Never relax the global restriction as a compatibility workaround.
set -eu
RESTRICT_SYSCTL=/proc/sys/kernel/apparmor_restrict_unprivileged_userns
APPARMOR_ENABLED=/sys/module/apparmor/parameters/enabled
LOADED_PROFILES=/sys/kernel/security/apparmor/profiles
PROFILE=/etc/apparmor.d/bwrap-userns-restrict
DISTRO_PROFILE=/usr/share/apparmor/extra-profiles/bwrap-userns-restrict

note() {
  printf '%s\n' "local-cgpt: $*" >&2
}

fail() {
  note "$*"
  note 'Command execution will remain fail-closed; do not disable AppArmor or the global unprivileged-userns restriction.'
  exit 1
}

# Systems without Ubuntu's AppArmor userns restriction do not require this compatibility policy.
[ -r "$RESTRICT_SYSCTL" ] || exit 0
[ "$(cat "$RESTRICT_SYSCTL" 2>/dev/null || true)" = '1' ] || exit 0
[ -r "$APPARMOR_ENABLED" ] || exit 0
case "$(cat "$APPARMOR_ENABLED" 2>/dev/null || true)" in
  Y|y) ;;
  *) exit 0 ;;
esac

canonical_present=0
if [ -e "$PROFILE" ] || [ -L "$PROFILE" ]; then
  if ! grep -Eq '^[[:space:]]*profile[[:space:]]+([^[:space:]]+[[:space:]]+)?/usr/bin/bwrap([[:space:]]|$)' "$PROFILE" 2>/dev/null; then
    fail "$PROFILE exists but does not define a recognizable /usr/bin/bwrap profile; refusing to overwrite it."
  fi
  canonical_present=1
fi

# Refuse to install a second attachment for /usr/bin/bwrap under another filename. Multiple
# competing profiles for the same executable are an unsafe place for a package postinst to guess.
for candidate in /etc/apparmor.d/*; do
  [ -f "$candidate" ] || continue
  [ "$candidate" = "$PROFILE" ] && continue
  if grep -Eq '^[[:space:]]*profile[[:space:]]+([^[:space:]]+[[:space:]]+)?/usr/bin/bwrap([[:space:]]|$)' "$candidate" 2>/dev/null; then
    fail "another AppArmor profile already targets /usr/bin/bwrap: $candidate. Review that policy manually before enabling command execution."
  fi
done

loaded=0
if [ -r "$LOADED_PROFILES" ] && grep -q '^bwrap ' "$LOADED_PROFILES"; then
  loaded=1
fi

if [ "$loaded" = '1' ]; then
  [ "$canonical_present" = '1' ] || fail 'a bwrap AppArmor profile is loaded but the canonical /etc/apparmor.d/bwrap-userns-restrict policy file is absent; refusing to trust unknown loaded policy.'
  note 'canonical bwrap AppArmor policy is already loaded; leaving it unchanged.'
  exit 0
fi

if [ "$canonical_present" = '0' ]; then
  [ -r "$DISTRO_PROFILE" ] || fail "Ubuntu's bwrap-userns-restrict profile is unavailable. Ensure the apparmor-profiles package is installed from supported Ubuntu repositories."

  owner="$(dpkg-query -S "$DISTRO_PROFILE" 2>/dev/null | head -n 1 || true)"
  case "$owner" in
    apparmor-profiles:*) ;;
    *) fail "refusing to install an unowned bwrap AppArmor profile from $DISTRO_PROFILE" ;;
  esac

  ln -s "$DISTRO_PROFILE" "$PROFILE"
  canonical_present=1
  note 'linked Ubuntu bwrap-userns-restrict policy for AppArmor-gated user namespaces.'
else
  note 'existing canonical bwrap-userns-restrict policy found; leaving its contents unchanged.'
fi

command -v apparmor_parser >/dev/null 2>&1 || fail 'apparmor_parser is unavailable even though AppArmor user-namespace restriction is active.'
if ! apparmor_parser -r "$PROFILE"; then
  fail "failed to load $PROFILE"
fi

if [ -r "$LOADED_PROFILES" ] && ! grep -q '^bwrap ' "$LOADED_PROFILES"; then
  fail 'bwrap AppArmor policy was parsed but is not reported as loaded.'
fi

note 'bwrap AppArmor policy is active; the global unprivileged-userns restriction remains enabled.'
exit 0
