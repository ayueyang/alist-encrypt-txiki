const sensitiveKey = /^(authorization|authorizetoken|cookie|jwtToken|newpassword|passwd|password|set-cookie|sign|token)$/i
const sensitiveLabel = /(configdata|encodefoldname|login|passwd|password|setvalue|you input)/i

function redactString(value) {
  return value
    .replace(
      /("(?:authorization|authorizetoken|cookie|jwtToken|newpassword|passwd|password|set-cookie|sign|token)"\s*:\s*")([^"]*)(")/gi,
      '$1[REDACTED]$3'
    )
    .replace(/((?:authorization|authorizetoken|cookie|jwtToken|newpassword|passwd|password|sign|token)=)[^&\s]*/gi, '$1[REDACTED]')
    .replace(/(authorization\s*:\s*)(?:basic|bearer)\s+[^,\s}]+/gi, '$1[REDACTED]')
}

function redactValue(value, seen = new WeakSet()) {
  if (typeof value === 'string') {
    return redactString(value)
  }
  if (value === null || typeof value !== 'object') {
    return value
  }
  if (value instanceof Error) {
    return redactString(value.stack || value.message)
  }
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
    return `[binary ${value.byteLength} bytes]`
  }
  if (typeof Headers !== 'undefined' && value instanceof Headers) {
    return redactValue(Object.fromEntries(value), seen)
  }
  if (seen.has(value)) {
    return '[Circular]'
  }
  seen.add(value)
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, seen))
  }
  const result = {}
  for (const [key, item] of Object.entries(value)) {
    result[key] = sensitiveKey.test(key) ? '[REDACTED]' : redactValue(item, seen)
  }
  return result
}

export function redactArgs(args) {
  const first = typeof args[0] === 'string' ? args[0] : ''
  const result = args.map((item) => redactValue(item))
  if (sensitiveLabel.test(first)) {
    for (let index = 1; index < result.length; index++) {
      if (typeof args[index] === 'string') {
        result[index] = '[REDACTED]'
      }
    }
  } else if (args.length === 2 && args.every((item) => typeof item === 'string') && !first.startsWith('@') && !first.startsWith('[') && !first.includes(':')) {
    result[0] = '[REDACTED]'
    result[1] = '[REDACTED]'
  }
  return result
}

export function installRedactedConsole() {
  const original = globalThis.console
  const wrapped = Object.create(original)
  for (const name of ['debug', 'error', 'info', 'log', 'warn']) {
    wrapped[name] = (...args) => original[name](...redactArgs(args))
  }
  globalThis.console = wrapped
}
