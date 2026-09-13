import path from 'tjs:path'

const values = [
  '/dav/会员/_codex_openwrt_webdav/webdav 中文.txt',
  '/dav/会员/_codex_openwrt_webdav/webdav%20中文.txt',
  '/dav/会员/_codex_openwrt_webdav/gbndTFjbGVfNkW4~-ME9WA5J-.txt',
]

for (const value of values) {
  console.log(JSON.stringify({
    value,
    basename: path.basename(value),
    dirname: path.dirname(value),
    extname: path.extname(value),
  }))
}

tjs.exit(0)
