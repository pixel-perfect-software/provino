// One test per way a test function can use its first argument as `done`.
test('done called synchronously', (done) => {
  trace('body: done called synchronously')
  done()
})

test('done called later', (done) => {
  setTimeout(() => {
    trace('timer: done called later')
    try {
      done()
    } catch (error) {
      trace(`timer: done threw: ${error.message}`)
    }
  }, 30)
})

test('done with an Error', (done) => {
  done(new Error('failed through done'))
})

test('done with a string', (done) => {
  done('a string reason')
})

test('done with an object', (done) => {
  done({ code: 7 })
})

test('done called twice in a row', (done) => {
  done()
  try {
    done()
    trace('second call returned')
  } catch (error) {
    trace(`second call threw: ${error.message}`)
  }
})

test('done called twice, the second call later', (done) => {
  done()
  setTimeout(() => {
    try {
      done()
      trace('late second call returned')
    } catch (error) {
      trace(`late second call threw: ${error.message}`)
    }
  }, 30)
})

test('done and a returned promise', (done) => {
  done()
  return Promise.resolve()
})

test('done and a returned value', (done) => {
  done()
  return 1
})

test('done never called', (_done) => {
  trace('body: done never called')
}, 100)

test('a throw in a test that declares done', (_done) => {
  throw new Error('thrown before done')
})

test('an async function that declares done', async (done) => {
  trace('body: async with done')
  done()
})

test('a default parameter is not done', (a = 1) => {
  trace(`body: default parameter, a is ${typeof a}`)
})

test('a rest parameter is not done', (...args) => {
  trace(`body: rest parameter, ${args.length} arguments`)
})

test('a function declaring two parameters', (first, second) => {
  trace(`body: two parameters, ${typeof first} ${typeof second}`)
  if (typeof first === 'function') first()
})

test('a generator that declares a parameter', function* (_done) {
  trace('body: generator with a parameter')
  yield Promise.resolve()
}, 100)

test('a generator with no parameter', function* () {
  trace('body: generator, no parameter')
  yield Promise.resolve()
})

// Last, and long enough for every timer above to have fired, so none outlives the file.
test('lets the timers above fire', () => new Promise((resolve) => setTimeout(resolve, 150)))
