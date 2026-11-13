// A setup file runs once for every test file. This one cleans up after the run, as a project's
// setup that made a temporary home directory would.
const fs = process.getBuiltinModule('node:fs')

process.on('exit', () => {
  fs.appendFileSync(`${__dirname}/exit-from-setup.txt`, 'an exit listener of the setup file ran\n')
})
