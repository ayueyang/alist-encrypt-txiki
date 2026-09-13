function assert(name, condition, detail) {
  if (!condition) {
    throw new Error(`${name}: ${detail}`)
  }
  console.log(`HTTP_PASS ${name} ${detail}`)
}

const origin = 'http://127.0.0.1:5344'

const staticResponse = await fetch(`${origin}/public/index.html`)
const staticBody = await staticResponse.text()
assert('static-ui', staticResponse.status === 200 && staticBody.includes('<!DOCTYPE html>'), `status=${staticResponse.status} bytes=${staticBody.length}`)

const indexResponse = await fetch(`${origin}/index`, { redirect: 'manual' })
assert('index-redirect', indexResponse.status === 302 && indexResponse.headers.get('location') === '/public/index.html', `status=${indexResponse.status}`)

const loginResponse = await fetch(`${origin}/enc-api/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: '123456' }),
})
const login = await loginResponse.json()
const token = login.data?.jwtToken
assert('login', loginResponse.status === 200 && login.code === 200 && typeof token === 'string', `status=${loginResponse.status} code=${login.code}`)

const userResponse = await fetch(`${origin}/enc-api/getUserInfo`, { headers: { authorizetoken: token } })
const user = await userResponse.json()
assert('authenticated-api', userResponse.status === 200 && user.code === 200 && user.data?.userInfo?.username === 'admin', `status=${userResponse.status} code=${user.code}`)

const proxyResponse = await fetch(`${origin}/`)
const proxyBody = await proxyResponse.text()
assert('alist-transparent-proxy', proxyResponse.status === 200 && proxyBody.includes('/public/logo.png'), `status=${proxyResponse.status} bytes=${proxyBody.length}`)

const headResponse = await fetch(`${origin}/`, { method: 'HEAD' })
assert('head', headResponse.status > 0 && (await headResponse.text()) === '', `status=${headResponse.status}`)

tjs.exit(0)
