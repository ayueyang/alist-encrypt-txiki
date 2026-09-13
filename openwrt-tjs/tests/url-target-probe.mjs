const encoder = new TextEncoder()
const decoder = new TextDecoder()

const server = tjs.serve({
  port: 0,
  listenIp: '127.0.0.1',
  fetch(request) {
    return Response.json({ url: request.url, method: request.method })
  },
})

const path = '/webdav 中文.txt'
const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
  method: 'PUT',
  body: encoder.encode('url target probe'),
})
const result = JSON.parse(decoder.decode(await response.arrayBuffer()))
console.log(JSON.stringify({ status: response.status, requestUrl: result.url, method: result.method }))
await server.close()
tjs.exit(0)
