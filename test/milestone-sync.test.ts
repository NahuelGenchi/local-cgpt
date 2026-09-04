import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const scriptPath = resolve(process.cwd(), 'scripts/sync-github-milestones.sh')
const script = readFileSync(scriptPath, 'utf8')

describe('milestone sync script', () => {
  it('keeps milestone title matching on the milestone object instead of piping title into the full predicate', () => {
    expect(script).toContain(
      'select((.title | startswith(\\"$id — \\")) or .title == \\"$id\\") | .number',
    )
    expect(script).not.toContain(
      'select(.title | startswith(\\"$id — \\") or .title == \\"$id\\") | .number',
    )
  })

  it('tracks every documented milestone M0 through M8', () => {
    for (let index = 0; index <= 8; index += 1) {
      expect(script).toContain(`  \\"M${index}\\" \\\\`)
    }
  })
})
