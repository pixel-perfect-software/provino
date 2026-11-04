// A worker entry that throws as it loads, before it can say `ready`.
throw new Error('boom from the entry module')
