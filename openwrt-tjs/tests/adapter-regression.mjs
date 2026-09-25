// Platform boundary regressions that can be checked without a running AList or guest.
// Run: node --test openwrt-tjs/tests/adapter-regression.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import Koa from '../src/platform/koa.js'
import { destinationAuthority } from '../src/platform/destination-authority.js'
import { fetchWithKnownLength } from '../src/platform/fixed-length-fetch.js'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

async function fakeSocketResponse(status, responseHeaders, responseBody, requestOptions) {
  const originalTjs = globalThis.tjs
  const writes = []
  globalThis.tjs = {
    connect: async () => ({
      opened: Promise.resolve({
        readable: new ReadableStream({
          start(controller) {
            const lines = [`HTTP/1.1 ${status} Test`, ...responseHeaders, '', '']
            controller.enqueue(encoder.encode(lines.join('\r\n') + responseBody))
            controller.close()
          },
        }),
        writable: new WritableStream({ write(chunk) { writes.push(decoder.decode(chunk)) } }),
      }),
      close() {},
    }),
  }
  try {
    const response = await fetchWithKnownLength('http://127.0.0.1:5244/dav/source', requestOptions)
    return { response, requestHead: writes[0] }
  } finally {
    if (originalTjs === undefined) delete globalThis.tjs
    else globalThis.tjs = originalTjs
  }
}

function bodyBytes(bytes = []) {
  return new ReadableStream({
    start(controller) {
      if (bytes.length) controller.enqueue(Uint8Array.from(bytes))
      controller.close()
    },
  })
}

test('Koa adapter suppresses bodies for statuses that cannot carry one', async () => {
  for (const status of [204, 205, 304]) {
    const app = new Koa()
    app.use(async (ctx) => {
      ctx.status = status
      ctx.body = ''
    })
    const response = await app.callback()(new Request('http://127.0.0.1/dav/test'))
    assert.equal(response.status, status)
    assert.equal(response.body, null)
  }
})

test('raw fixed-length HTTP adapter handles bodyless statuses, including 304 metadata length', async () => {
  for (const status of [204, 205, 304]) {
    const { response } = await fakeSocketResponse(status, [`Content-Length: ${status === 304 ? 12 : 0}`], '', {
      method: 'PUT',
      headers: { 'content-length': '0' },
      body: bodyBytes(),
    })
    assert.equal(response.status, status)
    assert.equal(response.body, null)
  }
  const { response } = await fakeSocketResponse(200, ['Content-Length: 2'], 'OK', {
    method: 'PUT',
    headers: { 'content-length': '0' },
    body: bodyBytes(),
  })
  assert.equal(await response.text(), 'OK')
})

test('raw COPY and MOVE have the same Host and Destination authority', async () => {
  const originalTjs = globalThis.tjs
  globalThis.tjs = {}
  const destination = `http://${destinationAuthority('127.0.0.1:5244')}/dav/target`
  if (originalTjs === undefined) delete globalThis.tjs
  else globalThis.tjs = originalTjs
  for (const method of ['COPY', 'MOVE']) {
    const { response, requestHead } = await fakeSocketResponse(201, ['Content-Length: 0'], '', {
      method,
      headers: { 'content-length': '1', destination },
      body: bodyBytes([65]),
    })
    assert.equal(response.status, 201)
    const host = requestHead.match(/^host: (.*)$/im)?.[1]
    const destinationHost = new URL(requestHead.match(/^destination: (.*)$/im)?.[1]).host
    assert.equal(destinationHost, host)
    assert.equal(host, '127.0.0.1:5244')
  }
})

test('PRGA worker failures fall back immediately instead of reusing a dead worker', async () => {
  const originalWorker = globalThis.Worker
  const instances = []
  globalThis.Worker = class {
    constructor() {
      this.dead = false
      instances.push(this)
    }
    postMessage() {
      if (this.dead) throw new Error('worker has exited')
    }
  }
  try {
    const { default: prga } = await import('../../node-proxy/src/utils/PRGAThread.js?worker-failure')
    assert.ok(instances.length > 0)
    instances[0].dead = true
    instances[0].onerror(new Error('simulated worker failure'))
    const sbox = Uint8Array.from({ length: 256 }, (_, index) => index)
    const result = await prga({ sbox, i: 0, j: 0, position: 1 })
    assert.equal(result.i, 1)
    assert.equal(result.j, 1)
    assert.deepEqual(Array.from(result.sbox), Array.from(sbox))
  } finally {
    if (originalWorker === undefined) delete globalThis.Worker
    else globalThis.Worker = originalWorker
  }
})

test('PRGA postMessage exceptions clear the timer and use the synchronous fallback', async () => {
  const originalWorker = globalThis.Worker
  globalThis.Worker = class {
    postMessage() {
      throw new Error('worker message failed')
    }
  }
  try {
    const { default: prga } = await import('../../node-proxy/src/utils/PRGAThread.js?post-failure')
    const sbox = Uint8Array.from({ length: 256 }, (_, index) => index)
    const result = await prga({ sbox, i: 0, j: 0, position: 1 })
    assert.equal(result.i, 1)
    assert.equal(result.j, 1)
  } finally {
    if (originalWorker === undefined) delete globalThis.Worker
    else globalThis.Worker = originalWorker
  }
})
