// The worker's loader from clone-safe settings. The worker entry may not import the resolver or the
// transform pipeline (the package manifest), so the loader builds them: resolver and pipeline from
// the project's `SerializedLoaderConfig`, then `createLoader` with the runner engine.
import { createBehaviourLoader } from '@provino/policy'
import { createResolver } from '@provino/resolver'
import { createPipeline } from '@provino/transform'
import type {
  Loader,
  ModuleMapper,
  ModulePolicy,
  ResolverOptions,
  SerializedLoaderConfig,
} from '@provino/types'
import { createLoader } from './loader.ts'

/**
 * The resolver's `tsconfig` option for the config's: `'auto'` and `false` pass through, and any
 * other string is the path of the tsconfig file. (`'auto'` is a string too, so a bare `typeof`
 * check would hand the resolver a file named "auto".)
 */
function resolverTsconfig(
  tsconfig: SerializedLoaderConfig['tsconfig'],
): NonNullable<ResolverOptions['tsconfig']> {
  return tsconfig === 'auto' || tsconfig === false ? tsconfig : { configFile: tsconfig }
}

/**
 * Creates the worker's loader for one project. `config.mappers` are loaded by `ModuleRef` first,
 * which is why this is async. Mock hoisting and the transform cache are off until their tasks land
 * (B13, T3.6).
 * @public
 */
export async function createProjectLoader(
  root: string,
  config: SerializedLoaderConfig,
  policy: ModulePolicy,
): Promise<Loader> {
  const behaviours = createBehaviourLoader()
  // In config order: the first mapper to hit wins.
  const mappers: ModuleMapper[] = await Promise.all(
    config.mappers.map(async (mapper) => (await behaviours.load(mapper.factory))(mapper.options)),
  )
  return createLoader({
    root,
    engine: 'runner',
    resolver: createResolver({
      root,
      mappers,
      extensions: config.extensions,
      tsconfig: resolverTsconfig(config.tsconfig),
    }),
    transformer: createPipeline({
      root,
      typescript: config.typescript,
      tsconfig: config.tsconfig,
      hoist: null,
      cache: false,
    }),
    policy,
    conditions: config.conditions,
  })
}
