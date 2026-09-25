#!/usr/bin/env node
// Read-only business-source comparison. Does not fetch, merge or write files.
import { execFileSync } from 'node:child_process'
import { readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const args = process.argv.slice(2)
if (args.includes('--help')) {
  console.log('Usage: node scripts/compare-upstream.mjs [--upstream=<checkout>] [--json]')
  console.log('Default upstream: ../../upstream/alist-encrypt relative to this repository.')
  process.exit(0)
}
const upstreamOption = args.find((arg) => arg.startsWith('--upstream='))
const upstream = path.resolve(upstreamOption ? upstreamOption.slice('--upstream='.length) : path.join(repo, '..', '..', 'upstream', 'alist-encrypt'))
if (args.some((arg) => arg !== upstreamOption && arg !== '--json')) {
  throw new Error(`Unexpected argument: ${args.find((arg) => arg !== upstreamOption && arg !== '--json')}`)
}

function git(cwd, ...gitArgs) {
  return execFileSync('git', ['-C', cwd, ...gitArgs], {
    encoding: 'utf8',
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function sourceFiles(cwd) {
  return new Set(git(cwd, 'ls-files', '--', 'node-proxy/src').split(/\r?\n/).filter((name) => name.endsWith('.js')))
}

try {
  if (await realpath(repo) === await realpath(upstream)) {
    throw new Error('The upstream must be a separate checkout, not this adaptation worktree')
  }
  const upstreamSha = git(upstream, 'rev-parse', 'HEAD')
  const adaptedSha = git(repo, 'rev-parse', 'HEAD')
  if (git(upstream, 'status', '--porcelain', '--untracked-files=no')) {
    throw new Error('Upstream has local edits; freeze a clean baseline before comparing')
  }
  const upstreamFiles = sourceFiles(upstream)
  const adaptedFiles = sourceFiles(repo)
  const files = [...new Set([...upstreamFiles, ...adaptedFiles])].sort()
  if (files.length === 0) throw new Error('No node-proxy/src/*.js files found')
  const differences = []
  let same = 0
  for (const name of files) {
    if (!upstreamFiles.has(name) || !adaptedFiles.has(name)) {
      differences.push({ file: name, reason: upstreamFiles.has(name) ? 'adaptation missing' : 'upstream missing' })
      continue
    }
    const [original, adapted] = await Promise.all([
      readFile(path.join(upstream, name), 'utf8'),
      readFile(path.join(repo, name), 'utf8'),
    ])
    if (original.replace(/\r\n/g, '\n') === adapted.replace(/\r\n/g, '\n')) same++
    else differences.push({ file: name, reason: 'content differs' })
  }
  const report = {
    upstreamSha,
    adaptedSha,
    adaptedWorkingTreeModified: Boolean(git(repo, 'status', '--porcelain', '--untracked-files=no')),
    total: files.length,
    sameIgnoringCrLf: same,
    differences,
  }
  if (args.includes('--json')) console.log(JSON.stringify(report, null, 2))
  else {
    console.log(`upstream ${upstreamSha} / adapted ${adaptedSha}`)
    console.log(`node-proxy/src/*.js: ${same}/${files.length} same after CRLF normalization; ${differences.length} different`)
    if (report.adaptedWorkingTreeModified) console.log('NOTE: adaptation worktree has uncommitted changes')
    for (const { file, reason } of differences) console.log(`${reason}: ${file}`)
  }
} catch (error) {
  console.error(`Comparison stopped: ${error.message}`)
  process.exitCode = 1
}
