module.exports = async function rootSetup(globalConfig, projectConfig) {
  require('node:fs').appendFileSync(
    'order.txt',
    `setup root (projectConfig ${projectConfig.displayName.name})\n`,
  )
}
