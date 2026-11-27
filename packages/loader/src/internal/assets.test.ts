import { describe, expect, it } from 'provino'
import { assetKindOf, assetQueryOf, assetRunnerSource, assetUrl } from './assets.ts'

describe('assetKindOf', () => {
  it("knows Vite's asset extensions, whatever the case", () => {
    for (const name of ['a.svg', 'a.PNG', 'a.jpeg', 'a.woff2', 'a.webmanifest', 'a.pdf', 'a.txt']) {
      expect(assetKindOf(`/p/${name}`)).toBe('asset')
    }
  })

  it('knows the style files and CSS modules', () => {
    for (const name of ['a.css', 'a.scss', 'a.sass', 'a.less', 'a.styl', 'a.pcss', 'a.sss']) {
      expect(assetKindOf(`/p/${name}`)).toBe('style')
    }
    expect(assetKindOf('/p/a.module.css')).toBe('style-module')
    expect(assetKindOf('/p/a.module.scss')).toBe('style-module')
  })

  it('leaves every other file alone', () => {
    for (const name of ['a.ts', 'a.json', 'a.svgz', 'svg', 'a.css.map']) {
      expect(assetKindOf(`/p/${name}`)).toBe(null)
    }
  })
})

describe('assetUrl', () => {
  it('is the path from the root inside it and /@fs outside it', () => {
    expect(assetUrl('/p', '/p/logo.svg')).toBe('/logo.svg')
    expect(assetUrl('/p', '/p/src/a/b.png')).toBe('/src/a/b.png')
    expect(assetUrl('/p', '/q/x.png')).toBe('/@fs/q/x.png')
    expect(assetUrl('/p', '/p-other/x.png')).toBe('/@fs/p-other/x.png')
  })

  it('keeps a directory whose name starts with two dots inside the root', () => {
    expect(assetUrl('/p', '/p/..hidden/x.png')).toBe('/..hidden/x.png')
    expect(assetUrl('/p/a', '/p/x.png')).toBe('/@fs/p/x.png')
  })

  it('writes the path as it is, with no percent-encoding', () => {
    expect(assetUrl('/p', '/p/my logo#1.svg')).toBe('/my logo#1.svg')
  })
})

describe('assetQueryOf', () => {
  it('reads ?raw and ?url as Vite does, and nothing else', () => {
    expect(assetQueryOf('')).toBe(null)
    expect(assetQueryOf('?raw')).toBe('raw')
    expect(assetQueryOf('?v=1&raw')).toBe('raw')
    expect(assetQueryOf('?url&raw')).toBe('raw')
    expect(assetQueryOf('?url')).toBe('url')
    expect(assetQueryOf('?rawish')).toBe(null)
    expect(assetQueryOf('?v=2')).toBe(null)
    expect(assetQueryOf('#raw')).toBe(null)
    expect(assetQueryOf('?v=1#raw')).toBe(null)
  })
})

describe('assetRunnerSource', () => {
  /** The default export of a module in runner form, evaluated. */
  function defaultOf(source: string): unknown {
    const exports: Record<string, unknown> = {}
    new Function('__vite_ssr_exports__', source)(exports)
    return exports.default
  }

  it('exports the URL, an empty string, or a name-for-name proxy', () => {
    expect(defaultOf(assetRunnerSource('asset', '/p', '/p/logo.svg'))).toBe('/logo.svg')
    expect(defaultOf(assetRunnerSource('style', '/p', '/p/a.css'))).toBe('')
    const styles = defaultOf(assetRunnerSource('style-module', '/p', '/p/a.module.css')) as Record<
      string | symbol,
      unknown
    >
    expect(styles.foo).toBe('foo')
    expect(styles.then).toBe(undefined)
    expect(styles.__esModule).toBe(undefined)
    expect(styles[Symbol.iterator]).toBe(undefined)
  })

  it('exports the text under raw and the URL under url, whatever the kind', () => {
    expect(defaultOf(assetRunnerSource('style', '/p', '/p/a.css', 'raw', 'a { b: c }\n'))).toBe(
      'a { b: c }\n',
    )
    expect(defaultOf(assetRunnerSource('style-module', '/p', '/p/a.module.css', 'url'))).toBe(
      '/a.module.css',
    )
  })
})
