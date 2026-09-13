import path from 'tjs:path'

const programDir = tjs.env.ALIST_ENCRYPT_PROGRAM_DIR || '/usr/lib/alist-encrypt'
const entryPath = tjs.env.ALIST_ENCRYPT_ENTRY || path.join(programDir, 'server.mjs')

const process = {
  argv: [tjs.args[0] || '/usr/bin/tjs', entryPath, ...tjs.args.slice(3)],
  env: tjs.env,
  cwd() {
    return tjs.env.ALIST_ENCRYPT_HOME || '/etc/alist-encrypt'
  },
  exit(code = 0) {
    tjs.exit(code)
  },
  get pid() {
    return tjs.pid
  },
}

export default process
