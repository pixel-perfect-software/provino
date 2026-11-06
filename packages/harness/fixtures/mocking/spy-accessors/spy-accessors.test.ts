// spyOn on getters and setters, and on a configurable getter export (the Vite SSR module shape).
const M = typeof jest === 'undefined' ? vi : jest
const c = (id: string, run: () => unknown) => {
  test(id, () => observe(id, run))
}
const attempt = (run: () => unknown) => {
  try {
    return { value: run() }
  } catch (error) {
    return { threw: error }
  }
}
const accessors = () => {
  let stored = 'initial'
  return {
    get value() {
      return stored
    },
    set value(next: string) {
      stored = next
    },
  }
}

c('a getter spy calls through, records and restores', () => {
  const target = accessors()
  const spy = M.spyOn(target, 'value', 'get')
  const read = target.value
  const calls = spy.mock.calls.length
  spy.mockReturnValue('stubbed')
  const stubbed = target.value
  spy.mockRestore()
  return { read, calls, stubbed, restored: target.value }
})

c('a setter spy records the assigned value and restores', () => {
  const target = accessors()
  const spy = M.spyOn(target, 'value', 'set')
  target.value = 'assigned'
  const calls = spy.mock.calls
  const afterCall = target.value
  spy.mockRestore()
  target.value = 'after restore'
  return { calls, afterCall, restored: target.value }
})

c('the wrong access type on an accessor', () => {
  const target = {
    get readonly() {
      return 1
    },
  }
  return attempt(() => M.spyOn(target, 'readonly', 'set' as never))
})

c('a non-configurable property', () => {
  const target = {}
  Object.defineProperty(target, 'locked', { get: () => 1, configurable: false })
  return attempt(() => M.spyOn(target, 'locked' as never, 'get' as never))
})

c('a configurable getter that returns a function, spied as a method', () => {
  const implementation = () => 'real'
  const namespace = {}
  Object.defineProperty(namespace, 'exported', {
    enumerable: true,
    configurable: true,
    get: () => implementation,
  })
  const result = attempt(() => M.spyOn(namespace as { exported: () => string }, 'exported'))
  const after = (namespace as { exported: () => string }).exported
  return {
    result: result.threw === undefined ? 'spied' : result,
    isMock: M.isMockFunction(after),
    value: after(),
  }
})

c('an accessor property spied with no access type', () => {
  const target = accessors()
  return attempt(() => M.spyOn(target, 'value' as never))
})

c('a data property spied as a getter', () => {
  const target = { plain: 'data' }
  return attempt(() => M.spyOn(target, 'plain', 'get' as never))
})
