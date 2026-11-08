// Counts how many times it is evaluated, in a global that outlives the module graph.
const store = globalThis as { moduleBetweenLoads?: number }
store.moduleBetweenLoads = (store.moduleBetweenLoads ?? 0) + 1
export const loads: number = store.moduleBetweenLoads
