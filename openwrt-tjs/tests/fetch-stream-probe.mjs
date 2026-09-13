const encoder = new TextEncoder()

function streamBody(text) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text))
      controller.close()
    },
  })
}

async function run(name, options) {
  try {
    const response = await fetch(origin, options)
    console.log(`FETCH_PROBE ${name} status=${response.status} body=${await response.text()}`)
  } catch (error) {
    console.log(`FETCH_PROBE ${name} error=${error?.name}:${error?.message}`)
  }
}

const server = tjs.serve({
  port: 0,
  listenIp: '127.0.0.1',
  fetch: async (request) => new Response(await request.text()),
})
const origin = `http://127.0.0.1:${server.port}/`

await run('uint8-content-length', {
  method: 'POST',
  headers: { 'content-length': '5' },
  body: encoder.encode('hello'),
})
await run('stream-no-length', {
  method: 'POST',
  body: streamBody('hello'),
  duplex: 'half',
})
await run('stream-content-length', {
  method: 'POST',
  headers: { 'content-length': '5' },
  body: streamBody('hello'),
  duplex: 'half',
})
await run('stream-browser-headers', {
  method: 'POST',
  headers: {
    'accept-encoding': 'gzip, deflate',
    'cache-control': 'no-cache',
    'content-length': '5',
    'content-type': 'text/plain',
    origin: 'http://127.0.0.1',
    pragma: 'no-cache',
    'user-agent': 'txiki.js/26.6.0',
  },
  body: streamBody('hello'),
  duplex: 'half',
})

await server.close()
tjs.exit(0)
