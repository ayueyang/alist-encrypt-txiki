const encoder = new TextEncoder()
const decoder = new TextDecoder()
const headerEnd = new Uint8Array([13, 10, 13, 10])
const lineEnd = new Uint8Array([13, 10])
const maxResponseSize = 4 * 1024 * 1024

function indexOfBytes(bytes, pattern, start = 0) {
  outer: for (let i = start; i <= bytes.byteLength - pattern.byteLength; i++) {
    for (let j = 0; j < pattern.byteLength; j++) {
      if (bytes[i + j] !== pattern[j]) continue outer
    }
    return i
  }
  return -1
}

function concatBytes(chunks, length) {
  const result = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

function parseHead(bytes, start) {
  const end = indexOfBytes(bytes, headerEnd, start)
  if (end === -1) throw new Error('Upstream HTTP response headers are incomplete')

  const lines = decoder.decode(bytes.slice(start, end)).split('\r\n')
  const statusMatch = lines.shift()?.match(/^HTTP\/\d\.\d\s+(\d{3})(?:\s+(.*))?$/)
  if (!statusMatch) throw new Error('Upstream HTTP status line is invalid')

  const headers = new Headers()
  for (const line of lines) {
    const separator = line.indexOf(':')
    if (separator === -1) continue
    headers.append(line.slice(0, separator).trim(), line.slice(separator + 1).trim())
  }
  return {
    status: Number(statusMatch[1]),
    statusText: statusMatch[2] || '',
    headers,
    bodyOffset: end + headerEnd.byteLength,
  }
}

function decodeChunked(bytes) {
  const chunks = []
  let length = 0
  let offset = 0

  while (true) {
    const end = indexOfBytes(bytes, lineEnd, offset)
    if (end === -1) throw new Error('Upstream chunk header is incomplete')
    const sizeText = decoder.decode(bytes.slice(offset, end)).split(';', 1)[0].trim()
    if (!/^[0-9a-f]+$/i.test(sizeText)) throw new Error('Upstream chunk size is invalid')
    const size = Number.parseInt(sizeText, 16)
    offset = end + lineEnd.byteLength
    if (size === 0) break
    if (offset + size + lineEnd.byteLength > bytes.byteLength) {
      throw new Error('Upstream chunk body is incomplete')
    }
    const chunk = bytes.slice(offset, offset + size)
    chunks.push(chunk)
    length += chunk.byteLength
    offset += size
    if (bytes[offset] !== 13 || bytes[offset + 1] !== 10) {
      throw new Error('Upstream chunk terminator is invalid')
    }
    offset += lineEnd.byteLength
  }
  return concatBytes(chunks, length)
}

async function readResponse(reader) {
  const chunks = []
  let length = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    length += value.byteLength
    if (length > maxResponseSize) {
      throw new Error('Upstream fixed-length upload response exceeds 4 MiB')
    }
    chunks.push(value)
  }
  return concatBytes(chunks, length)
}

function responseFromBytes(bytes, method) {
  let offset = 0
  let head
  do {
    head = parseHead(bytes, offset)
    offset = head.bodyOffset
  } while (head.status >= 100 && head.status < 200 && head.status !== 101)

  let body = bytes.slice(offset)
  const transferEncoding = head.headers.get('transfer-encoding') || ''
  const contentLength = head.headers.get('content-length')
  // 304 may advertise the representation length without carrying that body.
  const noBody = method === 'HEAD' || head.status === 204 || head.status === 205 || head.status === 304
  if (!noBody) {
    if (transferEncoding.toLowerCase().split(',').map((item) => item.trim()).includes('chunked')) {
      body = decodeChunked(body)
      head.headers.delete('transfer-encoding')
      head.headers.set('content-length', String(body.byteLength))
    } else if (contentLength !== null) {
      const expected = Number(contentLength)
      if (!Number.isSafeInteger(expected) || expected < 0 || body.byteLength < expected) {
        throw new Error('Upstream Content-Length is invalid or incomplete')
      }
      body = body.slice(0, expected)
    }
  }

  head.headers.delete('connection')
  return new Response(noBody ? null : body, {
    status: head.status,
    statusText: head.statusText,
    headers: head.headers,
  })
}

export async function fetchWithKnownLength(url, options) {
  const target = new URL(url)
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new Error(`Unsupported upload protocol: ${target.protocol}`)
  }

  const headers = new Headers(options.headers)
  const contentLength = Number(headers.get('content-length'))
  if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
    throw new Error('A valid Content-Length is required for fixed-length upload')
  }
  headers.set('host', target.host)
  // The raw-socket path keeps the port in Host, unlike txiki fetch. Match
  // Destination to that actual header for body-bearing WebDAV COPY/MOVE.
  if ((options.method === 'COPY' || options.method === 'MOVE') && headers.has('destination')) {
    const destination = new URL(headers.get('destination'))
    destination.host = target.host
    headers.set('destination', destination.toString())
  }
  headers.set('connection', 'close')
  headers.set('accept-encoding', 'identity')
  headers.delete('transfer-encoding')

  const port = Number(target.port || (target.protocol === 'https:' ? 443 : 80))
  const socket = await tjs.connect(target.protocol === 'https:' ? 'tls' : 'tcp', target.hostname, port, {
    signal: options.signal,
    sni: target.hostname,
  })
  const { readable, writable } = await socket.opened
  const reader = readable.getReader()
  const writer = writable.getWriter()

  try {
    const path = target.pathname + target.search || '/'
    const head = [
      `${options.method} ${path} HTTP/1.1`,
      ...Array.from(headers, ([name, value]) => `${name}: ${value}`),
      '',
      '',
    ].join('\r\n')
    await writer.write(encoder.encode(head))

    const bodyReader = options.body.getReader()
    let written = 0
    try {
      while (true) {
        const { done, value } = await bodyReader.read()
        if (done) break
        written += value.byteLength
        if (written > contentLength) throw new Error('Upload stream exceeded Content-Length')
        await writer.write(value)
      }
    } finally {
      bodyReader.releaseLock()
    }
    if (written !== contentLength) {
      throw new Error(`Upload stream length ${written} does not match Content-Length ${contentLength}`)
    }

    writer.releaseLock()
    const responseBytes = await readResponse(reader)
    return responseFromBytes(responseBytes, options.method)
  } finally {
    try {
      reader.releaseLock()
    } catch {}
    try {
      writer.releaseLock()
    } catch {}
    try {
      socket.close()
    } catch {}
  }
}
