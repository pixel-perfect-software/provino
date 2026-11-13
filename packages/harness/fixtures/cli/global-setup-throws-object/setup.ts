module.exports = async function globalSetup(): Promise<void> {
  throw { code: 42, detail: { list: ['a', 'b'], deeper: { deepest: { gone: true } } } }
}
