// A worker whose main throws before it can say `ready`.
import type { WorkerMain } from '@provino/types'

const main: WorkerMain = () => {
  throw new Error('boom from the main')
}
export default main
