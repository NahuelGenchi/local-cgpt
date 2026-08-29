#!/bin/sh
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH

# Ubuntu 24.04 can keep unprivileged user namespaces restricted through AppArmor while
# allowing bubblewrap to create its setup namespace through the distro's dedicated
# bwrap-userns-restrict policy. Only touch policy when that restriction is actually active.
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
if [ -e "$PROFILE" ]; then
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
