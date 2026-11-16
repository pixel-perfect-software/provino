// The `per-file` command of `bench:loader`: what settling the per-file set (D132) costs on a hub.
// A seed package (`seed`, made per file with `reevaluateExternals`), `MEMBERS` packages that each
// require it and one helper (`hub`), and one shared package that requires the hub too, so the hub
// has `MEMBERS` per-file importers and one shared one and never joins. The first file loads all of
// them natively (no seed yet); the seed is given before the second file, which requires `FRESH`
// packages the worker has not seen, each of them a new external to index and settle. The second
// file's load is timed, in a fresh loader per pass (`local`; no bar). A code change is measured by
// running this on both trees.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLoader } from '@provino/loader'
import { neutralPolicy } from '@provino/policy'
import { createResolver } from '@provino/resolver'
import { createPipeline } from '@provino/transform'
import { median } from '../stats.ts'

/** The hub's per-file importers. */
export const PER_FILE_MEMBERS = 3000
/** The packages the second file requires that the worker has not seen. */
export const PER_FILE_FRESH = 20
const PASSES = 5
const WARMUP_PASSES = 1

function writePackage(root: string, name: string, source: string): void {
  const dir = join(root, 'node_modules', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), `{"name":"${name}","main":"index.js"}\n`)
  writeFileSync(join(dir, 'index.js'), source)
}

interface Project {
  readonly first: string
  readonly second: string
  readonly seed: string
}

function writeProject(root: string): Project {
  writePackage(root, 'seed', 'module.exports = {}\n')
  writePackage(root, 'hub', 'module.exports = {}\n')
  writePackage(root, 'shared', "module.exports = require('hub')\n")
  const first: string[] = []
  for (let index = 0; index < PER_FILE_MEMBERS; index++) {
    writePackage(root, `member${index}`, "require('seed')\nmodule.exports = require('hub')\n")
    first.push(`require('member${index}')`)
  }
  first.push("require('shared')")
  const second: string[] = []
  for (let index = 0; index < PER_FILE_FRESH; index++) {
    writePackage(root, `fresh${index}`, 'module.exports = {}\n')
    second.push(`require('fresh${index}')`)
  }
  writeFileSync(join(root, 'first.js'), `${first.join('\n')}\n`)
  writeFileSync(join(root, 'second.js'), `${second.join('\n')}\n`)
  return {
    first: join(root, 'first.js'),
    second: join(root, 'second.js'),
    seed: join(root, 'node_modules', 'seed', 'index.js'),
  }
}

function onePass(root: string, project: Project): number {
  const loader = createLoader({
    root,
    engine: 'runner',
    resolver: createResolver({ root, mappers: [], extensions: ['.js', '.json'], tsconfig: false }),
    transformer: createPipeline({
      root,
      typescript: 'oxc',
      tsconfig: false,
      hoist: null,
      cache: false,
    }),
    policy: { ...neutralPolicy.module, reevaluateHookingExternals: true },
  })
  loader.createFileRegistry(project.first, { tier: 'registry' }).require(project.first)
  loader.reevaluateExternals([project.seed])
  const registry = loader.createFileRegistry(project.second, { tier: 'registry' })
  const start = process.hrtime.bigint()
  registry.require(project.second)
  return Number(process.hrtime.bigint() - start) / 1e6
}

/** The lines to print: the median of the kept passes' load time of the second file. */
export function perFileLines(): string[] {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'provino-loader-per-file-')))
  try {
    const project = writeProject(root)
    const times: number[] = []
    for (let pass = 0; pass < PASSES; pass++) times.push(onePass(root, project))
    const kept = times.slice(WARMUP_PASSES)
    return [
      `loader per-file (local, Node ${process.version}, a hub with ${PER_FILE_MEMBERS} per-file importers and 1 shared one)`,
      `  a file requiring ${PER_FILE_FRESH} unseen packages: median ${median(kept).toFixed(1)} ms over ${kept.length} fresh loaders (min ${Math.min(...kept).toFixed(1)}, max ${Math.max(...kept).toFixed(1)})`,
    ]
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}
