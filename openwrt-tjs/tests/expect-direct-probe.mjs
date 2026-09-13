const encoder = new TextEncoder()
const decoder = new TextDecoder()

const server = tjs.serve({
  port: 0,
  listenIp: '127.0.0.1',
  fetch: async (request) => new Response(`received:${await request.text()}`),
})

const connection = await tjs.connect('tcp', '127.0.0.1', server.port)
const { readable, writable } = await connection.opened
const reader = readable.getReader()
const writer = writable.getWriter()
const body = 'expect-body'
const head =
  'POST / HTTP/1.1\r\n' +
  `Host: 127.0.0.1:${server.port}\r\n` +
  `Content-Length: ${body.length}\r\n` +
  'Content-Type: text/plain\r\n' +
  'Expect: 100-continue\r\n' +
  'Connection: close\r\n' +
  '\r\n'

await writer.write(encoder.encode(head))
const first = await Promise.race([
  reader.read(),
  new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 750)),
])
let output = first.timeout ? '' : decoder.decode(first.value, { stream: true })
await writer.write(encoder.encode(body))

while (true) {
  const next = await Promise.race([
    reader.read(),
    new Promise((resolve) => setTimeout(() => resolve({ done: true, timeout: true }), 1500)),
  ])
  if (next.done || next.timeout) break
  output += decoder.decode(next.value, { stream: true })
}

console.log(JSON.stringify({ received100: output.includes('100 Continue'), output }))
try {
  await writer.close()
} catch {}
try {
  connection.close()
} catch {}
await server.close()
tjs.exit(0)
