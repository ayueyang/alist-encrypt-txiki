import compose from 'koa-compose'
import { pathToRegexp } from 'path-to-regexp'

function compilePath(routePath) {
  if (routePath instanceof RegExp) {
    return { expression: routePath, keys: [] }
  }
  const keys = []
  return { expression: pathToRegexp(routePath, keys), keys }
}

function matchLayer(layer, pathname) {
  layer.expression.lastIndex = 0
  const match = layer.expression.exec(pathname)
  if (!match) {
    return null
  }
  const params = {}
  layer.keys.forEach((key, index) => {
    params[key.name] = match[index + 1] === undefined ? undefined : decodeURIComponent(match[index + 1])
  })
  return params
}

class Router {
  constructor(options = {}) {
    this.prefix = options.prefix || ''
    this.layers = []
  }

  register(methods, routePath, middleware) {
    const fullPath = typeof routePath === 'string' ? this.prefix + routePath : routePath
    const { expression, keys } = compilePath(fullPath)
    this.layers.push({ methods, expression, keys, middleware })
    return this
  }

  all(routePath, ...middleware) {
    return this.register(null, routePath, middleware)
  }

  get(routePath, ...middleware) {
    return this.register(['GET', 'HEAD'], routePath, middleware)
  }

  put(routePath, ...middleware) {
    return this.register(['PUT'], routePath, middleware)
  }

  use(...middleware) {
    return this.register(null, /.*/, middleware)
  }

  redirect(source, destination, status = 302) {
    return this.all(source, async (ctx) => {
      ctx.status = status
      ctx.res.setHeader('location', destination)
      ctx.body = ''
    })
  }

  routes() {
    return async (ctx, next) => {
      const pathname = new URL(ctx.req.url, 'http://localhost').pathname
      const layers = this.layers
      let index = -1

      const dispatch = async (position) => {
        if (position <= index) {
          throw new Error('next() called multiple times')
        }
        index = position
        for (let current = position; current < layers.length; current++) {
          const layer = layers[current]
          if (layer.methods && !layer.methods.includes(ctx.method)) {
            continue
          }
          const params = matchLayer(layer, pathname)
          if (params === null) {
            continue
          }
          const previousParams = ctx.params
          ctx.params = params
          await compose(layer.middleware)(ctx, () => dispatch(current + 1))
          ctx.params = previousParams
          return
        }
        await next()
      }

      await dispatch(0)
    }
  }

  allowedMethods() {
    return async (ctx, next) => await next()
  }
}

export default Router
