// The root config's hook: Jest calls it with the global config and the project config of the first
// test it finds that names this path, or else of the first test of the run.
module.exports = async function rootSetup(globalConfig, projectConfig) {
  require('node:fs').appendFileSync(
    'order.txt',
    `setup root (projectConfig ${projectConfig.displayName.name})\n`,
  )
}
