let configured = {}

function configure(options) {
  configured = options || {}
}

function write(level, args) {
  const method = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
  method(`[alist-encrypt] [${level.toUpperCase()}]`, ...args)
}

function getLogger() {
  const debugEnabled = tjs.env.RUN_MODE === 'DEV'
  return {
    debug(...args) {
      if (debugEnabled) write('debug', args)
    },
    info(...args) {
      write('info', args)
    },
    warn(...args) {
      write('warn', args)
    },
    error(...args) {
      write('error', args)
    },
  }
}

export { configure, getLogger }
export default { configure, getLogger, configured }
