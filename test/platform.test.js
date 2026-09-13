'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
  isWindows,
  envValue,
  envPath,
  setEnvPath,
  prependEnvPath,
  executableExtensions,
  isExecutableFile,
  findExecutableIn,
  killProcessTree,
  commandShimScript,
  writeFileAtomic,
  commandEntryPlan,
  ensureCommandEntry,
  choosePort
} = require('../platform')

function tempDir(t, prefix = 'dsh-platform-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('envValue matches the platform rule for environment key casing', () => {
  // Windows 的键名取决于谁启动的进程,所以必须忽略大小写;
  // POSIX 上 Path 与 PATH 是两个不同的变量,必须精确匹配。
  const env = { Path: 'from-mixed-case', PATH: 'from-upper' }
  if (isWindows) {
    assert.equal(envValue(env, 'PATH'), 'from-mixed-case')
    assert.equal(envPath(env), 'from-mixed-case')
  } else {
    assert.equal(envValue(env, 'PATH'), 'from-upper')
    assert.equal(envPath(env), 'from-upper')
  }
  assert.equal(envValue({}, 'PATH'), undefined)
})

test('setEnvPath leaves exactly one PATH key', () => {
  const env = { Path: 'old-mixed', PATH: 'old-upper', HOME: '/home/x' }
  setEnvPath(env, 'new-value')

  const keys = Object.keys(env).filter((key) => key.toUpperCase() === 'PATH')
  assert.deepEqual(keys, [isWindows ? 'Path' : 'PATH'])
  assert.equal(envPath(env), 'new-value')
  assert.equal(env.HOME, '/home/x')
})

test('prependEnvPath puts the directory first without duplicating it', () => {
  const env = {}
  setEnvPath(env, ['/a', '/b'].join(path.delimiter))
  prependEnvPath(env, '/bin')
  assert.equal(envPath(env), ['/bin', '/a', '/b'].join(path.delimiter))

  // 再来一次不该把 /bin 叠加两遍之外还乱序
  prependEnvPath(env, '/bin')
  assert.equal(envPath(env).split(path.delimiter)[0], '/bin')
})

test('executableExtensions follows PATHEXT on Windows and is empty elsewhere', () => {
  if (!isWindows) {
    assert.deepEqual(executableExtensions({}), [''])
    return
  }
  assert.deepEqual(executableExtensions({}), ['.COM', '.EXE', '.BAT', '.CMD'])
  assert.deepEqual(executableExtensions({ PATHEXT: '.EXE;.CMD' }), ['.EXE', '.CMD'])
})

test('isExecutableFile requires a PATHEXT suffix on Windows only', (t) => {
  const dir = tempDir(t)
  const shim = path.join(dir, 'dsh.cmd')
  fs.writeFileSync(shim, '@echo off\r\n')

  const bare = path.join(dir, 'dsh')
  fs.writeFileSync(bare, '')

  const text = path.join(dir, 'notes.txt')
  fs.writeFileSync(text, '')

  assert.equal(isExecutableFile(shim), true)
  assert.equal(isExecutableFile(text), false)
  assert.equal(isExecutableFile(path.join(dir, 'missing.cmd')), false)
  if (isWindows) {
    // 无后缀的文件在 Windows 上不是命令 —— 这正是 npm 全局目录里那个 0 字节 `dsh` 壳的情况
    assert.equal(isExecutableFile(bare), false)
  } else {
    fs.chmodSync(bare, 0o755)
    assert.equal(isExecutableFile(bare), true)
  }
})

test('findExecutableIn resolves through PATHEXT instead of assuming one name', (t) => {
  const dir = tempDir(t)
  const searchPath = [dir, '/nonexistent-dir'].join(path.delimiter)

  if (isWindows) {
    // 磁盘上是 .CMD(大写),探测用小写后缀 —— Windows 文件系统大小写不敏感,
    // 返回构造出来的那个拼写同样可以直接 spawn,所以按大小写不敏感比较。
    fs.writeFileSync(path.join(dir, 'dsh.CMD'), '@echo off\r\n')
    assert.equal(findExecutableIn(searchPath, 'dsh').toLowerCase(), path.join(dir, 'dsh.cmd').toLowerCase())
    // 已经带后缀时不再拼后缀
    assert.equal(
      findExecutableIn(searchPath, 'dsh.CMD').toLowerCase(),
      path.join(dir, 'dsh.cmd').toLowerCase()
    )
  } else {
    const bin = path.join(dir, 'dsh')
    fs.writeFileSync(bin, '#!/bin/sh\n')
    fs.chmodSync(bin, 0o755)
    assert.equal(findExecutableIn(searchPath, 'dsh'), bin)
  }

  assert.equal(findExecutableIn(searchPath, 'definitely-not-here'), undefined)
  assert.equal(findExecutableIn('', 'dsh'), undefined)
})

test('killProcessTree only acts on Windows and targets the whole tree', () => {
  const calls = []
  const spawnImpl = (command, argv, options) => {
    calls.push({ command, argv, options })
    return { unref: () => {} }
  }

  const acted = killProcessTree(4242, { spawnImpl })
  if (isWindows) {
    assert.equal(acted, true)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].command, 'taskkill')
    // /t 是关键:没有它,后端派生的 pwsh / rg 之类的孙子进程会活下来
    assert.deepEqual(calls[0].argv, ['/pid', '4242', '/t', '/f'])
    assert.equal(calls[0].options.windowsHide, true)
    assert.equal(calls[0].options.stdio, 'ignore')
  } else {
    assert.equal(acted, false)
    assert.equal(calls.length, 0)
  }

  // 非法 pid 不发起任何动作
  calls.length = 0
  assert.equal(killProcessTree(0, { spawnImpl }), false)
  assert.equal(killProcessTree(undefined, { spawnImpl }), false)
  assert.equal(calls.length, 0)
})

