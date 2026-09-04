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
  # Keep the pipe scoped to startswith(); otherwise the right side of `or` receives the
  # title string and `.title` fails because it is no longer evaluating the milestone object.
  number=$(gh api --paginate "repos/$repo/milestones?state=all&per_page=100" \
    --jq ".[] | select((.title | startswith(\"$id — \")) or .title == \"$id\") | .number" | head -n1)

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
  "Complete: established the Linux-first fail-closed baseline, command isolation, security regression gates, controlled candidate evidence, and representative normal-user sandbox proof." \
  "closed"

ensure_milestone \
  "M1" \
  "M1 — Linux sandbox hardening and usability" \
  "Current: make Linux containment dependable for daily use with compatibility checks, actionable diagnostics, packaging integration, and representative runtime proof." \
  "open"

ensure_milestone \
  "M2" \
  "M2 — Capability and network least privilege" \
  "In progress: keep local mutation, process execution, network/external-data access, desktop access, and trusted host-runtime authority independently explicit, narrow, and revocable." \
  "open"

ensure_milestone \
  "M3" \
  "M3 — Browser and session privacy" \
  "Planned: minimize sensitive browser/session retention, make external processing obvious, and provide verifiable lifecycle/deletion controls." \
  "open"

ensure_milestone \
  "M4" \
  "M4 — Release provenance and signing" \
  "Planned: produce reviewable releases with provenance, SBOM/checksums, hardened packaging gates, and publisher signing where applicable." \
  "open"

ensure_milestone \
  "M5" \
  "M5 — Hardened upstream maintenance" \
  "Planned: define repeatable upstream/dependency intake with focused trust-boundary review and regression guards that preserve fork security invariants." \
  "open"

ensure_milestone \
  "M6" \
  "M6 — Product and repository experience" \
  "Planned: make the repository and app coherent, accessible, responsive, and trustworthy while fixing user-facing correctness and documentation drift." \
  "open"

ensure_milestone \
  "M7" \
  "M7 — Architecture, performance and maintainability" \
  "Planned: decompose oversized state machines, measure runtime costs, minimize dormant feature work, and improve deterministic developer and CI feedback." \
  "open"

ensure_milestone \
  "M8" \
  "M8 — Agent orchestration v2" \
  "Planned: add structured worker results, scopes and dependencies, logical worker succession, and only after isolation is proven, bounded multi-prime scheduling." \
  "open"

echo "GitHub milestones are synchronized with milestones/README.md."
