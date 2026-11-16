// The `claims` command of `bench:loader`: what the claims verdicts cost over one big package. A
// generated `node_modules` package of N files in one directory, every one claimed by a catch-all
// transform pattern, each required by one test file, so the loader asks for a verdict, and for the
// nearest `package.json`'s `type`, once per file. Each pass is a fresh loader (its caches empty) and
// times the file's import. A code change is measured by running this on both trees, in alternation
// (`local`; no bar).
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLoader } from '@provino/loader'
import { neutralPolicy } from '@provino/policy'
import { createResolver } from '@provino/resolver'
import { createPipeline } from '@provino/transform'
import { median } from '../stats.ts'

/** Files in the generated package. */
export const CLAIMS_FILES = 2000
const PASSES = 9
const WARMUP_PASSES = 2

/** Writes the project under `root`; returns the test file's path. */
function writeProject(root: string, files: number): string {
  const lib = join(root, 'node_modules', 'bigpkg', 'lib')
  mkdirSync(lib, { recursive: true })
  writeFileSync(join(root, 'node_modules', 'bigpkg', 'package.json'), '{"name":"bigpkg"}\n')
  const requires: string[] = []
  for (let index = 0; index < files; index++) {
    writeFileSync(join(lib, `f${index}.js`), `module.exports = ${index}\n`)
    requires.push(`total += require('bigpkg/lib/f${index}.js')`)
  }
  const entry = join(root, 'entry.js')
  writeFileSync(entry, `let total = 0\n${requires.join('\n')}\nexports.total = total\n`)
  return entry
}

async function onePass(root: string, entry: string): Promise<number> {
  const loader = createLoader({
    root,
    engine: 'runner',
    resolver: createResolver({
      root,
      mappers: [],
      extensions: ['.ts', '.js', '.mjs', '.cjs', '.json'],
      tsconfig: false,
    }),
    transformer: createPipeline({
      root,
      typescript: 'oxc',
      tsconfig: false,
      hoist: null,
      cache: false,
    }),
    policy: neutralPolicy.module,
    transformClaims: { patterns: ['\\.[jt]sx?$'], ignorePatterns: [] },
  })
  const registry = loader.createFileRegistry(entry, { tier: 'registry' })
  const start = process.hrtime.bigint()
  await registry.import(entry)
  const elapsed = Number(process.hrtime.bigint() - start) / 1e6
  await registry.dispose()
  return elapsed
}

/** The lines to print: the median of the kept passes' import time over the claimed files. */
export async function claimsLines(): Promise<string[]> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'provino-loader-claims-')))
  try {
    const entry = writeProject(root, CLAIMS_FILES)
    const times: number[] = []
    for (let pass = 0; pass < PASSES; pass++) times.push(await onePass(root, entry))
    const kept = times.slice(WARMUP_PASSES)
    return [
      `loader claims (local, Node ${process.version}, ${CLAIMS_FILES} claimed files in one directory)`,
      `  import of a file requiring all of them: median ${median(kept).toFixed(1)} ms over ${kept.length} fresh loaders (min ${Math.min(...kept).toFixed(1)}, max ${Math.max(...kept).toFixed(1)})`,
    ]
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}
