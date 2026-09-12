'use strict'

/**
 * 引擎升级器：检测 → 安装到 staging → 关卡 → 提升 → 回滚。
 *
 * 设计要点
 * ────────
 * 1. **版本化目录，绝不碰正在运行的那份。** 引擎装在 `engines/<版本>/`，用一个
 *    `current` 指针文件决定用哪个。安装全程 dsh 照常运行，只有最后重启那 2 秒不可用。
 *    这一条是关键：dsh 运行时会用 `await import()` 延迟加载模块（装插件、profile
 *    热重载都会触发），如果升级时去动它脚下的文件，那些 import 会失败或加载到
 *    新旧混合的状态。版本化目录从根上避免了这个问题。
 *
 * 2. **驱动升级的是外壳，不是 dsh 插件。** 插件活在要被替换的进程里，让它编排自己的
 *    替换等于进程自杀式自我更新。外壳在 dsh 外面，才能干净地杀后端、换指针、重启。
 *
 * 3. **只用公开命令，不改 dsh 一个字节。** 检测/安装交给 npm（复用 App 自带的
 *    node + npm，不额外塞运行时）；验证只用 `--version`、`--profile web --dump-config`、
 *    `web` 三个官方 CLI 能力。所以上游怎么升级都不会破坏这里。
 *
 * 4. **提升前先验证。** 在隔离 DSH_HOME 里跑三道关卡，任一失败就删掉 staging、
 *    什么都不改。最坏情况是「升级失败、继续用旧引擎」，而不是「装坏了打不开」。
 */

const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

/** npm 包名。升级的就是这一个包（它会把前端和 500 个依赖一起带进来）。 */
const PACKAGE = '@deepseek-ai/dsh'

/** 关卡 3 的冷启动超时。实测冷启动到打印 URL 约 2.1 秒，给足余量。 */
const BOOT_TIMEOUT_MS = 45_000

/** 关卡 2（dump-config）超时。 */
const DUMP_TIMEOUT_MS = 60_000

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