test('commandShimScript runs the target through a real node binary', () => {
  const script = commandShimScript('C:\\Program Files\\DSH\\node.exe', 'C:\\dsh\\bin\\pnpm.mjs')
  assert.match(script, /^@echo off\r\n/)
  assert.match(script, /"C:\\Program Files\\DSH\\node\.exe" "C:\\dsh\\bin\\pnpm\.mjs" %\*/)
  assert.match(script, /exit \/b %ERRORLEVEL%/)
  // 绝对路径,不依赖 shim 自己所在的位置
  assert.doesNotMatch(script, /%~dp0/)
})

test('writeFileAtomic overwrites in place and leaves no temp file', (t) => {
  const dir = tempDir(t)
  const target = path.join(dir, 'pnpm.cmd')
  writeFileAtomic(target, 'first')
  assert.equal(fs.readFileSync(target, 'utf8'), 'first')

  writeFileAtomic(target, 'second')
  assert.equal(fs.readFileSync(target, 'utf8'), 'second')
  assert.deepEqual(fs.readdirSync(dir), ['pnpm.cmd'])
})

test('choosePort prefers a free port and falls back to 0 when it is taken', async (t) => {
  const taken = net.createServer()
  await new Promise((resolve, reject) => {
    taken.once('error', reject)
    taken.listen({ port: 0, host: '127.0.0.1' }, resolve)
  })
  t.after(() => taken.close())
  const takenPort = taken.address().port

  assert.equal(await choosePort(takenPort), 0)

  // 拿一个刚释放的端口当"空闲"样本
  const free = net.createServer()
  await new Promise((resolve) => free.listen({ port: 0, host: '127.0.0.1' }, resolve))
  const freePort = free.address().port
  await new Promise((resolve) => free.close(resolve))

  assert.equal(await choosePort(freePort), freePort)

  // 非法输入一律回落 0,绝不让"探测端口"本身成为启动失败的原因
  assert.equal(await choosePort(0), 0)
  assert.equal(await choosePort(undefined), 0)
  assert.equal(await choosePort(99999), 0)
})

test('command entry plan differs per platform (shim vs symlink)', () => {
  // Windows:命令必须是 `pnpm.cmd` 这种带 PATHEXT 后缀的真文件
  assert.deepEqual(commandEntryPlan({ binDir: 'C:\\dsh\\bin', name: 'pnpm', platform: 'win32' }), {
    kind: 'shim',
    command: path.join('C:\\dsh\\bin', 'pnpm.cmd')
  })
  // POSIX:保持原来的符号链接形态
  assert.deepEqual(commandEntryPlan({ binDir: '/home/x/.dsh-desktop/bin', name: 'pnpm', platform: 'darwin' }), {
    kind: 'symlink',
    command: path.join('/home/x/.dsh-desktop/bin', 'pnpm')
  })
  assert.throws(() => commandEntryPlan({ name: 'pnpm' }), TypeError)
})

test('ensureCommandEntry writes a runnable .cmd shim on Windows', (t) => {
  const dir = tempDir(t)
  const binDir = path.join(dir, 'bin')
  const script = path.join(dir, 'node_modules', 'pnpm', 'bin', 'pnpm.mjs')
  fs.mkdirSync(path.dirname(script), { recursive: true })
  fs.writeFileSync(script, '')

  const nodePath = isWindows ? process.execPath : '/usr/bin/node'
  const result = ensureCommandEntry({ binDir, name: 'pnpm', scriptPath: script, nodePath, platform: 'win32' })

  assert.equal(result.kind, 'shim')
  assert.equal(result.command, path.join(binDir, 'pnpm.cmd'))
  const content = fs.readFileSync(result.command, 'utf8')
  assert.match(content, /@echo off/)
  assert.ok(content.includes(`"${nodePath}"`), 'shim 必须点名要用哪个 node')
  assert.ok(content.includes(`"${script}"`), 'shim 必须点名要跑哪个脚本')
  // 只留下目标文件,不留临时文件
  assert.deepEqual(fs.readdirSync(binDir), ['pnpm.cmd'])

  // 没有 node 就不能生成可用的 shim —— 这时必须显式报错,而不是悄悄写一个跑不起来的东西
  assert.throws(
    () => ensureCommandEntry({ binDir, name: 'pnpm', scriptPath: script, platform: 'win32' }),
    /node/
  )
})

test('ensureCommandEntry keeps the POSIX symlink behaviour', (t) => {
  if (isWindows) {
    // Windows 上建符号链接需要管理员权限或开发者模式,测试环境不保证有 ——
    // 分支决策已经在上面的 commandEntryPlan 测试里覆盖了。
    t.skip('Windows 上不建符号链接')
    return
  }
  const dir = tempDir(t)
  const binDir = path.join(dir, 'bin')
  const script = path.join(dir, 'pnpm.mjs')
  fs.writeFileSync(script, '#!/usr/bin/env node\n')

  const result = ensureCommandEntry({ binDir, name: 'pnpm', scriptPath: script, nodePath: '/usr/bin/node' })
  assert.equal(result.kind, 'symlink')
  assert.equal(fs.realpathSync(result.command), fs.realpathSync(script))
})
