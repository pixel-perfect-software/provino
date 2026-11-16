// Each title is what the test's global holds, so the golden records it.
test(`typeof setImmediate is ${typeof setImmediate}`, () => {})
test(`typeof clearImmediate is ${typeof clearImmediate}`, () => {})
test(`typeof MessageChannel is ${typeof MessageChannel}`, () => {})
test(`typeof queueMicrotask is ${typeof queueMicrotask}`, () => {})
test(`setTimeout is the window's: ${setTimeout === window.setTimeout}`, () => {})
test(`setInterval is the window's: ${setInterval === window.setInterval}`, () => {})
test(`clearTimeout is the window's: ${clearTimeout === window.clearTimeout}`, () => {})
test(`setTimeout returns a ${typeof setTimeout(() => {}, 0)}`, () => {})
