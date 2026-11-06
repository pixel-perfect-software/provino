// A mock function called with new: arrow, function and class implementations, return values,
// prototype methods, instanceof and instances.
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

c('new on a mock of an arrow function', () => {
  const f = M.fn(() => ({ made: 1 }))
  return attempt(() => new f())
})

c('new on a mock of a function sets fields on the new instance', () => {
  const f = M.fn(function (this: { field?: number }, n: number) {
    this.field = n
  })
  const result = attempt(() => new f(5))
  return { result, instances: f.mock.instances, results: f.mock.results }
})

c('new on a mock of a class', () => {
  class Klass {
    value = 'from class'
  }
  const f = M.fn(Klass)
  const result = attempt(() => new f())
  return { result, calls: f.mock.calls.length }
})

c('mockReturnValue under new', () => {
  const f = M.fn()
  f.mockReturnValue({ fixed: true })
  return attempt(() => new f())
})

c('methods on the prototype of a function implementation reach the instance', () => {
  function Impl(this: { x?: number }) {
    this.x = 1
  }
  // biome-ignore lint/complexity/useArrowFunction: a prototype method, which an arrow does not have
  Impl.prototype.hello = function () {
    return 'hello'
  }
  const f = M.fn(Impl)
  const instance = new f()
  return { hello: typeof instance.hello, x: instance.x }
})

c('instanceof the mock, and the prototype chain of an instance', () => {
  const f = M.fn()
  const instance = new f()
  return {
    instanceOfMock: instance instanceof f,
    constructorIsMock: instance.constructor === f,
  }
})

c('instances and contexts hold the object created by new', () => {
  const f = M.fn()
  const instance = new f()
  return {
    instancesHoldIt: f.mock.instances[0] === instance,
    contextsHoldIt: f.mock.contexts[0] === instance,
    length: f.mock.instances.length,
  }
})

c('new on a mock whose implementation returns an object', () => {
  const returned = { custom: true }
  // biome-ignore lint/complexity/useArrowFunction: an arrow cannot be called with new, which is the point
  const f = M.fn(function () {
    return returned
  })
  const instance = new f()
  return { isReturned: instance === returned, instances: f.mock.instances.length }
})

c('a once value under new', () => {
  const f = M.fn()
  f.mockReturnValueOnce({ once: true })
  return { first: attempt(() => new f()), second: attempt(() => typeof new f()) }
})
