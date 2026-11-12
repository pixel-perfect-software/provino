import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The part of a package.json the packaging tools read.
 * @internal
 */
export interface PackageManifest {
  readonly name: string
  readonly version: string | undefined
  readonly private: boolean
  readonly type: string | undefined
  /** `exports` as written: subpath → condition → target. */
  readonly exports: Readonly<Record<string, Readonly<Record<string, string>>>>
  readonly bin: Readonly<Record<string, string>>
  readonly files: readonly string[]
  readonly scripts: Readonly<Record<string, string>>
  readonly dependencies: Readonly<Record<string, string>>
  readonly devDependencies: Readonly<Record<string, string>>
  readonly peerDependencies: Readonly<Record<string, string>>
  readonly optionalDependencies: Readonly<Record<string, string>>
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {}
}

function stringRecord(value: unknown): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(record(value)).filter((entry): entry is [string, string] => {
      return typeof entry[1] === 'string'
    }),
  )
}

/**
 * Reads `<dir>/package.json`, parsing every field this repo's package.json files use in the shape
 * the tools expect. A field of another shape reads as empty (and the tools that need it say so).
 * @internal
 */
export function readManifest(dir: string): PackageManifest {
  const path = join(dir, 'package.json')
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`cannot read ${path}`, { cause: error })
  }
  const json = record(raw)
  if (typeof json.name !== 'string') throw new Error(`${path} has no name`)
  const exports = Object.fromEntries(
    Object.entries(record(json.exports)).map(([subpath, conditions]) => [
      subpath,
      stringRecord(conditions),
    ]),
  )
  const bin =
    typeof json.bin === 'string'
      ? { [json.name.replace(/^@[^/]+\//, '')]: json.bin }
      : stringRecord(json.bin)
  return {
    name: json.name,
    version: typeof json.version === 'string' ? json.version : undefined,
    private: json.private === true,
    type: typeof json.type === 'string' ? json.type : undefined,
    exports,
    bin,
    files: Array.isArray(json.files)
      ? json.files.filter((file): file is string => typeof file === 'string')
      : [],
    scripts: stringRecord(json.scripts),
    dependencies: stringRecord(json.dependencies),
    devDependencies: stringRecord(json.devDependencies),
    peerDependencies: stringRecord(json.peerDependencies),
    optionalDependencies: stringRecord(json.optionalDependencies),
  }
}

/**
 * Every package a build of this package may leave an `import` of: its runtime dependency fields.
 * @internal
 */
export function runtimeDependencyNames(manifest: PackageManifest): readonly string[] {
  return [
    ...new Set([
      ...Object.keys(manifest.dependencies),
      ...Object.keys(manifest.peerDependencies),
      ...Object.keys(manifest.optionalDependencies),
    ]),
  ].sort()
}
