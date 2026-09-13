'use strict'

/**
 * DSH 初始化向导的可选插件安装器。
 *
 * 这里只调用 DSH 对外提供的 `dsh plugin --profile web <pnpm args...>`，
 * 不直接改 profile 的 package.json，也不依赖 DSH 内部 JavaScript API。
 * 因此 DSH 升级后，只要它的公开 CLI 保持兼容，这个壳就不需要跟着改。
 */

const { spawn } = require('node:child_process')
const path = require('node:path')

const PROFILE = 'web'
const COMMAND_TIMEOUT_MS = 180_000

/**
 * 首版是固定白名单，页面传回的只是 id，不是任意 npm 包名。
 *
 * dsh-market 的展示名与它的 npm 包名不同：实际发布的包是 `dshmarket`。
 * 用户说的 dsh-better-slide 对应已发布的项目 `dsh-better-sidebar`。
 */
const PLUGIN_CATALOG = Object.freeze([
  Object.freeze({
    id: 'dsh-market',
    packageName: 'dshmarket',
    name: 'DSH Market',
    subtitle: 'dsh-market',
    description: '在 DSH 内浏览、安装和管理更多社区插件。'
  }),
  Object.freeze({
    id: 'dsh-better-sidebar',
    packageName: 'dsh-better-sidebar',
    name: 'Better Sidebar',
    subtitle: 'dsh-better-sidebar',
    description: '为 DSH 增加类 VS Code 的右侧边栏，改善会话与工作区导航。',
    // pnpm 11+ 默认拦住依赖的构建脚本。这个插件的终端功能需要 node-pty，
    // 只对这一个已知依赖放行，不开「允许所有构建」。
    allowBuilds: ['node-pty']
  })
])

const CATALOG_BY_ID = new Map(PLUGIN_CATALOG.map((plugin) => [plugin.id, plugin]))

function commandForEngine(engine, args) {
  if (!engine?.bin) throw new Error('找不到可用的 DSH 引擎')
  return engine.node
    ? { command: engine.node, argv: [engine.bin, ...args] }
    : { command: engine.bin, argv: args }
}

