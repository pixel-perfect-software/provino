export default ({ command, mode }) => ({ test: { name: `${command}:${mode}`, testTimeout: 55 } })
