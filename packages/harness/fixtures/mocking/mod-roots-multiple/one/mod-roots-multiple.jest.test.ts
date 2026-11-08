import { who as first } from 'first-pkg'
import { who as outside } from 'outside-pkg'
import { who as second } from 'second-pkg'

const c = (id: string, run: () => unknown) => {
  test(id, () => observe(id, run))
}

c('a root __mocks__ file in the first root', () => ({ first }))

c('a root __mocks__ file in the second root', () => ({ second }))

c('a root __mocks__ file outside every root', () => ({ outside }))
