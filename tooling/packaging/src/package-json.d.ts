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
  /** `publishConfig.bin`: what `pnpm pack` writes over `bin` in the tarball. */
  readonly publishBin: Readonly<Record<string, string>>
  readonly files: readonly string[]
  readonly scripts: Readonly<Record<string, string>>
  readonly dependencies: Readonly<Record<string, string>>
  readonly devDependencies: Readonly<Record<string, string>>
  readonly peerDependencies: Readonly<Record<string, string>>
  readonly optionalDependencies: Readonly<Record<string, string>>
}
/**
 * The value as a plain object, or an empty one when it is anything else (an array, `null`, a
 * string): what a JSON file's top level or a field of it reads as, without a cast.
 * @internal
 */
export declare function record(value: unknown): Readonly<Record<string, unknown>>
/**
 * Reads `<dir>/package.json`, parsing every field this repo's package.json files use in the shape
 * the tools expect. A field of another shape reads as empty (and the tools that need it say so).
 * @internal
 */
export declare function readManifest(dir: string): PackageManifest
/**
 * Every package a build of this package may leave an `import` of: its runtime dependency fields.
 * @internal
 */
export declare function runtimeDependencyNames(manifest: PackageManifest): readonly string[]
//# sourceMappingURL=package-json.d.ts.map
