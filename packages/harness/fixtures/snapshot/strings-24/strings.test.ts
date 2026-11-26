// 24 strings, one snapshot each: quotes, backslashes, backticks, a dollar-brace, line breaks
// (LF, CRLF, a lone CR), control characters, Unicode and long lines.
describe('strings', () => {
  test('plain', () => {
    expect('plain').toMatchSnapshot()
  })

  test('empty', () => {
    expect('').toMatchSnapshot()
  })

  test('a space', () => {
    expect(' ').toMatchSnapshot()
  })

  test('leading and trailing spaces', () => {
    expect('  padded  ').toMatchSnapshot()
  })

  test('double quotes', () => {
    expect('say "hi"').toMatchSnapshot()
  })

  test('single quotes', () => {
    expect("it's").toMatchSnapshot()
  })

  test('a backslash', () => {
    expect('back\\slash').toMatchSnapshot()
  })

  test('a backtick', () => {
    expect('back`tick').toMatchSnapshot()
  })

  test('a dollar-brace', () => {
    expect('cost $' + '{price}').toMatchSnapshot()
  })

  test("a template literal's text", () => {
    expect('`$' + '{a}` and \\`').toMatchSnapshot()
  })

  test('two lines', () => {
    expect('line one\nline two').toMatchSnapshot()
  })

  test('a trailing line break', () => {
    expect('ends with a break\n').toMatchSnapshot()
  })

  test('only a line break', () => {
    expect('\n').toMatchSnapshot()
  })

  test('CRLF', () => {
    expect('one\r\ntwo').toMatchSnapshot()
  })

  test('a lone carriage return', () => {
    expect('a\rb').toMatchSnapshot()
  })

  test('a tab', () => {
    expect('tab\there').toMatchSnapshot()
  })

  test('a NUL', () => {
    expect('nul\u0000byte').toMatchSnapshot()
  })

  test('accents and CJK', () => {
    expect('é 日本語').toMatchSnapshot()
  })

  test('an emoji', () => {
    expect('smile \u{1F600}').toMatchSnapshot()
  })

  test('a zero-width joiner', () => {
    expect('a\u200Db').toMatchSnapshot()
  })

  test('markup', () => {
    expect('<div class="x">&amp;</div>').toMatchSnapshot()
  })

  test('a comment closer', () => {
    expect('/* not */ a comment').toMatchSnapshot()
  })

  test('JSON text', () => {
    expect(JSON.stringify({ a: [1, 'two'], b: null })).toMatchSnapshot()
  })

  test('a long line', () => {
    expect('word '.repeat(40)).toMatchSnapshot()
  })
})
