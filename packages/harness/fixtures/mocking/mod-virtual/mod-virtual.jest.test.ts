jest.mock('./not-on-disk.ts', () => ({ who: 'virtual-relative' }), { virtual: true })
jest.mock('not-installed-anywhere', () => ({ who: 'virtual-bare' }), { virtual: true })

const c = (id: string, run: () => unknown) => {
  test(id, () => observe(id, run))
}

c('a virtual module at a relative path that is not on disk, loaded lazily', () => {
  const loaded = require('./not-on-disk.ts') as { who: string }
  return { who: loaded.who }
})

c('a virtual module with a bare name, loaded lazily', () => {
  const loaded = require('not-installed-anywhere') as { who: string }
  return { who: loaded.who }
})
