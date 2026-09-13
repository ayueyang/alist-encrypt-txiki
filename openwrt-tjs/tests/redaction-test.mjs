import { redactArgs } from '../src/redact.js'

const cases = [
  ['json', ['body', '{"username":"admin","password":"secret","token":"value"}']],
  ['headers', ['headers', { authorization: 'Bearer secret', cookie: 'session=secret', accept: 'application/json' }]],
  ['url', ['url', 'http://example.test/p/file?sign=secret&x=1']],
  ['positional-login', ['admin', 'secret']],
  ['config', ['configData ', { passwdList: [{ password: 'secret', encType: 'aesctr' }] }]],
]

for (const [name, args] of cases) {
  const output = JSON.stringify(redactArgs(args))
  if (output.includes('secret') || output.includes('value') || output.includes('session=secret')) {
    throw new Error(`${name} leaked sensitive data: ${output}`)
  }
  console.log(`REDACT_PASS ${name} ${output}`)
}
