import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const scriptPath = resolve(process.cwd(), 'scripts/sync-github-milestones.sh')
const script = readFileSync(scriptPath, 'utf8')

describe('milestone sync script', () => {
  it('keeps milestone title matching on the milestone object', () => {
    expect(script).toContain(
      'select((.title | startswith(\\"$id — \\")) or .title == \\"$id\\") | .number',
    )
    expect(script).not.toContain(
      'select(.title | startswith(\\"$id — \\") or .title == \\"$id\\") | .number',
    )
  })

  it('declares every roadmap milestone M0 through M8 with the expected GitHub state', () => {
    const declarations = Array.from(
      script.matchAll(
        /ensure_milestone \\\n\s+"(M\d+)" \\\n\s+"([^"]+)" \\\n\s+"([^"]+)" \\\n\s+"(open|closed)"/g,
      ),
    ).map((match) => ({ id: match[1], state: match[4] }))

    expect(declarations).toEqual([
      { id: 'M0', state: 'closed' },
      { id: 'M1', state: 'open' },
      { id: 'M2', state: 'open' },
      { id: 'M3', state: 'open' },
      { id: 'M4', state: 'open' },
      { id: 'M5', state: 'open' },
      { id: 'M6', state: 'open' },
      { id: 'M7', state: 'open' },
      { id: 'M8', state: 'open' },
    ])
  })
})
