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
  local id=$1
  local title=$2
  local description=$3
  local desired_state=$4
  local number

  # Match the stable roadmap ID so a milestone can be renamed without creating a duplicate.
  number=$(gh api --paginate "repos/$repo/milestones?state=all&per_page=100" \
    --jq ".[] | select(.title | startswith(\"$id — \") or .title == \"$id\") | .number" | head -n1)

  if [[ -z "$number" ]]; then
    number=$(gh api --method POST "repos/$repo/milestones" \
      -f title="$title" \
      -f description="$description" \
      --jq .number)
    echo "Created GitHub Milestone #$number: $title"
  fi

  local current_title current_state current_description
  current_title=$(gh api "repos/$repo/milestones/$number" --jq .title)
  current_state=$(gh api "repos/$repo/milestones/$number" --jq .state)
  current_description=$(gh api "repos/$repo/milestones/$number" --jq '.description // ""')

  if [[ "$current_title" != "$title" || "$current_state" != "$desired_state" || "$current_description" != "$description" ]]; then
    gh api --method PATCH "repos/$repo/milestones/$number" \
      -f title="$title" \
      -f state="$desired_state" \
      -f description="$description" >/dev/null
    echo "Synchronized GitHub Milestone #$number: $title"
  fi
}

ensure_milestone \
  "M0" \
  "M0 — Security-hardened baseline" \
  "Current: Linux-first fail-closed baseline, Linux OS command isolation, security regression gates, accurate security documentation, and final-head Linux validation." \
  "open"

ensure_milestone \
  "M1" \
  "M1 — Linux sandbox hardening and usability" \
  "Planned: Linux sandbox compatibility checks, actionable diagnostics, packaging integration, and representative target-runtime containment proof." \
  "open"

ensure_milestone \
  "M2" \
  "M2 — Capability and network least privilege" \
  "Planned: independently explicit and enforceable local mutation, process execution, network egress, desktop access, and external data-transfer authority." \
  "open"

ensure_milestone \
  "M3" \
  "M3 — Browser and session privacy" \
  "Planned: minimized browser/session retention, verifiable lifecycle/deletion controls, narrow extension origins, and explicit external-provider data boundaries." \
  "open"

ensure_milestone \
  "M4" \
  "M4 — Release provenance and signing" \
  "Planned: reviewed-commit release builds, checksums, SBOM/provenance, hardened publication gates, and publisher signing where applicable." \
  "open"

ensure_milestone \
  "M5" \
  "M5 — Hardened upstream maintenance" \
  "Planned: repeatable upstream/dependency intake with focused trust-boundary review and regression guards that preserve fork security invariants." \
  "open"

echo "GitHub milestones are synchronized with milestones/README.md."
