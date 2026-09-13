const decoder = new TextDecoder()

async function readSecret() {
  const reader = tjs.stdin.getReader()
  let secret = ''
  tjs.stdin.setRawMode(true)
  console.log('E2E_CREDENTIAL_READY')
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      secret += decoder.decode(value, { stream: true })
      const lineEnd = secret.search(/[\r\n]/)
      if (lineEnd !== -1) {
        return secret.slice(0, lineEnd)
      }
    }
  } finally {
    tjs.stdin.setRawMode(false)
    reader.releaseLock()
  }
  return secret
}

const password = await readSecret()
if (!password) {
  throw new Error('AList password was not provided')
}

tjs.env.ALIST_USERNAME = 'admin'
tjs.env.ALIST_PASSWORD = password
try {
  const target = tjs.env.E2E_TARGET === 'webdav' ? 'proxy-webdav-e2e.mjs' : 'proxy-alist-e2e.mjs'
  await import(`../dist/${target}`)
} finally {
  delete tjs.env.ALIST_PASSWORD
}
