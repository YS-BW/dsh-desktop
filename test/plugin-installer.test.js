'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { PassThrough } = require('node:stream')
const {
  PLUGIN_CATALOG,
  commandForEngine,
  createPluginInstaller,
  parsePnpmList
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
  assert.match(calls[0].options.env.PATH, /^\/app\/node_modules\/\.bin:/)
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