function createUpdater(options) {
  const {
    desktopHome,
    nodePath,
    npmCliPath,
    /** 跑关卡时用的隔离 DSH_HOME；不传则临时建一个。 */
    makeTempHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-engine-check-')),
    /**
     * App 自带引擎的版本号（可以是字符串或返回字符串的函数）。
     *
     * 为什么要传进来：回滚要能回答「上一个版本是哪个」。升级前如果用的是自带引擎，
     * 「上一个版本」就是自带的那个版本号，而不是一个叫「自带」的抽象状态 —— 这样
     * 回滚目标始终是一个具体版本，界面也能直接显示版本号。
     */
    bundledVersion: bundledVersionOption,
    log = () => {}
  } = options

  const bundledVersion = () => {
    const value =
      typeof bundledVersionOption === 'function' ? bundledVersionOption() : bundledVersionOption
    return typeof value === 'string' && value.length > 0 ? value : undefined
  }

  const enginesDir = path.join(desktopHome, 'engines')
  const currentFile = path.join(desktopHome, 'current')
  const previousFile = path.join(desktopHome, 'previous')
  const stateFile = path.join(desktopHome, 'state.json')

  // ── 路径与状态 ──────────────────────────────────────────────────────

  function engineDir(version) {
    return path.join(enginesDir, version)
  }

  function engineBinPath(dir) {
    return path.join(dir, 'node_modules', ...PACKAGE.split('/'), 'lib', 'bin.js')
  }

  /** 读某个引擎目录里 dsh 的版本号（以它自己的 package.json 为准）。 */
  function versionOfEngineDir(dir) {
    try {
      const manifest = path.join(dir, 'node_modules', ...PACKAGE.split('/'), 'package.json')
      const raw = JSON.parse(fs.readFileSync(manifest, 'utf8'))
      return typeof raw.version === 'string' ? raw.version : undefined
    } catch {
      return undefined
    }
  }

  function readPointer(file) {
    try {
      const value = fs.readFileSync(file, 'utf8').trim()
      return VERSION_PATTERN.test(value) ? value : undefined
    } catch {
      return undefined
    }
  }

  function writePointer(file, version) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    // 临时文件 + rename：避免读到写了一半的内容
    const temp = `${file}.tmp`
    fs.writeFileSync(temp, `${version}\n`, 'utf8')
    fs.renameSync(temp, file)
  }

  function clearPointer(file) {
    try {
      fs.rmSync(file, { force: true })
    } catch {}
  }

  /**
   * 「上一个版本」= 一个具体的版本号（不是「自带」这种抽象状态）。
   *
   * 升级前用的是自带引擎时，这里记的就是自带引擎的版本号；回滚时再判断那个版本
   * 是「已安装的引擎」还是「App 自带的那份」，从而决定是切指针还是清指针。
   */
  function readPrevious() {
    try {
      const value = fs.readFileSync(previousFile, 'utf8').trim()
      return VERSION_PATTERN.test(value) ? value : undefined
    } catch {
      return undefined
    }
  }

  function writePrevious(version) {
    if (!VERSION_PATTERN.test(version)) return
    writePointer(previousFile, version)
  }

  /** `current` 指向的版本（且目录确实在）。没指向任何版本时返回 undefined。 */
  function currentVersion() {
    const version = readPointer(currentFile)
    if (!version) return undefined
    return fs.existsSync(engineBinPath(engineDir(version))) ? version : undefined
  }

  /**
   * 当前正在使用的引擎版本。
   * `current` 没指时，用调用方给的兜底版本（通常是 App 自带的那个）。
   */
  function runningVersion(fallbackVersion) {
    return currentVersion() ?? fallbackVersion ?? bundledVersion()
  }

  /** 已安装的引擎列表（含大小），按版本倒序。 */
  function listEngines() {
    let names = []
    try {
      names = fs.readdirSync(enginesDir)
    } catch {
      return []
    }
    const active = currentVersion()
    const engines = []
    for (const name of names) {
      if (name.includes('.staging-')) continue
      if (!VERSION_PATTERN.test(name)) continue
      const dir = engineDir(name)
      const bin = engineBinPath(dir)
      if (!fs.existsSync(bin)) continue
      engines.push({
        version: name,
        path: dir,
        active: name === active,
        sizeBytes: directorySize(dir)
      })
    }
    return engines.sort((a, b) => compareVersions(b.version, a.version))
  }

  function directorySize(dir) {
    let total = 0
    const stack = [dir]
    while (stack.length > 0) {
      const current = stack.pop()
      let entries
      try {
        entries = fs.readdirSync(current, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        const full = path.join(current, entry.name)
        try {
          if (entry.isDirectory()) stack.push(full)
          else if (entry.isFile()) total += fs.statSync(full).size
        } catch {}
      }
    }
    return total
  }

  function readState() {
    try {
      return JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    } catch {
      return {}
    }
  }

  function writeState(patch) {
    const next = { ...readState(), ...patch }
    try {
      fs.mkdirSync(desktopHome, { recursive: true })
      fs.writeFileSync(stateFile, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    } catch (error) {
      log('写状态失败:', String(error.message || error))
    }
    return next
  }

  // ── 跑 npm / node ───────────────────────────────────────────────────

  /**
   * 子进程环境。
   *
   * 关键：让 npm 用**它自己的**缓存和配置目录，但继承 HOME，这样 `~/.npmrc` 里的
   * registry / 镜像 / 代理配置能被读到 —— 检测和安装必须走同一份配置，否则会出现
   * 「检测到有新版、安装却拉不到」这种最难查的问题。
   */
  function childEnv(extra = {}) {
    return { ...process.env, ...extra }
  }

  function runNode(args, runOptions = {}) {
    return new Promise((resolve) => {
      const child = spawn(nodePath, args, {
        cwd: runOptions.cwd,
        env: childEnv(runOptions.env),
        stdio: ['ignore', 'pipe', 'pipe']
      })
      let stdout = ''
      let stderr = ''
      const timer = runOptions.timeoutMs
        ? setTimeout(() => {
            try {
              child.kill('SIGKILL')
            } catch {}
          }, runOptions.timeoutMs)
        : undefined

      child.stdout.on('data', (chunk) => {
        stdout += chunk
        runOptions.onStdout?.(chunk.toString())
      })
      child.stderr.on('data', (chunk) => {
        stderr += chunk
        runOptions.onStderr?.(chunk.toString())
      })
      child.on('error', (error) => {
        if (timer) clearTimeout(timer)
        resolve({ code: -1, stdout, stderr: `${stderr}${error.message}` })
      })
      child.on('close', (code) => {
        if (timer) clearTimeout(timer)
        resolve({ code: code ?? -1, stdout, stderr })
      })
    })
  }

  function runNpm(args, runOptions = {}) {
    return runNode([npmCliPath, ...args], runOptions)
  }

  // ── 检测 ────────────────────────────────────────────────────────────

  /**
   * 查有哪些版本可用。
   *
   * 用 `npm view` 而不是直接 fetch registry：这样 registry / 镜像 / 代理配置
   * 和后面的安装走的是同一套（npm 自己读 ~/.npmrc），不会两边不一致。
   */
  async function checkAvailability() {
    const result = await runNpm(
      ['view', PACKAGE, 'dist-tags', '--json', '--loglevel=error'],
      { timeoutMs: 60_000 }
    )

    if (result.code !== 0) {
      return {
        ok: false,
        error: (result.stderr || '').trim() || `npm view 退出码 ${result.code}`
      }
    }

    let tags
    try {
      tags = JSON.parse(result.stdout)
    } catch {
      return { ok: false, error: '无法解析 npm 返回的 dist-tags' }
    }
    if (tags === null || typeof tags !== 'object') {
      return { ok: false, error: 'npm 没有返回 dist-tags' }
    }

    return { ok: true, tags }
  }

  /**
   * 完整检测：当前版本、可用通道、以及该不该提示升级。
   *
   * 注意 dist-tag 只是「发现指针」，不是升级目标 —— 升级时会把它解析成精确版本，
   * 再按精确版本安装（社区升级手册的明确要求）。
   */
  async function check(fallbackVersion) {
    const current = runningVersion(fallbackVersion)
    const availability = await checkAvailability()
    if (!availability.ok) {
      return { ok: false, current, error: availability.error }
    }

    const { tags } = availability
    const latest = typeof tags.latest === 'string' ? tags.latest : undefined
    const hasUpdate =
      latest !== undefined && current !== undefined && compareVersions(latest, current) > 0

    const result = {
      ok: true,
      current,
      tags,
      latest,
      hasUpdate,
      installed: listEngines()
    }
    writeState({
      lastCheckedAt: Date.now(),
      lastKnownLatest: latest,
      lastKnownTags: tags
    })
    return result
  }

  // ── 关卡 ────────────────────────────────────────────────────────────

  /**
   * 在隔离 DSH_HOME 里验证一个引擎目录能不能真的用。
   *
   * 三道关卡，任一失败即判定不可用：
   *   1. `--version`        包完整、入口能加载
   *   2. `--dump-config`    整棵 profile 插件树能组装（内核 + profile 插件这一层）
   *   3. 冷启动              真能起来并打印启动 URL
   *
   * 第 2 关特别有价值：上游改 API 时会出现「装得上但插件树组装不起来」的失败，
   * 它在启动之前就能暴露，而不是等用户用起来才发现。
   */
  async function verifyEngine(dir, expectedVersion, onStep = () => {}) {
    const bin = engineBinPath(dir)
    if (!fs.existsSync(bin)) {
      return { ok: false, gate: 'exists', detail: '引擎入口不存在' }
    }

    const tempHome = makeTempHome()
    const env = { DSH_HOME: tempHome, NO_COLOR: '1' }
    try {
      // ── 关卡 1：--version
      onStep({ gate: 'version', status: 'running' })
      const versionResult = await runNode([bin, '--version'], {
        env,
        cwd: os.tmpdir(),
        timeoutMs: 30_000
      })
      const reported = `${versionResult.stdout}${versionResult.stderr}`.trim().split('\n').pop()?.trim()
      if (versionResult.code !== 0) {
        onStep({ gate: 'version', status: 'failed', detail: versionResult.stderr.slice(0, 400) })
        return { ok: false, gate: 'version', detail: `--version 退出码 ${versionResult.code}` }
      }
      if (expectedVersion !== undefined && reported !== expectedVersion) {
        const detail = `--version 报 ${JSON.stringify(reported)}，期望 ${JSON.stringify(expectedVersion)}`
        onStep({ gate: 'version', status: 'failed', detail })
        return { ok: false, gate: 'version', detail }
      }
      onStep({ gate: 'version', status: 'passed', detail: reported })

      // ── 关卡 2：--dump-config（profile 能组装）
      onStep({ gate: 'dump', status: 'running' })
      const dumpResult = await runNode([bin, '--profile', 'web', '--dump-config'], {
        env,
        cwd: os.tmpdir(),
        timeoutMs: DUMP_TIMEOUT_MS
      })
      if (dumpResult.code !== 0 || dumpResult.stdout.trim() === '') {
        const detail =
          dumpResult.stderr.trim().slice(0, 400) || `--dump-config 退出码 ${dumpResult.code}`
        onStep({ gate: 'dump', status: 'failed', detail })
        return { ok: false, gate: 'dump', detail }
      }
      onStep({
        gate: 'dump',
        status: 'passed',
        detail: `${dumpResult.stdout.trim().split('\n').length} 行`
      })

      // ── 关卡 3：真冷启动一次
      onStep({ gate: 'boot', status: 'running' })
      const boot = await bootOnce(bin, env)
      if (!boot.ok) {
        onStep({ gate: 'boot', status: 'failed', detail: boot.detail })
        return { ok: false, gate: 'boot', detail: boot.detail }
      }
      onStep({ gate: 'boot', status: 'passed', detail: `就绪 ${boot.elapsedMs} ms` })

      return { ok: true }
    } finally {
      try {
        fs.rmSync(tempHome, { recursive: true, force: true })
      } catch {}
    }
  }

  /** 冷启动引擎，等 stdout 出现启动 URL 就杀掉。 */
  function bootOnce(bin, env) {
    return new Promise((resolve) => {
      const started = Date.now()
      const child = spawn(
        nodePath,
        [bin, 'web', '--no-open', '--host', '127.0.0.1', '--port', '0'],
        { env: childEnv(env), cwd: os.tmpdir(), stdio: ['ignore', 'pipe', 'pipe'] }
      )
      let output = ''
      let settled = false

      const finish = (result) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        try {
          child.kill('SIGTERM')
        } catch {}
        // 给它一点时间排空；排空不完也无所谓，这是临时实例
        setTimeout(() => {
          try {
            if (child.exitCode === null) child.kill('SIGKILL')
          } catch {}
        }, 7000).unref?.()
        resolve(result)
      }

      const timer = setTimeout(() => {
        finish({ ok: false, detail: `冷启动超时（${BOOT_TIMEOUT_MS} ms）：${output.slice(-400)}` })
      }, BOOT_TIMEOUT_MS)

      const scan = (chunk) => {
        output += chunk
        if (/dsh web:\s*http:\/\/127\.0\.0\.1:\d+\/\?token=/.test(output)) {
          finish({ ok: true, elapsedMs: Date.now() - started })
        }
      }
      child.stdout.on('data', (chunk) => scan(chunk.toString()))
      child.stderr.on('data', (chunk) => scan(chunk.toString()))
      child.on('error', (error) => finish({ ok: false, detail: error.message }))
      child.on('close', (code) =>
        finish({ ok: false, detail: `进程提前退出（code=${code}）：${output.slice(-400)}` })
      )
    })
  }

  // ── 安装 ────────────────────────────────────────────────────────────

  /**
   * 装一个精确版本到 staging，跑关卡，通过才提升。
   *
   * @param version 精确版本号（不接受 tag —— 调用方应先把 tag 解析成版本）
   */
  async function install(version, hooks = {}) {
    const { onProgress = () => {}, onStep = () => {} } = hooks

    if (!VERSION_PATTERN.test(version)) {
      return { ok: false, error: `不是合法的精确版本号: ${JSON.stringify(version)}` }
    }

    const target = engineDir(version)
    if (fs.existsSync(engineBinPath(target))) {
      // 已经装过这个版本，直接切过去
      onProgress({ phase: 'reuse', message: `已装过 ${version}，直接切换` })
      return promote(version)
    }

    fs.mkdirSync(enginesDir, { recursive: true })
    const staging = path.join(enginesDir, `${version}.staging-${process.pid}-${Date.now()}`)
    fs.mkdirSync(staging, { recursive: true })

    const cleanup = () => {
      try {
        fs.rmSync(staging, { recursive: true, force: true })
      } catch {}
    }

    try {
      // 独立的 package.json，避免 npm 往上层找而装错地方
      fs.writeFileSync(
        path.join(staging, 'package.json'),
        `${JSON.stringify({ name: 'dsh-engine', private: true }, null, 2)}\n`,
        'utf8'
      )

      onProgress({ phase: 'install', message: `正在从 npm 安装 ${PACKAGE}@${version}…` })
      const started = Date.now()

      const result = await runNpm(
        [
          'install',
          `${PACKAGE}@${version}`,
          '--prefix',
          staging,
          '--save-exact', // 钉死，不写 ^（否则以后 npm update 会漂）
          '--ignore-scripts', // 不跑依赖的 postinstall，避免意外的原生编译
          '--no-audit',
          '--no-fund',
          '--loglevel=error'
        ],
        {
          cwd: staging,
          timeoutMs: 15 * 60_000,
          onStderr: (text) => {
            const line = text.trim().split('\n').pop()
            if (line) onProgress({ phase: 'install', message: line.slice(0, 160) })
          }
        }
      )
      // npm 会把进度写在 stderr，这里已经通过 onStderr 转出去了

      if (result.code !== 0) {
        cleanup()
        return {
          ok: false,
          phase: 'install',
          error: (result.stderr || result.stdout).trim().slice(0, 600) || `退出码 ${result.code}`
        }
      }
      onProgress({
        phase: 'install',
        message: `安装完成（${Math.round((Date.now() - started) / 1000)} 秒）`
      })

      // 校验装出来的确实是目标版本
      const installedVersion = versionOfEngineDir(staging)
      if (installedVersion !== version) {
        cleanup()
        return {
          ok: false,
          phase: 'install',
          error: `安装后版本是 ${JSON.stringify(installedVersion)}，期望 ${JSON.stringify(version)}`
        }
      }

      // ── 关卡
      onProgress({ phase: 'verify', message: '在隔离环境里验证新引擎…' })
      const verification = await verifyEngine(staging, version, onStep)
      if (!verification.ok) {
        cleanup()
        return { ok: false, phase: 'verify', ...verification }
      }

      // ── 提升
      onProgress({ phase: 'promote', message: '验证通过，正在切换…' })
      fs.renameSync(staging, target)
      const promoted = promote(version)
      onProgress({ phase: 'done', message: `已升级到 ${version}` })
      return { ok: true, version, ...promoted }
    } catch (error) {
      cleanup()
      return { ok: false, phase: 'install', error: String(error.message || error) }
    }
  }

  /**
   * 把 `current` 指向某个已装好的版本，并记住上一个版本用于回滚。
   * 注意这里只改指针，不动任何引擎文件。
   */
  function promote(version) {
    // 记下「切换前在用的版本」——可能是已装引擎，也可能是自带引擎的版本号
    const before = currentVersion() ?? bundledVersion()
    if (before !== undefined && before !== version) writePrevious(before)
    writePointer(currentFile, version)
    writeState({ lastPromotedAt: Date.now(), lastPromotedVersion: version })
    // 指针写完之后才清理，保证 keep 集合里那两个一定是当前状态
    const pruned = pruneEngines()
    return { previous: before, pruned }
  }

  /**
   * 回滚到上一个版本。
   *
   * 「上一个版本」是一个具体版本号，回滚时按它的归属分两种情况：
   *   · 它是已安装的引擎（engines/<版本>/ 在）→ 把 current 切过去
   *   · 它是 App 自带的那份（版本号等于自带引擎）→ 清掉 current 指针
   */
  function rollback() {
    const previous = readPrevious()
    if (previous === undefined) {
      return { ok: false, error: '还没有记录到上一个版本' }
    }

    const active = currentVersion() ?? bundledVersion()

    if (fs.existsSync(engineBinPath(engineDir(previous)))) {
      writePointer(currentFile, previous)
      if (active !== undefined && active !== previous) writePrevious(active)
      return { ok: true, version: previous, target: 'engine' }
    }

    if (bundledVersion() !== undefined && previous === bundledVersion()) {
      clearPointer(currentFile)
      if (active !== undefined && active !== previous) writePrevious(active)
      return { ok: true, version: previous, target: 'bundled' }
    }

    return {
      ok: false,
      error: `上一个版本 ${previous} 已经不在了（既没安装在 engines/ 里，也不是 App 自带的 ${bundledVersion() ?? '未知'} 版本）`
    }
  }

  /** 回到 App 自带的引擎（删掉 current 指针即可）。 */
  function useBundled() {
    const active = currentVersion() ?? bundledVersion()
    clearPointer(currentFile)
    if (active !== undefined) writePrevious(active)
    return { ok: true, previous: active }
  }

  /** 上一个状态（供界面显示「可回滚到 …」）。 */
  function previousState() {
    return readPrevious()
  }

  /** 删掉某个引擎版本。不允许删当前正在用的那个。 */
  function removeEngine(version) {
    if (!VERSION_PATTERN.test(version)) return { ok: false, error: '版本号不合法' }
    if (version === currentVersion()) return { ok: false, error: '不能删除当前正在使用的版本' }
    const dir = engineDir(version)
    if (!fs.existsSync(dir)) return { ok: false, error: '这个版本没有装' }
    try {
      fs.rmSync(dir, { recursive: true, force: true })
      return { ok: true }
    } catch (error) {
      return { ok: false, error: String(error.message || error) }
    }
  }

  /**
   * 只保留「当前在用的」和「上一个」两个引擎目录，其余全删。
   *
   * 为什么不保留全部历史：一个引擎版本约 280MB，而**能回滚的只有一步** ——
   * `rollback()` 只认 `previous` 这一个指针。留着第三代、第四代除了占磁盘没有任何
   * 用途，所以每次切换完顺手清掉。
   *
   * `previous` 如果是 App 自带引擎的版本号（第一次升级之后就是这种情况），
   * 它在 engines/ 里本来就没有目录，保留集合里带着它也无害 —— 自带那份在 App 包里，
   * 永远不会被这里删掉。
   *
   * 只在指针**已经写完**之后调用，否则可能把马上要用的那个目录删掉。
   */
  function pruneEngines() {
    const keep = new Set([currentVersion(), readPrevious()].filter((v) => v !== undefined))
    const removed = []
    let freedBytes = 0
    for (const engine of listEngines()) {
      if (keep.has(engine.version)) continue
      try {
        fs.rmSync(engine.path, { recursive: true, force: true })
        removed.push(engine.version)
        freedBytes += engine.sizeBytes
      } catch (error) {
        // 删不掉不算失败：磁盘多占一点，但绝不能因此让升级流程报错。
        log(`删除旧引擎 ${engine.version} 失败:`, String(error?.message || error))
      }
    }
    return { removed, freedBytes }
  }

  /** 清掉残留的 staging 目录（上次安装中途退出的）。 */
  function cleanStaging() {
    let removed = 0
    try {
      for (const name of fs.readdirSync(enginesDir)) {
        if (!name.includes('.staging-')) continue
        try {
          fs.rmSync(path.join(enginesDir, name), { recursive: true, force: true })
          removed += 1
        } catch {}
      }
    } catch {}
    return removed
  }

  return {
    PACKAGE,
    engineDir,
    engineBinPath,
    currentVersion,
    runningVersion,
    listEngines,
    pruneEngines,
    readState,
    checkAvailability,
    check,
    verifyEngine,
    install,
    promote,
    rollback,
    previousState,
    useBundled,
    removeEngine,
    cleanStaging
  }
}

