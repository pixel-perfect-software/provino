describe('values', () => {
  test('strings', () => {
    expect('plain').toMatchSnapshot()
    expect('a "quoted" \\ back`tick $' + '{dollar}').toMatchSnapshot()
    expect('line one\nline two\r\nline three').toMatchSnapshot()
    expect('tab\there').toMatchSnapshot()
    expect('é 日本 \u{1F600}').toMatchSnapshot()
    expect('').toMatchSnapshot()
  })

  test('numbers', () => {
    expect(0).toMatchSnapshot()
    expect(-0).toMatchSnapshot()
    expect(1.5).toMatchSnapshot()
    expect(Number.NaN).toMatchSnapshot()
    expect(Number.POSITIVE_INFINITY).toMatchSnapshot()
    expect(10n).toMatchSnapshot()
  })

  test('literals', () => {
    expect(null).toMatchSnapshot()
    expect(undefined).toMatchSnapshot()
    expect(true).toMatchSnapshot()
    expect(false).toMatchSnapshot()
  })

  test('symbols and functions', () => {
    expect(Symbol('described')).toMatchSnapshot()
    expect(function named() {}).toMatchSnapshot()
    expect(() => {}).toMatchSnapshot()
    expect(class Widget {}).toMatchSnapshot()
  })

  test('dates, regular expressions and errors', () => {
    expect(new Date(0)).toMatchSnapshot()
    expect(new Date(Number.NaN)).toMatchSnapshot()
    expect(/a\/b+[c]$/gi).toMatchSnapshot()
    expect(new Error('plain')).toMatchSnapshot()
    expect(new TypeError('typed')).toMatchSnapshot()
  })
})
