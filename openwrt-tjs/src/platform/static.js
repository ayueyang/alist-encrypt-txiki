import path from 'tjs:path'

const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
}

export default function staticServer(root) {
  const resolvedRoot = path.resolve(root)
  return async (ctx, next) => {
    let pathname = decodeURIComponent(new URL(ctx.req.url, 'http://localhost').pathname)
    if (pathname.endsWith('/')) {
      pathname += 'index.html'
    }
    const filePath = path.resolve(resolvedRoot, '.' + pathname)
    if (filePath !== resolvedRoot && !filePath.startsWith(resolvedRoot + path.sep)) {
      await next()
      return
    }
    try {
      const info = await tjs.stat(filePath)
      if (!info.isFile) {
        await next()
        return
      }
      ctx.res.setHeader('content-type', mimeTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream')
      ctx.body = await tjs.readFile(filePath)
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error
      }
      await next()
    }
  }
}
