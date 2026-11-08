// Counts how many times it is evaluated, in a global that outlives the module registry.
const store = globalThis as { moduleBetweenLoads?: number }
store.moduleBetweenLoads = (store.moduleBetweenLoads ?? 0) + 1
module.exports = { loads: store.moduleBetweenLoads }
