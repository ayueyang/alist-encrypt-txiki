import Koa from 'koa'
import { httpClient, httpProxy } from '../../node-proxy/src/utils/httpClient'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function assert(name, condition, detail) {
  if (!condition) {
    throw new Error(`${name}: ${detail}`)
  }
  console.log(`HTTP_MATRIX_PASS ${name} ${detail}`)
}

function bytesToHex(bytes) {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function readSocket(reader, firstChunk = '') {
  let output = firstChunk
  while (true) {
    const result = await Promise.race([
      reader.read(),
      delay(1000).then(() => ({ done: true, timeout: true })),
    ])
    if (result.done || result.timeout) {
      return output
    }
    output += decoder.decode(result.value, { stream: true })
  }
}

async function expectRequest(port, body) {
  const connection = await tjs.connect('tcp', '127.0.0.1', port)
  const { readable, writable } = await connection.opened
  const reader = readable.getReader()
  const writer = writable.getWriter()
  const headers =
    'PUT /expect HTTP/1.1\r\n' +
    `Host: 127.0.0.1:${port}\r\n` +
    `Content-Length: ${encoder.encode(body).length}\r\n` +
    'Content-Type: text/plain\r\n' +
    'Expect: 100-continue\r\n' +
    'Connection: close\r\n' +
    '\r\n'

  await writer.write(encoder.encode(headers))
  const first = await Promise.race([
    reader.read(),
    delay(750).then(() => ({ done: false, timeout: true })),
  ])
  let firstText = ''
  let continued = false
  if (!first.timeout && !first.done) {
    firstText = decoder.decode(first.value, { stream: true })
    continued = firstText.includes(' 100 Continue')
  }

  await writer.write(encoder.encode(body))
  const output = await readSocket(reader, firstText)
  try {
    await writer.close()
  } catch {}
  try {
    connection.close()
  } catch {}
  return { continued, output }
}

const rangeData = encoder.encode('0123456789abcdefghijklmnopqrstuvwxyz')
const state = { slowCancelled: false }
const fixture = tjs.serve({
  port: 0,
  listenIp: '127.0.0.1',
  fetch: async (request) => {
    const url = new URL(request.url)
    if (url.pathname === '/echo' || url.pathname === '/expect') {
      const bytes = new Uint8Array(await request.arrayBuffer())
      if (url.pathname === '/expect') {
        state.expectReceived = bytes.byteLength
      }
      return Response.json({
        method: request.method,
        contentType: request.headers.get('content-type') || '',
        bodyText: decoder.decode(bytes),
        bodyHex: bytesToHex(bytes),
      })
    }
    if (url.pathname === '/redirect/one') {
      return new Response(null, { status: 302, headers: { location: '/redirect/two' } })
    }
    if (url.pathname === '/redirect/two') {
      return new Response(null, { status: 307, headers: { location: '/echo' } })
    }
    if (url.pathname === '/stream') {
      return new Response(new ReadableStream({
        async start(controller) {
          controller.enqueue(encoder.encode('first-'))
          await delay(25)
          controller.enqueue(encoder.encode('second-'))
          await delay(25)
          controller.enqueue(encoder.encode('third'))
          controller.close()
        },
      }), { headers: { 'content-type': 'text/plain', 'x-stream': 'yes' } })
    }
    if (url.pathname === '/range') {
      const range = request.headers.get('range')
      const start = range ? Number(range.replace('bytes=', '').split('-')[0]) : 0
      const body = rangeData.slice(start)
      return new Response(request.method === 'HEAD' ? null : body, {
        status: range ? 206 : 200,
        headers: {
          'accept-ranges': 'bytes',
          'content-length': String(body.length),
          'content-range': range ? `bytes ${start}-${rangeData.length - 1}/${rangeData.length}` : undefined,
        },
      })
    }
    if (url.pathname === '/download') {
      return new Response('download-body', {
        headers: { 'content-disposition': "attachment; filename*=UTF-8''matrix.txt" },
      })
    }
    if (url.pathname === '/head') {
      return new Response(null, { status: 204, headers: { 'x-head': 'yes' } })
    }
    if (url.pathname === '/slow') {
      return new Response(new ReadableStream({
        start(controller) {
          let index = 0
          this.timer = setInterval(() => {
            controller.enqueue(encoder.encode(`slow-${index++}\n`))
          }, 30)
        },
        cancel() {
          clearInterval(this.timer)
          state.slowCancelled = true
        },
      }))
    }
    return new Response('fixture-not-found', { status: 404 })
  },
})

const fixtureOrigin = `http://127.0.0.1:${fixture.port}`
const app = new Koa()
app.use(async (ctx) => {
  ctx.req.urlAddr = fixtureOrigin + ctx.req.url
  ctx.req.passwdInfo = { enable: false, encName: false }
  ctx.req.fileSize = 0
  await httpProxy(ctx.req, ctx.res)
})
const proxy = tjs.serve({ port: 0, listenIp: '127.0.0.1', fetch: app.callback() })
const proxyOrigin = `http://127.0.0.1:${proxy.port}`

try {
  const directResponse = { statusCode: 0, headers: new Headers(), setHeader(name, value) { this.headers.set(name, value) } }
  const directBody = await httpClient({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    urlAddr: fixtureOrigin + '/echo',
    reqBody: { direct: true },
    url: '/echo',
  }, directResponse)
  const direct = JSON.parse(directBody)
  assert('http-client-json', directResponse.statusCode === 200 && direct.bodyText === '{"direct":true}', `status=${directResponse.statusCode}`)

  const jsonResponse = await fetch(proxyOrigin + '/echo', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hello: 'world' }),
  })
  const json = await jsonResponse.json()
  assert('json', jsonResponse.status === 200 && json.bodyText === '{"hello":"world"}', `status=${jsonResponse.status}`)

  const formResponse = await fetch(proxyOrigin + '/echo', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'a=1&b=two',
  })
  const form = await formResponse.json()
  assert('form', form.bodyText === 'a=1&b=two', `content-type=${form.contentType}`)

  const binary = new Uint8Array([0, 1, 2, 127, 128, 254, 255])
  const binaryResponse = await fetch(proxyOrigin + '/echo', {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream' },
    body: binary,
  })
  const binaryResult = await binaryResponse.json()
  assert('binary', binaryResult.bodyHex === bytesToHex(binary), `hex=${binaryResult.bodyHex}`)

  const uploadStream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('stream-'))
      controller.enqueue(encoder.encode('upload'))
      controller.close()
    },
  })
  const uploadResponse = await fetch(proxyOrigin + '/echo', {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: uploadStream,
    duplex: 'half',
  })
  const upload = await uploadResponse.json()
  assert('stream-upload', upload.bodyText === 'stream-upload', `body=${upload.bodyText}`)

  const streamResponse = await fetch(proxyOrigin + '/stream')
  const streamReader = streamResponse.body.getReader()
  const streamChunks = []
  while (true) {
    const { done, value } = await streamReader.read()
    if (done) break
    streamChunks.push(decoder.decode(value, { stream: true }))
  }
  assert('stream-response', streamChunks.length >= 2 && streamChunks.join('') === 'first-second-third', `chunks=${streamChunks.length}`)

  const redirectResponse = await fetch(proxyOrigin + '/redirect/one', { redirect: 'manual' })
  assert('redirect-302', redirectResponse.status === 302 && redirectResponse.headers.get('location') === '/redirect/two', `status=${redirectResponse.status}`)
  const followedResponse = await fetch(proxyOrigin + '/redirect/one')
  const followed = await followedResponse.json()
  assert('redirect-multiple', followedResponse.status === 200 && followed.method === 'GET', `status=${followedResponse.status}`)

  const headResponse = await fetch(proxyOrigin + '/head', { method: 'HEAD' })
  assert('head', headResponse.status === 204 && headResponse.headers.get('x-head') === 'yes' && (await headResponse.text()) === '', `status=${headResponse.status}`)

  const rangeResponse = await fetch(proxyOrigin + '/range', { headers: { range: 'bytes=7-' } })
  const rangeBytes = new Uint8Array(await rangeResponse.arrayBuffer())
  assert('range', rangeResponse.status === 206 && rangeResponse.headers.get('content-range') === `bytes 7-${rangeData.length - 1}/${rangeData.length}` && bytesToHex(rangeBytes) === bytesToHex(rangeData.slice(7)), `status=${rangeResponse.status}`)

  const downloadResponse = await fetch(proxyOrigin + '/download')
  assert('content-disposition', downloadResponse.headers.get('content-disposition') === "attachment; filename*=UTF-8''matrix.txt", downloadResponse.headers.get('content-disposition'))
  await downloadResponse.text()

  const slowResponse = await fetch(proxyOrigin + '/slow')
  const slowReader = slowResponse.body.getReader()
  await slowReader.read()
  await slowReader.cancel('matrix-client-cancel')
  await delay(150)
  if (state.slowCancelled) {
    console.log('HTTP_MATRIX_PASS client-cancel upstream-cancelled=true')
  } else {
    console.log('HTTP_MATRIX_LIMITATION client-cancel upstream-cancelled=false')
  }

  const expect = await expectRequest(proxy.port, 'expect-body')
  console.log(`HTTP_MATRIX_LIMITATION expect-continue received=${expect.continued} upstream-bytes=${state.expectReceived} final-response=${expect.output.includes('HTTP/1.1 200')}`)
} finally {
  await proxy.close()
  await fixture.close()
}

tjs.exit(0)
