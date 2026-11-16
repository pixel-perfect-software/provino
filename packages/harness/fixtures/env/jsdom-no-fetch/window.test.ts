// Each title is what the test's global holds, so the golden records it.
import { loadsOverNetwork } from 'icon-loader'

test(`window: typeof fetch is ${typeof fetch}`, () => {})
test(`window: typeof Request is ${typeof Request}`, () => {})
test(`window: typeof Response is ${typeof Response}`, () => {})
test(`window: typeof Headers is ${typeof Headers}`, () => {})
test(`window: a package that looks for fetch as it loads finds it: ${loadsOverNetwork}`, () => {})
