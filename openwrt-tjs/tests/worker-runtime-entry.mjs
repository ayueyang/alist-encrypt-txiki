// Copy next to the byte-identical adapted PRGAThread.js and a fixture named
// prga-worker.mjs inside an isolated path with spaces; no AList or cloud access.
const mode = tjs.args.at(-1)
if (mode !== 'sentinel' && mode !== 'failure') {
  throw new Error('Pass sentinel or failure after this entry path')
}

const originalLog = console.log
let creationErrors = 0
let workerErrors = 0
console.log = (...args) => {
  if (args[0] === '@@worker_create_error') creationErrors++
  if (args[0] === '@@worker_error') workerErrors++
  originalLog(...args)
}

const started = Date.now()
const limit = mode === 'failure' ? 36000 : 10000
const watchdog = setTimeout(() => {
  console.error(`WORKER_RUNTIME_FAIL watchdog exceeded ${limit}ms`)
  tjs.exit(2)
}, limit)

const { default: prga } = await import('./PRGAThread.js')
const sbox = Uint8Array.from({ length: 256 }, (_, index) => index)
const result = await prga({ sbox, i: 0, j: 0, position: 1 })
clearTimeout(watchdog)
const elapsed = Date.now() - started

if (creationErrors !== 0) throw new Error('Worker could not be created from this path')
if (mode === 'sentinel') {
  if (result.i !== 71 || result.j !== 72 || workerErrors !== 0) {
    throw new Error(`Worker message not received: i=${result.i} j=${result.j} errors=${workerErrors}`)
  }
} else if (result.i !== 1 || result.j !== 1 || (workerErrors === 0 && elapsed < 29000)) {
  throw new Error(`Worker failure did not use onerror or its 30s fallback: i=${result.i} j=${result.j} errors=${workerErrors} elapsed=${elapsed}`)
}
const via = mode === 'failure' ? (workerErrors ? 'onerror' : 'timer') : 'message'
console.log(`WORKER_RUNTIME_PASS ${mode} via=${via} creation-errors=${creationErrors} worker-errors=${workerErrors} elapsed-ms=${elapsed}`)
tjs.exit(0)
