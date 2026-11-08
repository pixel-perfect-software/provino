import * as helper from './helper-vitest.ts'
import * as source from './source.ts'

const c = (id: string, run: () => unknown) => {
  test(id, () => observe(id, run))
}

const read = () => ({
  source: source.count,
  reExported: helper.count,
  importedThenExported: helper.importedCount,
})

c('before any change all three read 0', read)

c('after the source changes count, both re-exports follow', () => {
  source.inc()
  source.inc()
  return read()
})

c('a change made through the re-exported function is seen by all three', () => {
  helper.inc()
  return read()
})
