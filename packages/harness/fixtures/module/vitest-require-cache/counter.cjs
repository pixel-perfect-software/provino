// Counts its evaluations on the global.
globalThis.__counterLoads = (globalThis.__counterLoads ?? 0) + 1
module.exports = { loads: globalThis.__counterLoads }
