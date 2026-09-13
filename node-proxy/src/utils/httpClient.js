import crypto, { randomUUID } from 'crypto'
import levelDB from './levelDB'
import path from 'path'
import { decodeName } from './commonUtil'
import { logger } from '@/common/logger'
import { fetchWithKnownLength } from 'alist-encrypt:fixed-length-fetch'

const hopByHopHeaders = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'expect'])

function createHeaders(headers, streaming) {
  const result = new Headers()
  for (const key in headers) {
    const name = key.toLowerCase()
    // txiki.js adds Origin to cross-origin fetches; it is a client-only header for CDN downloads.
    if (name === 'host' || name === 'origin' || hopByHopHeaders.has(name) || (streaming && name === 'content-length')) {
      continue
    }
    const value = headers[key]
    if (value !== undefined && value !== null) {
      result.set(name, Array.isArray(value) ? value.join(', ') : String(value))
    }
  }
  return result
}

function requestBody(request, transform) {
  const { method, reqBody } = request
  if (method === 'GET' || method === 'HEAD') {
    return null
  }
  if (reqBody !== undefined && reqBody !== null) {
    return typeof reqBody === 'string' ? reqBody : JSON.stringify(reqBody)
  }
  const body = request.body
  if (!body) {
    return null
  }
  return transform ? body.pipeThrough(transform.stream) : body
}

function setResponseHeaders(response, headers) {
  for (const [key, value] of headers) {
    if (hopByHopHeaders.has(key.toLowerCase())) {
      continue
    }
    response.setHeader(key, value)
  }
}

async function fetchRequest(request, transform) {
  const { method, headers, urlAddr } = request
  const body = requestBody(request, transform)
  const streaming = body instanceof ReadableStream
  const fixedLength = streaming && /^\d+$/.test(String(headers['content-length'] || ''))
  const options = {
    method,
    headers: createHeaders(headers, streaming && !fixedLength),
    redirect: 'manual',
  }
  if (request.signal) {
    options.signal = request.signal
  }
  if (body !== null) {
    options.body = body
    if (streaming) {
      options.duplex = 'half'
    }
  }
  if (fixedLength) {
    return await fetchWithKnownLength(urlAddr, options)
  }
  return await fetch(urlAddr, options)
}

export async function httpProxy(request, response, encryptTransform, decryptTransform) {
  const { method, headers, urlAddr, passwdInfo, url, fileSize } = request
  const reqId = randomUUID().substring(30)
  logger.debug('@@request_proxy: ', reqId, method, urlAddr, headers, !!encryptTransform, !!decryptTransform)

  try {
    const httpResp = await fetchRequest(request, encryptTransform)
    logger.debug('@@statusCode', reqId, httpResp.status, httpResp.headers)
    response.statusCode = httpResp.status
    setResponseHeaders(response, httpResp.headers)
    if (response.statusCode % 300 < 5) {
      // 可能出现304，redirectUrl = undefined
      const redirectUrl = httpResp.headers.get('location') || '-'
      // 百度云盘不是https，坑爹，因为天翼云会多次302，所以这里要保持，跳转后的路径保持跟上次一致，经过本服务器代理就可以解密
      if (decryptTransform && passwdInfo.enable) {
        const key = crypto.randomUUID()
        await levelDB.setExpire(key, { redirectUrl, passwdInfo, fileSize }, 60 * 60 * 72) // 缓存起来，默认3天，足够下载和观看了
        response.setHeader('location', `/redirect/${key}?decode=1&lastUrl=${encodeURIComponent(url)}`)
      }
      logger.info('302 redirectUrl:', redirectUrl)
    } else if (httpResp.headers.get('content-range') && httpResp.status === 200) {
      response.statusCode = 206
    }

    // 下载时解密文件名
    if (method === 'GET' && response.statusCode === 200 && passwdInfo && passwdInfo.encName) {
      let fileName = decodeURIComponent(path.basename(url))
      fileName = decodeName(passwdInfo.password, passwdInfo.encType, fileName.replace(path.extname(fileName), ''))
      if (fileName) {
        let cd = response.getHeader('content-disposition')
        cd = cd ? cd.replace(/filename\*?=[^=;]*;?/g, '') : ''
        logger.info('@@proxy解密文件名', reqId, fileName)
        response.setHeader('content-disposition', cd + `filename*=UTF-8''${encodeURIComponent(fileName)};`)
      }
    }

    let body = method === 'HEAD' ? null : httpResp.body
    if (body && decryptTransform) {
      body = body.pipeThrough(decryptTransform.stream)
    }
    response.setBody(body)
    // If the client already disconnected while the upstream response was
    // being prepared, cancel the source stream immediately so the
    // fetch/socket pair does not keep streaming into a dead response.
    if (body instanceof ReadableStream && response.closed) {
      // 上游 Node 版在 httpResp 'close' 上记录同一事件并销毁解密流；Fetch 模型下
      // 对应时机是「本地响应已关闭、即将取消源流」，日志调用点与级别保持一致。
      logger.info('@远程响应关闭...', method, reqId, urlAddr)
      body.cancel().catch(() => {})
    }
  } catch (err) {
    logger.error('@@httpProxy request error ', reqId, err)
    throw err
  }
}

export async function httpClient(request, response) {
  // urlAddr 包含http
  const { method, headers, urlAddr, reqBody, url } = request
  // 请求reqBody已被篡改，由调用者调整length或删除，不然影响webdav
  // delete headers['content-length']
  logger.debug('@@request_client: ', method, urlAddr, headers, reqBody)
  try {
    const httpResp = await fetchRequest(request)
    logger.debug('@@statusCode', httpResp.status, httpResp.headers)
    if (response) {
      // 外部的ctx.body=OK会导致statusCode=200，外部方法要执行ctx.status = ctx.res.statusCode
      response.statusCode = httpResp.status
      setResponseHeaders(response, httpResp.headers)
      // 不能用 response.writeHead(statusCode, res.header)
      // 会导致直接响应了Content-length: 123, 外部修改的body长度变化后就没法使用，而且外部需要要用ctx.body
      // 因为ctx.body 会重新计算响应的Content-length
    }
    const result = await httpResp.text()
    logger.info('httpClient响应结束.', method, result.length, url)
    return result
  } catch (err) {
    logger.error('@@httpClient request error ', err)
    throw err
  }
}
