// Run only on patched txiki: local HTTP fixtures, no AList credentials or cloud writes.
// Bundle next to the candidate under an isolated guest share; do not replace r10.
import Koa from '../src/platform/koa.js'
import { fetchWithKnownLength } from '../src/platform/fixed-length-fetch.js'

const encoder = new TextEncoder()

function assert(name, condition, detail) {
  if (!condition) throw new Error(`${name}: ${detail}`)
  console.log(`TARGET_BOUNDARY_PASS ${name} ${detail}`)
}

function bodyStream(text) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text))
      controller.close()
    },
  })
}

const watchdog = setTimeout(() => {
  console.error('TARGET_BOUNDARY_FAIL watchdog exceeded 12 seconds')
  tjs.exit(2)
}, 12000)

for (const status of [204, 205, 304]) {
  const app = new Koa()
  app.use(async (ctx) => {
    ctx.status = status
    ctx.body = 'not transmitted'
  })
  const response = await app.callback()(new Request('http://127.0.0.1/local'))
  assert(`koa-${status}`, response.status === status && response.body === null, `status=${response.status} body=${response.body}`)
}

const origin = tjs.args.at(-1)
if (!/^http:\/\/10\.0\.2\.2:\d+$/.test(origin)) {
  throw new Error('Pass the local QEMU host fixture URL after the guest test filename')
}

try {
  for (const status of [204, 205, 304]) {
    console.log(`TARGET_BOUNDARY_STAGE start raw-${status}`)
    const response = await fetchWithKnownLength(`${origin}/status/${status}`, {
      method: 'PUT',
      headers: { 'content-length': '1' },
      body: bodyStream('x'),
    })
    const metadata = status !== 304 || response.headers.get('content-length') === '12'
    assert(`raw-${status}`, response.status === status && response.body === null && metadata, `status=${response.status} body=${response.body} length=${response.headers.get('content-length')}`)
  }

  for (const method of ['COPY', 'MOVE']) {
    const payload = `body-${method}`
    const response = await fetchWithKnownLength(`${origin}/dav/source`, {
      method,
      headers: {
        'content-length': String(encoder.encode(payload).byteLength),
        destination: 'http://127.0.0.1/dav/target',
      },
      body: bodyStream(payload),
    })
    const actual = JSON.parse(await response.text())
    const destination = actual.destination && new URL(actual.destination)
    assert(`raw-${method.toLowerCase()}`, response.status === 201 &&
      actual.method === method && actual.body === payload &&
      actual.host === new URL(origin).host && destination?.host === actual.host &&
      destination.pathname === '/dav/target',
    `status=${response.status} host=${actual.host} destination=${destination?.host} bytes=${actual.body.length}`)
  }
} finally {
  clearTimeout(watchdog)
}

tjs.exit(0)
