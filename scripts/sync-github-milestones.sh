#!/usr/bin/env bash
set -euo pipefail

repo="NahuelGenchi/local-cgpt"

gh auth status >/dev/null
actual_repo=$(gh repo view --json nameWithOwner --jq .nameWithOwner)
if [[ "$actual_repo" != "$repo" ]]; then
  echo "Expected repository $repo, got $actual_repo" >&2
  exit 1
fi

ensure_milestone() {
  local title=$1
  local description=$2
  local desired_state=$3
  local number

  number=$(gh api --paginate "repos/$repo/milestones?state=all&per_page=100" \
    --jq ".[] | select(.title == \"$title\") | .number" | head -n1)

  if [[ -z "$number" ]]; then
    number=$(gh api --method POST "repos/$repo/milestones" \
      -f title="$title" \
      -f description="$description" \
      --jq .number)
    echo "Created GitHub Milestone #$number: $title"
  fi

  local current_state current_description
  current_state=$(gh api "repos/$repo/milestones/$number" --jq .state)
  current_description=$(gh api "repos/$repo/milestones/$number" --jq '.description // ""')

  if [[ "$current_state" != "$desired_state" || "$current_description" != "$description" ]]; then
    gh api --method PATCH "repos/$repo/milestones/$number" \
      -f state="$desired_state" \
      -f description="$description" >/dev/null
    echo "Synchronized GitHub Milestone #$number: $title"
  fi
}

ensure_milestone \
  "M0 — Security-hardened baseline" \
  "Current: fail-closed fork baseline, Linux OS command isolation, security regression gates, accurate security documentation, and final-head supported-platform validation." \
  "open"

ensure_milestone \
  "M1 — Cross-platform command containment" \
  "Planned: OS-enforced command containment on supported Windows/macOS paths without unrestricted fallback when a sandbox backend is unavailable." \
  "open"

ensure_milestone \
  "M2 — Capability and network least privilege" \
  "Planned: independently explicit and enforceable local mutation, process execution, network egress, desktop access, and external data-transfer authority." \
  "open"

ensure_milestone \
  "M3 — Browser and session privacy" \
  "Planned: minimized browser/session retention, verifiable lifecycle/deletion controls, narrow extension origins, and explicit external-provider data boundaries." \
  "open"

ensure_milestone \
  "M4 — Release provenance and signing" \
  "Planned: reviewed-commit release builds, checksums, SBOM/provenance, hardened publication gates, and publisher signing/notarization where credentials exist." \
  "open"

ensure_milestone \
  "M5 — Hardened upstream maintenance" \
  "Planned: repeatable upstream/dependency intake with focused trust-boundary review and regression guards that preserve fork security invariants." \
  "open"

echo "GitHub milestones are synchronized with milestones/README.md."
