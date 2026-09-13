const encoder = new TextEncoder()
const decoder = new TextDecoder()
const methods = ['PROPFIND', 'MKCOL', 'COPY', 'MOVE', 'PUT', 'GET', 'HEAD', 'DELETE']

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const server = tjs.serve({
  port: 0,
  listenIp: '127.0.0.1',
  fetch(request) {
    return Response.json({ method: request.method })
  },
})

async function rawRequest(method) {
  const connection = await tjs.connect('tcp', '127.0.0.1', server.port)
  const { readable, writable } = await connection.opened
  const reader = readable.getReader()
  const writer = writable.getWriter()
  const request = [
    `${method} /method-probe HTTP/1.1`,
    `Host: 127.0.0.1:${server.port}`,
    'Content-Length: 0',
    'Connection: close',
    '',
    '',
  ].join('\r\n')

  await writer.write(encoder.encode(request))

  let response = ''
  let timedOut = false
  while (true) {
    const result = await Promise.race([
      reader.read(),
      delay(1500).then(() => ({ done: true, timeout: true })),
    ])
    if (result.timeout) {
      timedOut = true
      break
    }
    if (result.done) break
    response += decoder.decode(result.value, { stream: true })
  }

  try {
    await writer.close()
  } catch {}
  connection.close()

  const separator = response.indexOf('\r\n\r\n')
  const statusLine = response.split('\r\n', 1)[0] || ''
  const body = separator === -1 ? '' : response.slice(separator + 4)
  let reportedMethod = null
  try {
    reportedMethod = JSON.parse(body).method
  } catch {}

  return { sentMethod: method, statusLine, reportedMethod, timedOut }
}

try {
  const results = []
  for (const method of methods) {
    results.push(await rawRequest(method))
  }
  console.log(JSON.stringify({ ok: true, results }))
} finally {
  await server.close()
}

tjs.exit(0)
