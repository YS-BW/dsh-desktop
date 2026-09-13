'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { PassThrough } = require('node:stream')
const { PATH_KEY, envPath } = require('../platform')
const {
  PLUGIN_CATALOG,
  commandForEngine,
  createPluginInstaller,
  parsePnpmList,
  resolvePnpmEntry
} = require('../plugin-installer')

test('parsePnpmList reads pnpm JSON and tolerates a log prefix', () => {
  const output = `profile ready\n${JSON.stringify([
    {
      dependencies: {
        dshmarket: { version: '1.45.1', path: '/tmp/dshmarket' },
        'dsh-better-sidebar': { version: '0.19.1', path: '/tmp/sidebar' }
      }
    }
  ])}`
  assert.deepEqual(parsePnpmList(output), {
    dshmarket: '1.45.1',
    'dsh-better-sidebar': '0.19.1'
  })
})

test('commandForEngine uses the selected engine without assuming a system dsh', () => {
  assert.deepEqual(commandForEngine({ node: '/app/node', bin: '/app/dsh/bin.js' }, ['plugin']), {
    command: '/app/node',
    argv: ['/app/dsh/bin.js', 'plugin']
  })
  assert.deepEqual(commandForEngine({ bin: '/usr/local/bin/dsh' }, ['plugin']), {
    command: '/usr/local/bin/dsh',
    argv: ['plugin']
  })
})

test('resolvePnpmEntry picks whichever bin script this pnpm version ships', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pnpm-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true })

  // 什么都没装 → 明确返回 undefined（调用方据此打日志，而不是写一个跑不起来的入口）
  assert.equal(resolvePnpmEntry(root), undefined)

  fs.writeFileSync(path.join(root, 'bin', 'pnpm.cjs'), '')
  assert.equal(resolvePnpmEntry(root), path.join(root, 'bin', 'pnpm.cjs'))

  // 两个都在时优先 .mjs（corepack/ESM 那条，也是原实现用的那个）
  fs.writeFileSync(path.join(root, 'bin', 'pnpm.mjs'), '')
  assert.equal(resolvePnpmEntry(root), path.join(root, 'bin', 'pnpm.mjs'))
})

function fakeSpawner(responses, calls) {
  return (command, argv, options) => {
    calls.push({ command, argv, options })
    const response = responses.shift()
    const child = new EventEmitter()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = () => {}
    queueMicrotask(() => {
      if (response.stdout) child.stdout.write(response.stdout)
      if (response.stderr) child.stderr.write(response.stderr)
      child.stdout.end()
      child.stderr.end()
      child.emit('exit', response.code ?? 0, null)
    })
    return child
  }
}

test('change only installs curated packages and validates the public DSH profile', async () => {
  const calls = []
  const manager = createPluginInstaller({
    resolveEngine: () => ({ node: '/app/node', bin: '/app/dsh/bin.js' }),
    dshHome: '/tmp/home',
    workspace: '/tmp/workspace',
    executableDirs: ['/app/node_modules/.bin'],
    spawnImpl: fakeSpawner(
      [
        { stdout: '[{"dependencies":{}}]' },
        { stdout: 'installed' },
        { stdout: '{}' }
      ],
      calls
    )
  })

  const result = await manager.change('dsh-market', 'install')
  assert.equal(result.ok, true)
  assert.equal(result.changed, true)
  assert.deepEqual(calls.map((call) => call.argv.slice(1)), [
    ['plugin', '--profile', 'web', 'list', '--depth', '0', '--json'],
    ['plugin', '--profile', 'web', 'add', 'dshmarket'],
    ['--profile', 'web', '--dump-config']
  ])
  assert.equal(calls[0].options.env.DSH_HOME, '/tmp/home')
  // PATH 的键名和分隔符都按平台走：Windows 上是 `Path` + `;`，POSIX 上是 `PATH` + `:`。
  // 这里以前写死了 POSIX 的 `:` 前缀，所以在 Windows 上必然失败 —— 是测试不可移植，
  // 不是产品逻辑有问题（产品用的是 path.delimiter）。
  const childPath = envPath(calls[0].options.env)
  assert.equal(childPath.split(path.delimiter)[0], '/app/node_modules/.bin')
  const pathKeys = Object.keys(calls[0].options.env).filter((key) => key.toUpperCase() === 'PATH')
  assert.deepEqual(pathKeys, [PATH_KEY])
})

test('unknown plugin ids never reach DSH', async () => {
  const calls = []
  const manager = createPluginInstaller({
    resolveEngine: () => ({ bin: '/usr/local/bin/dsh' }),
    dshHome: '/tmp/home',
    workspace: '/tmp/workspace',
    spawnImpl: fakeSpawner([], calls)
  })
  const result = await manager.change('@scope/arbitrary-package', 'install')
  assert.equal(result.ok, false)
  assert.equal(calls.length, 0)
  assert.equal(PLUGIN_CATALOG.length, 2)
})

test('failed verification performs the inverse public CLI operation', async () => {
  const calls = []
  const manager = createPluginInstaller({
    resolveEngine: () => ({ node: '/app/node', bin: '/app/dsh/bin.js' }),
    dshHome: '/tmp/home',
    workspace: '/tmp/workspace',
    spawnImpl: fakeSpawner(
      [
        { stdout: '[{"dependencies":{}}]' },
        { stdout: 'installed' },
        { code: 1, stderr: 'invalid bundle' },
        { stdout: 'removed' },
        { stdout: '{}' }
      ],
      calls
    )
  })

  const result = await manager.change('dsh-better-sidebar', 'install')
  assert.equal(result.ok, false)
  assert.equal(result.recovered, true)
  assert.deepEqual(calls[1].argv.slice(1), [
    'plugin',
    '--profile',
    'web',
    'add',
    'dsh-better-sidebar',
    '--allow-build=node-pty'
  ])
  assert.deepEqual(calls[3].argv.slice(1), [
    'plugin',
    '--profile',
    'web',
    'remove',
    'dsh-better-sidebar'
  ])
})