function parsePnpmList(output) {
  const source = String(output || '').trim()
  if (!source) return {}

  const candidates = [source]
  // DSH 初始化时可能在 JSON 前打一行日志。只尝试「行首的 JSON」，
  // 避免对长输出的每个括号都 slice，导致二次方级别的内存拷贝。
  const jsonStart = /(?:^|\n)\s*([\[{])/g
  for (const match of source.matchAll(jsonStart)) {
    const index = match.index + match[0].lastIndexOf(match[1])
    if (index > 0) candidates.push(source.slice(index))
  }

  let parsed
  for (const candidate of candidates) {
    try {
      parsed = JSON.parse(candidate)
      break
    } catch {}
  }
  if (parsed === undefined) throw new Error(`无法解析 pnpm 返回的插件列表：${source.slice(-500)}`)

  const root = Array.isArray(parsed) ? parsed[0] : parsed
  const dependencies = {
    ...(root?.dependencies || {}),
    ...(root?.devDependencies || {}),
    ...(root?.optionalDependencies || {})
  }
  return Object.fromEntries(
    Object.entries(dependencies).map(([name, value]) => [
      name,
      typeof value === 'string' ? value : value?.version || value?.from || '未知'
    ])
  )
}

function createPluginInstaller({
  resolveEngine,
  dshHome,
  workspace,
  executableDirs = [],
  spawnImpl = spawn,
  commandTimeoutMs = COMMAND_TIMEOUT_MS,
  log = () => {}
} = {}) {
  if (typeof resolveEngine !== 'function') throw new TypeError('resolveEngine 必须是函数')

  function runDsh(args, { onOutput } = {}) {
    return new Promise((resolve) => {
      let command
      let argv
      try {
        ;({ command, argv } = commandForEngine(resolveEngine(), args))
      } catch (error) {
        resolve({ ok: false, error: String(error.message || error), stdout: '', stderr: '' })
        return
      }

      const env = { ...process.env, DSH_HOME: dshHome, NO_COLOR: '1' }
      const pathParts = [...executableDirs.filter(Boolean), env.PATH || ''].filter(Boolean)
      env.PATH = pathParts.join(path.delimiter)

      log('运行 DSH 插件命令:', command, argv.join(' '))
      let child
      try {
        child = spawnImpl(command, argv, {
          cwd: workspace,
          env,
          stdio: ['ignore', 'pipe', 'pipe']
        })
      } catch (error) {
        resolve({ ok: false, error: String(error.message || error), stdout: '', stderr: '' })
        return
      }

      let stdout = ''
      let stderr = ''
      let settled = false
      const finish = (result) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(result)
      }
      const append = (stream, chunk) => {
        const text = chunk.toString()
        if (stream === 'stdout') stdout = `${stdout}${text}`.slice(-200_000)
        else stderr = `${stderr}${text}`.slice(-200_000)
        onOutput?.(text, stream)
      }
      child.stdout?.on('data', (chunk) => append('stdout', chunk))
      child.stderr?.on('data', (chunk) => append('stderr', chunk))
      child.on('error', (error) =>
        finish({ ok: false, error: String(error.message || error), stdout, stderr })
      )
      child.on('exit', (code, signal) => {
        if (code === 0) finish({ ok: true, stdout, stderr })
        else {
          const detail = (stderr || stdout).trim().slice(-1200)
          finish({
            ok: false,
            error: `DSH 插件命令失败（code=${code} signal=${signal}）${detail ? `\n${detail}` : ''}`,
            stdout,
            stderr
          })
        }
      })

      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {}
        finish({
          ok: false,
          error: `DSH 插件命令超时（${commandTimeoutMs} ms）`,
          stdout,
          stderr
        })
      }, commandTimeoutMs)
      timer.unref?.()
    })
  }

  async function installedVersions() {
    const result = await runDsh(['plugin', '--profile', PROFILE, 'list', '--depth', '0', '--json'])
    if (!result.ok) return result
    try {
      return { ok: true, versions: parsePnpmList(result.stdout) }
    } catch (error) {
      return { ok: false, error: String(error.message || error) }
    }
  }

  async function list() {
    const result = await installedVersions()
    if (!result.ok) return { ok: false, error: result.error, plugins: [] }
    return {
      ok: true,
      plugins: PLUGIN_CATALOG.map((plugin) => ({
        ...plugin,
        installed: Object.hasOwn(result.versions, plugin.packageName),
        version: result.versions[plugin.packageName]
      }))
    }
  }

  async function verify() {
    const result = await runDsh(['--profile', PROFILE, '--dump-config'])
    return result.ok ? { ok: true } : { ok: false, error: result.error }
  }

  async function applyPackage(plugin, action, version, options = {}) {
    const packageSpec = version ? `${plugin.packageName}@${version}` : plugin.packageName
    const args =
      action === 'install'
        ? [
            'add',
            packageSpec,
            ...(plugin.allowBuilds || []).map((name) => `--allow-build=${name}`)
          ]
        : ['remove', plugin.packageName]
    return runDsh(['plugin', '--profile', PROFILE, ...args], options)
  }

  async function change(id, action, { onOutput } = {}) {
    const plugin = CATALOG_BY_ID.get(id)
    if (!plugin) return { ok: false, error: '这个插件不在可安装白名单中' }
    if (action !== 'install' && action !== 'remove') {
      return { ok: false, error: '无效的插件操作' }
    }

    const before = await installedVersions()
    if (!before.ok) return before
    const previousVersion = before.versions[plugin.packageName]
    const installed = previousVersion !== undefined
    if ((action === 'install' && installed) || (action === 'remove' && !installed)) {
      return { ok: true, changed: false, plugin, previousVersion }
    }

    const transaction = { id, action, previousVersion }
    const changed = await applyPackage(plugin, action, undefined, { onOutput })
    if (!changed.ok) {
      // pnpm 可能在包已写入后才因构建脚本等后置阶段返回非 0。
      // 重新查询实际状态；若已发生更改，立即用公开 CLI 恢复，避免半安装。
      const afterFailure = await installedVersions()
      const isNowInstalled =
        afterFailure.ok && Object.hasOwn(afterFailure.versions, plugin.packageName)
      const stateChanged =
        (action === 'install' && isNowInstalled) || (action === 'remove' && !isNowInstalled)
      if (!stateChanged) return changed
      const recovered = await undo(transaction)
      return {
        ...changed,
        recovered: recovered.ok,
        recoveryError: recovered.ok ? undefined : recovered.error
      }
    }

    const verified = await verify()
    if (verified.ok) return { ok: true, changed: true, plugin, transaction }

    const recovered = await undo(transaction)
    return {
      ok: false,
      error: `插件更改后 DSH 配置验证失败：${verified.error}`,
      recovered: recovered.ok,
      recoveryError: recovered.ok ? undefined : recovered.error
    }
  }

  async function undo(transaction) {
    const plugin = CATALOG_BY_ID.get(transaction?.id)
    if (!plugin) return { ok: false, error: '无法识别需要恢复的插件' }
    const inverse = transaction.action === 'install' ? 'remove' : 'install'
    const restored = await applyPackage(
      plugin,
      inverse,
      inverse === 'install' ? transaction.previousVersion : undefined
    )
    if (!restored.ok) return restored
    return verify()
  }

  return { list, change, undo, verify, runDsh }
}

module.exports = {
  PLUGIN_CATALOG,
  commandForEngine,
  createPluginInstaller,
  parsePnpmList
}
