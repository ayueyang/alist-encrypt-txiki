import { existsSync } from 'node:fs'
import { cp, mkdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import esbuild from 'esbuild'

const currentDir = path.dirname(fileURLToPath(import.meta.url))
const projectDir = path.dirname(currentDir)
const proxyDir = path.join(projectDir, 'node-proxy')
const sourceDir = path.join(currentDir, 'src')
const platformDir = path.join(sourceDir, 'platform')
const distDir = path.join(currentDir, 'dist')
const testsDir = path.join(currentDir, 'tests')

const aliases = new Map([
  ['koa', 'koa.js'],
  ['koa-router', 'router.js'],
  ['koa-bodyparser', 'bodyparser.js'],
  ['koa-static', 'static.js'],
  ['http', 'http.js'],
  ['node:http', 'http.js'],
  ['https', 'http.js'],
  ['node:https', 'http.js'],
  ['crypto', 'crypto.js'],
  ['node:crypto', 'crypto.js'],
  ['stream', 'stream.js'],
  ['node:stream', 'stream.js'],
  ['fs', 'fs.js'],
  ['node:fs', 'fs.js'],
  ['path', 'path.js'],
  ['node:path', 'path.js'],
  ['log4js', 'log4js.js'],
  ['dotenv', 'dotenv.js'],
  ['console', 'console.js'],
  ['alist-encrypt:fixed-length-fetch', 'fixed-length-fetch.js'],
  ['alist-encrypt:destination-authority', 'destination-authority.js'],
])

const platformPlugin = {
  name: 'alist-encrypt-tjs-platform',
  setup(build) {
    build.onResolve({ filter: /^@\// }, (args) => ({
      path: path.join(proxyDir, 'src', args.path.slice(2) + '.js'),
    }))

    build.onResolve({ filter: /.*/ }, (args) => {
      const alias = aliases.get(args.path)
      if (alias) {
        return { path: path.join(platformDir, alias) }
      }
      if (args.path.startsWith('tjs:')) {
        return { path: args.path, external: true }
      }
      return null
    })

    build.onLoad({ filter: /node-proxy[\\/]app\.js$/ }, async (args) => {
      let contents = await readFile(args.path, 'utf8')
      const cliBlock = /const arg = process\.argv\.slice\(2\)\r?\nif \(arg\.length > 1\) \{\r?\n  \/\/ convertFile command\r?\n  convertFile\(\.\.\.arg\)\r?\n  return\r?\n\}\r?\n\r?\n/
      if (!cliBlock.test(contents)) {
        throw new Error('Unable to locate the upstream app.js CLI block')
      }
      contents = contents.replace(cliBlock, '')
      return { contents, loader: 'js' }
    })
  },
}

// Node 对照基线（node-vectors.cjs）取「未经运行时适配」的原版源码。
// 开发布局下原版在仓库外的 upstream/alist-encrypt/node-proxy；
// 开源发布仓库没有该外部目录，此时本仓库自带的 node-proxy 就是原版 Node 版本，
// 故回退到本地 proxyDir，保证独立检出即可构建。
const externalUpstreamDir = path.resolve(projectDir, '..', '..', 'upstream', 'alist-encrypt', 'node-proxy')
const upstreamDir = existsSync(externalUpstreamDir) ? externalUpstreamDir : proxyDir
const nodeBaselinePlugin = {
  name: 'alist-encrypt-node-baseline',
  setup(build) {
    build.onResolve({ filter: /^@\// }, (args) => {
      if (args.path === '@/common/logger') {
        return { path: path.join(testsDir, 'node-logger.js') }
      }
      return { path: path.join(upstreamDir, 'src', args.path.slice(2) + '.js') }
    })
    // Node 对照基线必须避开 txiki Worker：node-proxy 的 PRGAThread 是运行时适配版
    // （txiki Worker + navigator.hardwareConcurrency），在纯 Node 下只会降级报错。
    // 本插件只用于 node-vectors.cjs 这一次构建，故统一替换为无 Worker 的 tests/node-prga.js。
    build.onResolve({ filter: /[\\/]PRGAThread$/ }, () => {
      return { path: path.join(testsDir, 'node-prga.js') }
    })
  },
}

const common = {
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  mainFields: ['module', 'main'],
  nodePaths: [path.join(currentDir, 'node_modules')],
  target: 'es2023',
  charset: 'utf8',
  legalComments: 'none',
  sourcemap: true,
  inject: [path.join(sourceDir, 'globals.js')],
  plugins: [platformPlugin],
  logLevel: 'info',
}

await rm(distDir, { recursive: true, force: true })
await mkdir(distDir, { recursive: true })

await esbuild.build({
  ...common,
  entryPoints: [path.join(proxyDir, 'app.js')],
  outfile: path.join(distDir, 'server.mjs'),
})

await esbuild.build({
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2023',
  charset: 'utf8',
  legalComments: 'none',
  entryPoints: [path.join(sourceDir, 'prga-worker.js')],
  outfile: path.join(distDir, 'prga-worker.mjs'),
})

await esbuild.build({
  ...common,
  entryPoints: [path.join(sourceDir, 'convert-entry.js')],
  outfile: path.join(distDir, 'convert.mjs'),
})

await esbuild.build({
  ...common,
  entryPoints: [path.join(testsDir, 'openwrt-vector-entry.js')],
  outfile: path.join(distDir, 'openwrt-vectors.mjs'),
})

await esbuild.build({
  ...common,
  entryPoints: [path.join(testsDir, 'dao-test-entry.js')],
  outfile: path.join(distDir, 'dao-test.mjs'),
})

await esbuild.build({
  ...common,
  entryPoints: [path.join(testsDir, 'http-matrix-entry.js')],
  outfile: path.join(distDir, 'http-matrix.mjs'),
})

await esbuild.build({
  ...common,
  entryPoints: [path.join(testsDir, 'proxy-alist-e2e.js')],
  outfile: path.join(distDir, 'proxy-alist-e2e.mjs'),
})

await esbuild.build({
  ...common,
  entryPoints: [path.join(testsDir, 'proxy-webdav-e2e.js')],
  outfile: path.join(distDir, 'proxy-webdav-e2e.mjs'),
})

await esbuild.build({
  ...common,
  entryPoints: [path.join(testsDir, 'flowenc-alist-probe.js')],
  outfile: path.join(distDir, 'flowenc-alist-probe.mjs'),
})

await esbuild.build({
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node22',
  charset: 'utf8',
  legalComments: 'none',
  nodePaths: [path.join(currentDir, 'node_modules')],
  plugins: [nodeBaselinePlugin],
  entryPoints: [path.join(testsDir, 'node-vector-entry.js')],
  outfile: path.join(distDir, 'node-vectors.cjs'),
})

await cp(path.join(proxyDir, 'public'), path.join(distDir, 'public'), { recursive: true })
