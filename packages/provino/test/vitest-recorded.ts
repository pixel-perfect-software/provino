// B25g: a `cli/vitest-*` black-box fixture written out as the recorder writes it for Vitest 5.0.5
// (`packages/harness/src/internal/runner-config.ts` `vitestConfigSource`, minus the trace setup),
// and `provino vitest` run on it through the bin, in the recorder's environment.
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Spawned, spawnCli } from './support.ts'

const FIXTURES = fileURLToPath(new URL('../../harness/fixtures/', import.meta.url))

/** The parts of a `fixture.json` a Vitest replay reads. */
export interface VitestManifest {
  readonly env?: Readonly<Record<string, string>>
  readonly files?: { readonly vitest?: Readonly<Record<string, string>> }
  readonly config?: { readonly vitest?: { readonly test?: Readonly<Record<string, unknown>> } }
  readonly run?: {
    readonly argv?: { readonly vitest?: readonly string[] }
    readonly keepLines?: string
  }
}

/** The parts of a Vitest golden a replay compares. */
export interface VitestGolden {
  readonly observed?: {
    readonly exitCode?: number
    readonly stdout?: string
    readonly stderr?: string
    readonly json?: Readonly<Record<string, unknown>>
    readonly files?: Readonly<Record<string, string | null>>
  }
}

export interface VitestFixture {
  readonly id: string
  readonly dir: string
  readonly manifest: VitestManifest
  readonly golden: VitestGolden
}

export async function loadVitestFixture(id: string): Promise<VitestFixture> {
  const dir = join(FIXTURES, id)
  return {
    id,
    dir,
    manifest: JSON.parse(await readFile(join(dir, 'fixture.json'), 'utf8')) as VitestManifest,
    golden: JSON.parse(
      await readFile(join(dir, '__goldens__', 'vitest.json'), 'utf8'),
    ) as VitestGolden,
  }
}

/** The fixture's files, its `files.vitest` and a `vitest.config.ts` with the recorder's base. */
export async function materializeVitest(
  fixture: VitestFixture,
): Promise<{ readonly root: string; readonly dispose: () => Promise<void> }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'provino-vitest-recorded-')))
  await cp(fixture.dir, root, {
    recursive: true,
    filter: (source) => !/(^|\/)(fixture\.json|__goldens__)$/.test(source),
  })
  for (const [path, text] of Object.entries(fixture.manifest.files?.vitest ?? {})) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), text)
  }
  const config = {
    root,
    test: {
      globals: true,
      includeTaskLocation: true,
      include: ['**/*.test.ts'],
      exclude: ['**/node_modules/**', '**/__goldens__/**', '**/*.jest.test.ts'],
      ...fixture.manifest.config?.vitest?.test,
    },
  }
  await writeFile(
    join(root, 'vitest.config.ts'),
    `export default ${JSON.stringify(config, null, 2)}\n`,
  )
  await writeFile(join(root, 'package.json'), '{ "type": "module" }\n')
  return { root, dispose: () => rm(root, { recursive: true, force: true }) }
}

/** `provino vitest run <argv>` in the root, under the recorder's `CI=1`, `TZ=UTC` and `NO_COLOR=1`. */
export function provinoVitest(
  fixture: VitestFixture,
  root: string,
  extra: readonly string[] = [],
): Promise<Spawned> {
  return spawnCli(['vitest', 'run', ...(fixture.manifest.run?.argv?.vitest ?? []), ...extra], {
    cwd: root,
    env: { CI: '1', TZ: 'UTC', NO_COLOR: '1', ...fixture.manifest.env },
  })
}

/** A stream cut to the fixture's `keepLines`, as the golden records it. */
export function keptLines(fixture: VitestFixture, text: string): string {
  const pattern = fixture.manifest.run?.keepLines
  const lines = text.split('\n').filter((line) => line !== '')
  return (
    pattern === undefined ? lines : lines.filter((line) => new RegExp(pattern).test(line))
  ).join('\n')
}
