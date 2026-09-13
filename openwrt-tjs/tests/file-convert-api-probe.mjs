const origin = 'http://127.0.0.1:5344'
const folderPath = '/tmp/alist-api-convert-in'
const encPath = '/tmp/alist-api-convert-enc'
const decPath = '/tmp/alist-api-convert-dec'
const password = 'conversion-pass'

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function request(name, body, headers = {}) {
  const response = await fetch(`${origin}/enc-api/encryptFile`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  let data = null
  try {
    data = JSON.parse(text)
  } catch {}
  const result = { name, status: response.status, code: data?.code ?? 200, message: data?.msg || data?.message || null }
  console.log(`FILE_API_STEP ${JSON.stringify(result)}`)
  return { response, data, result }
}

const loginResponse = await fetch(`${origin}/enc-api/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: '123456' }),
})
const login = await loginResponse.json()
const token = login.data?.jwtToken
if (loginResponse.status !== 200 || login.code !== 200 || !token) {
  throw new Error(`application login failed: HTTP ${loginResponse.status}, API ${login.code}`)
}

const headers = { authorizetoken: token }
const encrypt = await request('encrypt', {
  folderPath,
  outPath: encPath,
  encType: 'aesctr',
  password,
  operation: 'enc',
  encName: true,
}, headers)
if (encrypt.response.status !== 200 || encrypt.data?.code !== 200) {
  throw new Error(`encryptFile request failed: HTTP ${encrypt.response.status}, API ${encrypt.data?.code}`)
}

await delay(22000)

const decrypt = await request('decrypt', {
  folderPath: encPath,
  outPath: decPath,
  encType: 'aesctr',
  password,
  operation: 'dec',
  encName: true,
}, headers)
if (decrypt.response.status !== 200 || decrypt.data?.code !== 200) {
  throw new Error(`decryptFile request failed: HTTP ${decrypt.response.status}, API ${decrypt.data?.code}`)
}

await delay(22000)
console.log(JSON.stringify({ ok: true, folderPath, encPath, decPath }))
tjs.exit(0)
