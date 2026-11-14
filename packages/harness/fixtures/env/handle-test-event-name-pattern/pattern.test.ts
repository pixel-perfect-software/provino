declare const __log: (marker: string) => void

describe('outer', () => {
  test('keep a/b', () => __log('body keep'))
  test('drop', () => __log('body drop'))
})
