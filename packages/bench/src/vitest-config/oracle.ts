// The oracle the sample check calls: Vitest 5.0.5's `resolveConfig` from the sample's own install,
// and ours beside it. Each returns an encoded result or the error text, so both sides compare the
// same way in the child that reads a sample config.
import { existsSync, readFileSync } from 'node:fs'
import { findPackageJSON } from 'node:module'
import { basename, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  findVitestConfig,
  loadVitestConfig,
  resolveVitestProjects,
} from '@provino/dialect-vitest/node'
import { encodeTest } from './compare.ts'
import { SAMPLE_DIR } from './sample-paths.ts'

/** One side's outcome. */
export type ReadOutcome =
  | {
      readonly ok: true
      readonly test: Record<string, unknown>
      readonly root: string
      /** Vitest's `resolve.alias`, where `test.alias` ends up. */
      readonly alias?: unknown
    }
  | {
      readonly ok: false
      readonly error: string
      readonly code: string | null
    }

function failure(error: unknown): Extract<ReadOutcome, { ok: false }> {
  const causes: string[] = []
  for (let at: unknown = error; at instanceof Error; at = at.cause) causes.push(at.message)
  const message = causes.length === 0 ? String(error) : causes.join(' <- ')
  const code: unknown = error instanceof Error ? Reflect.get(error, 'code') : undefined
  return { ok: false, error: message, code: typeof code === 'string' ? code : null }
}

/** What the reader's side adds: the config's own keys, and whether a plugin could change them. */
export type ProvinoOutcome =
  | (Extract<ReadOutcome, { ok: true }> & {
      readonly needsVite: boolean
      readonly warnings: readonly string[]
      /** The keys of `test` the config file and command line name. */
      readonly given: readonly string[]
    })
  | Extract<ReadOutcome, { ok: false }>

interface ResolveConfigModule {
  resolveConfig(options: object): Promise<{ test: unknown; resolve?: { alias?: unknown } }>
}

/** `vitest/node` from the sample's own install (5.0.5), the one the configs' `vitest/config` is. */
async function sampleVitestNode(): Promise<ResolveConfigModule> {
  const manifest = findPackageJSON('vitest', pathToFileURL(join(SAMPLE_DIR, 'x.js')))
  if (manifest === undefined)
    throw new Error('vitest is not installed in the sample: run sample --fetch')
  const parsed: { exports: Record<string, { default?: string; import?: string }> } = JSON.parse(
    readFileSync(manifest, 'utf8'),
  )
  const target = parsed.exports['./node']
  const entry = target?.default ?? target?.import
  if (entry === undefined) throw new Error('vitest has no ./node export')
  return import(pathToFileURL(join(dirname(manifest), entry)).href) as Promise<ResolveConfigModule>
}

/** Real `resolveConfig` for the config at `config` (a path), or for an empty root with none. */
export async function readWithVitest(config: string | null, root: string): Promise<ReadOutcome> {
  try {
    const { resolveConfig } = await sampleVitestNode()
    const resolved = await resolveConfig(
      config === null ? { root, config: false } : { root, config },
    )
    return {
      ok: true,
      test: encodeTest(resolved.test),
      root,
      alias: encodeTest({ alias: resolved.resolve?.alias }).alias,
    }
  } catch (error) {
    return failure(error)
  }
}

/** Ours: the reader's merged `test` of the root config. */
export async function readWithProvino(config: string): Promise<ProvinoOutcome> {
  try {
    const root = dirname(config)
    const source = findVitestConfig(root, basename(config))
    if (source === undefined || !existsSync(source.path)) throw new Error('config not found')
    const loaded = await loadVitestConfig(source, { mode: 'test' })
    const warnings: string[] = []
    const resolved = await resolveVitestProjects(
      loaded,
      { cwd: root, config: basename(config) },
      [],
    )
    return {
      ok: true,
      // `root` is computed from the config, so it joins the merged keys here.
      test: { ...encodeTest(resolved.root.test), root: resolved.root.root },
      given: Object.keys(resolved.root.given),
      root: resolved.root.root,
      needsVite: resolved.root.needsVite,
      warnings,
    }
  } catch (error) {
    return failure(error)
  }
}
