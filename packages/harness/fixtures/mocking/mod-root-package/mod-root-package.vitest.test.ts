import { who as scoped } from '@scope/scoped-pkg'
import { who as plain } from 'plain-pkg'

const c = (id: string, run: () => unknown) => {
  test(id, () => observe(id, run))
}

c('a root __mocks__ file for a plain package, no mock call', () => ({ plain }))

c('a root __mocks__ file for a scoped package, no mock call', () => ({ scoped }))