/**
 * semver 比较，够用即可（支持 prerelease：1.0.0-rc.2 > 1.0.0-rc.1，正式版 > 任何 rc）。
 * 只用于「有没有新版」这类判断，不参与安装决策 —— 安装始终按精确版本。
 */
function compareVersions(a, b) {
  const split = (value) => {
    const [core = '', ...pre] = String(value).trim().split('-')
    const nums = core.split('.').map((n) => Number.parseInt(n, 10) || 0)
    while (nums.length < 3) nums.push(0)
    return { nums, pre: pre.join('-') }
  }
  const left = split(a)
  const right = split(b)
  for (let i = 0; i < Math.max(left.nums.length, right.nums.length); i += 1) {
    const x = left.nums[i] ?? 0
    const y = right.nums[i] ?? 0
    if (x !== y) return x < y ? -1 : 1
  }
  // 无 prerelease 的正式版排在任何 prerelease 之上
  if (left.pre === '' && right.pre !== '') return 1
  if (left.pre !== '' && right.pre === '') return -1
  if (left.pre === right.pre) return 0

  const xs = left.pre.split('.')
  const ys = right.pre.split('.')
  for (let i = 0; i < Math.max(xs.length, ys.length); i += 1) {
    const x = xs[i]
    const y = ys[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xNum = /^\d+$/.test(x)
    const yNum = /^\d+$/.test(y)
    if (xNum && yNum) {
      const dx = Number(x)
      const dy = Number(y)
      if (dx !== dy) return dx < dy ? -1 : 1
      continue
    }
    if (xNum) return -1
    if (yNum) return 1
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

module.exports = { createUpdater, compareVersions, PACKAGE }
