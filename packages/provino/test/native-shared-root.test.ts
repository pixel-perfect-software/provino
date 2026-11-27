// A native config whose projects share a root and select different files runs each file once, in
// its own project's environment; a file both projects select is refused before anything runs
// (exit 2, naming the projects and the file). Through the source bin.
import { symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, test } from 'provino'
import { nativeProject, nativeRunArgs, outcomesByFile, spawnCli } from './support.ts'

const FILES: Readonly<Record<string, string>> = {
  'a.test.ts': [
    "import { expect, it } from 'provino'",
    "it('runs in node', () => expect(typeof document).toBe('undefined'))",
    '',
  ].join('\n'),
  'b.test.tsx': [
    "import { expect, it } from 'provino'",
    "it('runs in jsdom', () => expect(typeof document).toBe('object'))",
    '',
  ].join('\n'),
}

describe('projects that share a root', () => {
  test('disjoint include globs: each file runs once, in its own environment', async () => {
    const dir = await nativeProject(
      FILES,
      `export default {
  projects: [
    { name: 'node', include: ['*.test.ts'] },
    { name: 'window', include: ['*.test.tsx'], environment: 'jsdom' },
  ],
}
`,
    )
    const ran = await spawnCli(nativeRunArgs('forks'), { cwd: dir })
    const outcomes = await outcomesByFile(dir)
    expect(outcomes.get('a.test.ts')).toBe('passed')
    expect(outcomes.get('b.test.tsx')).toBe('passed')
    expect(outcomes.size).toBe(2)
    expect(ran.code).toBe(0)
  })

  test('a file both projects select is refused: exit 2, naming the projects and the file', async () => {
    const dir = await nativeProject(
      FILES,
      `export default {
  projects: [
    { name: 'node', include: ['*.test.ts*'] },
    { name: 'window', include: ['*.test.tsx', 'a.test.ts'], environment: 'jsdom' },
  ],
}
`,
    )
    const ran = await spawnCli(nativeRunArgs('forks'), { cwd: dir })
    expect(ran.code).toBe(2)
    expect(ran.stderr).toMatch(/projects "node" and "window" both run/)
    expect(ran.stderr).toContain('a.test.ts')
    expect(ran.stderr).toContain('b.test.tsx')
  })

  test('the overlap is judged before a file argument narrows the run', async () => {
    const dir = await nativeProject(
      FILES,
      `export default {
  projects: [
    { name: 'node', include: ['*.test.ts'] },
    { name: 'again', include: ['a.test.ts'] },
  ],
}
`,
    )
    const ran = await spawnCli([...nativeRunArgs('forks'), 'b.test'], { cwd: dir })
    expect(ran.code).toBe(2)
    expect(ran.stderr).toMatch(/projects "node" and "again" both run a\.test\.ts/)
  })

  test('a root that is a symlink into another project tree is judged by real path', async () => {
    const dir = await nativeProject(
      {
        'sub/x.test.ts': "import { it } from 'provino'\nit('x', () => {})\n",
      },
      `export default {
  projects: [{ name: 'real', include: ['sub/*.test.ts'] }, 'alias'],
}
`,
    )
    await symlink(join(dir, 'sub'), join(dir, 'alias'), 'dir')
    const ran = await spawnCli(nativeRunArgs('forks'), { cwd: dir })
    expect(ran.code).toBe(2)
    expect(ran.stderr).toMatch(/both run x\.test\.ts|both run sub\/x\.test\.ts/)
  })
})
