const encoder = new TextEncoder()
const decoder = new TextDecoder()
const port = 5451
const seen = []

const server = tjs.serve({
  port,
  listenIp: '127.0.0.1',
  async fetch(request) {
    const body = new Uint8Array(await request.arrayBuffer())
    const headers = Object.fromEntries(request.headers)
    const result = {
      method: request.method,
      headers,
      contentLength: request.headers.get('content-length'),
      transferEncoding: request.headers.get('transfer-encoding'),
      bodyLength: body.byteLength,
    }
    seen.push(result)
    return Response.json(result)
  },
})

async function rawRequest(path, body) {
  const connection = await tjs.connect('tcp', '127.0.0.1', port)
  const { readable, writable } = await connection.opened
  const reader = readable.getReader()
  const writer = writable.getWriter()
  const head = [
    `PUT ${path} HTTP/1.1`,
    `Host: 127.0.0.1:${port}`,
    'Content-Type: application/octet-stream',
    `Content-Length: ${body.byteLength}`,
    'Connection: close',
    '',
    '',
  ].join('\r\n')
  await writer.write(encoder.encode(head))
  await writer.write(body)

  let response = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    response += decoder.decode(value, { stream: true })
  }
  try {
    await writer.close()
  } catch {}
  connection.close()
  const payload = response.slice(response.indexOf('\r\n\r\n') + 4)
  return JSON.parse(payload)
}

const payload = encoder.encode('header-probe-payload')
const fetchResponse = await fetch(`http://127.0.0.1:${port}/fetch`, {
  method: 'PUT',
  headers: {
    'content-type': 'application/octet-stream',
    'content-length': String(payload.byteLength),
  },
  body: payload,
})
const fetchResult = await fetchResponse.json()
const rawResult = await rawRequest('/raw', payload)

await server.close()
console.log(JSON.stringify({ ok: true, fetchResult, rawResult, seen }))
tjs.exit(0)
