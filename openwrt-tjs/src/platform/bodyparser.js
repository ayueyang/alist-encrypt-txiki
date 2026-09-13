function parseForm(text) {
  const body = {}
  for (const [key, value] of new URLSearchParams(text)) {
    if (body[key] === undefined) {
      body[key] = value
    } else if (Array.isArray(body[key])) {
      body[key].push(value)
    } else {
      body[key] = [body[key], value]
    }
  }
  return body
}

export default function bodyparser(options = {}) {
  const enableTypes = options.enableTypes || ['json', 'form', 'text']

  return async (ctx, next) => {
    if (ctx.req.bodyParsed) {
      ctx.request.body = ctx.req.parsedBody
      await next()
      return
    }

    const contentType = (ctx.request.headers['content-type'] || '').toLowerCase()
    const type = contentType.includes('application/json')
      ? 'json'
      : contentType.includes('application/x-www-form-urlencoded')
        ? 'form'
        : contentType.startsWith('text/')
          ? 'text'
          : null

    let body
    if (type && enableTypes.includes(type)) {
      const text = ctx.req.raw.body ? await ctx.req.raw.text() : ''
      body = text
      if (type === 'json') {
        body = text ? JSON.parse(text) : {}
      } else if (type === 'form') {
        body = parseForm(text)
      }
    }

    ctx.req.bodyParsed = true
    ctx.req.parsedBody = body
    ctx.request.body = body
    await next()
  }
}
