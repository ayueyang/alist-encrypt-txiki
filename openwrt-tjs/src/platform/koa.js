import compose from 'koa-compose'

function requestHeaders(headers) {
  const result = {}
  for (const [key, value] of headers) {
    const name = key.toLowerCase()
    if (name === 'content-length') {
      const values = String(value).split(',').map((item) => item.trim()).filter(Boolean)
      if (values.length > 1 && values.every((item) => item === values[0] && /^\d+$/.test(item))) {
        result[name] = values[0]
        continue
      }
    }
    result[name] = value
  }
  return result
}

class NodeRequest {
  constructor(raw) {
    const url = new URL(raw.url)
    this.raw = raw
    this.method = raw.method.toUpperCase()
    this.url = url.pathname + url.search
    this.headers = requestHeaders(raw.headers)
    this.body = raw.body
    this.signal = raw.signal || undefined
    this.bodyParsed = false
    this.parsedBody = undefined
  }
}

class NodeResponse {
  constructor(request) {
    this.statusCode = 404
    this.headers = new Headers()
    this.body = undefined
    this.closed = false
    this.closeHandlers = []
    request.signal?.addEventListener('abort', () => this.emitClose(), { once: true })
  }

  setHeader(name, value) {
    if (value === undefined || value === null) {
      return
    }
    this.headers.set(name, Array.isArray(value) ? value.join(', ') : String(value))
  }

  getHeader(name) {
    return this.headers.get(name)
  }

  writeHead(statusCode, headers = {}) {
    this.statusCode = statusCode
    for (const [name, value] of Object.entries(headers)) {
      this.setHeader(name, value)
    }
  }

  setBody(body) {
    this.body = body
  }

  end(body) {
    if (body !== undefined) {
      this.body = body
    }
    this.closed = true
  }

  destroy() {
    this.emitClose()
  }

  on(event, handler) {
    if (event === 'close') {
      this.closeHandlers.push(handler)
    }
    return this
  }

  emitClose() {
    if (this.closed) {
      return
    }
    this.closed = true
    // Client went away: cancel any streaming response body so the upstream
    // fetch and the decrypt pipeline stop feeding a dead socket instead of
    // leaving tjs.serve with a stream that never completes.
    if (this.body instanceof ReadableStream) {
      this.body.cancel().catch(() => {})
    }
    for (const handler of this.closeHandlers) {
      handler()
    }
  }
}

function createContext(raw) {
  const url = new URL(raw.url)
  const req = new NodeRequest(raw)
  const res = new NodeResponse(raw)
  const request = { headers: req.headers, body: undefined }
  const ctx = {
    req,
    res,
    request,
    params: {},
    query: Object.fromEntries(url.searchParams),
    method: req.method,
    protocol: url.protocol.slice(0, -1),
    headers: req.headers,
    respond: true,
    userInfo: undefined,
    throw(status, message) {
      const error = new Error(message)
      error.status = status
      throw error
    },
  }

  Object.defineProperty(ctx, 'status', {
    get() {
      return res.statusCode
    },
    set(value) {
      res.statusCode = value
    },
  })

  Object.defineProperty(ctx, 'body', {
    get() {
      return res.body
    },
    set(value) {
      res.body = value
      res.headers.delete('content-length')
      if (res.statusCode === 404) {
        res.statusCode = 200
      }
    },
  })

  return ctx
}

function responseBody(ctx) {
  let body = ctx.res.body
  const headers = ctx.res.headers
  if (body === undefined) {
    if (ctx.res.statusCode === 404) {
      body = 'Not Found'
      headers.set('content-type', 'text/plain; charset=utf-8')
    } else {
      body = null
    }
  } else if (
    typeof body === 'object' &&
    body !== null &&
    !(body instanceof ArrayBuffer) &&
    !(body instanceof Uint8Array) &&
    !(body instanceof ReadableStream) &&
    !(body instanceof Blob)
  ) {
    body = JSON.stringify(body)
    headers.set('content-type', 'application/json; charset=utf-8')
    headers.delete('content-length')
  }
  if (ctx.method === 'HEAD') {
    body = null
  }
  return body
}

class Koa {
  constructor() {
    this.middleware = []
  }

  use(middleware) {
    this.middleware.push(middleware)
    return this
  }

  callback() {
    const handler = compose(this.middleware)
    return async (request) => {
      const ctx = createContext(request)
      await handler(ctx)
      return new Response(responseBody(ctx), {
        status: ctx.res.statusCode,
        headers: ctx.res.headers,
      })
    }
  }
}

export default Koa
