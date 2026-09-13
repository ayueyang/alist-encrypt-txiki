import { Hono } from 'hono'

class Agent {
  constructor(options = {}) {
    this.options = options
  }
}

class Server {
  constructor(handler) {
    this.handler = handler
    this.maxConnections = 0
    this._connections = 0
    this.events = new Map()
    this.server = null
  }

  on(event, handler) {
    this.events.set(event, handler)
    return this
  }

  listen(port, callback) {
    const app = new Hono()
    app.all('*', (ctx) => this.handler(ctx.req.raw))
    this.server = tjs.serve({ port, listenIp: '0.0.0.0', fetch: app.fetch })
    if (callback) {
      queueMicrotask(callback)
    }
    return this
  }

  async close() {
    if (this.server) {
      await this.server.close()
    }
  }
}

function createServer(handler) {
  return new Server(handler)
}

function request() {
  throw new Error('Node http.request is not available in the txiki.js build')
}

const http = { Agent, createServer, request }

export { Agent, createServer, request }
export default http
