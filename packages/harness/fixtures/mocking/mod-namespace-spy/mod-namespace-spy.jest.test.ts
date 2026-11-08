import { welcome } from './consumer.ts'
import * as target from './target.ts'

const c = (id: string, run: () => unknown) => {
  test(id, () => observe(id, run))
}

c('spyOn on the namespace replaces the export for a module that imports it', () => {
  const spy = jest.spyOn(target, 'greet').mockReturnValue('spied')
  const spied = welcome()
  const calls = spy.mock.calls
  spy.mockRestore()
  return { spied, calls, restored: welcome() }
})
