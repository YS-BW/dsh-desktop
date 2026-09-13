'use strict'

/**
 * 平台差异集中在这里:路径/环境变量的键名、可执行文件解析、进程树终止、命令 shim。
 *
 * 为什么单独一个文件:这些差异点散落在 main.js / updater.js / plugin-installer.js 里
 * 各写一遍,就等于把一个 Windows 特有的坑复制三份。集中之后既好审、也能用单元测试
 * 直接覆盖 —— Windows 行为在一台 Windows 机器上跑 `npm test` 就能验证,不需要打包。
 *
 * 三个真实的坑(都在下面实现里处理):
 *   1. **环境变量名大小写**:Windows 上环境变量大小写不敏感,但 Node 原样保留进程
 *      环境里的键名(通常是 `Path`)。`env.PATH = x` 会造出第二个键,子进程可能拿到
 *      旧值或者干脆丢掉 PATH。
 *   2. **可执行判定**:POSIX 看 X_OK 位;Windows 没有这个位,任何文件都"可执行",
 *      真正的判据是后缀在当前 PATHEXT 里(所以 `dsh` 不是命令、`dsh.cmd` 才是)。
 *   3. **进程树**:Windows 没有"给进程组发信号"这回事,只杀父进程会留下孙子进程,
 *      必须走 `taskkill /t`。
 */

const fs = require('node:fs')
const path = require('node:path')
const net = require('node:net')
const { spawn } = require('node:child_process')

const isWindows = process.platform === 'win32'

/** Windows 上这个键名通常长成 `Path`,而不是 `PATH`。 */
const PATH_KEY = isWindows ? 'Path' : 'PATH'

/**
 * 按平台语义读一个环境变量。
 *
 * POSIX 上精确匹配(那里 `Path` 和 `PATH` 是两个不同的变量);
 * Windows 上忽略大小写 —— 进程环境里的键名取决于谁启动的我们,不能假定。
 */
function envValue(env, name) {
  if (!env) return undefined
  if (!isWindows) return env[name]
  const target = name.toUpperCase()
  for (const [key, value] of Object.entries(env)) {
    if (key.toUpperCase() === target) return value
  }
  return undefined
}

/** 读 PATH,不管键名写成 `Path` 还是 `PATH`。 */
function envPath(env = process.env) {
  return envValue(env, 'PATH') || ''
}

/**
 * 写 PATH,并保证环境块里只有一个 PATH 键。
 *
 * 先删掉所有大小写变体再写规范键:否则会出现 `Path`(旧值)与 `PATH`(新值)并存,
 * 而 Windows 取哪一个是不确定的 —— 这正是"明明拼了 PATH 子进程还是找不到命令"的成因。
 */
function setEnvPath(env, value) {
  const target = PATH_KEY.toUpperCase()
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === target) delete env[key]
  }
  env[PATH_KEY] = value
  return env
}

/** 把一个目录追加到 PATH 最前面(保持只有一个 PATH 键)。 */
function prependEnvPath(env, dir) {
  const current = envPath(env)
  const parts = [dir, ...current.split(path.delimiter)].filter(Boolean)
  return setEnvPath(env, parts.join(path.delimiter))
}

/** Windows 的可执行后缀表;其它平台返回空后缀(占位,便于统一处理)。 */
function executableExtensions(env = process.env) {
  if (!isWindows) return ['']
  const raw = envValue(env, 'PATHEXT') || '.COM;.EXE;.BAT;.CMD'
  return raw
    .split(';')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

/**
 * 这个路径是不是一个可以直接执行的命令。
 *
 * POSIX:文件 + X_OK。
 * Windows:文件 + 后缀在 PATHEXT 里 —— 无后缀的文件(比如 npm 全局目录里的
 * `dsh` 那个 0 字节占位壳)不算命令,`dsh.cmd` 才算。
 */
function isExecutableFile(candidate, env = process.env) {
  try {
    if (!fs.statSync(candidate).isFile()) return false
  } catch {
    return false
  }
  if (!isWindows) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      return true
    } catch {
      return false
    }
  }
  // statSync 拿到的后缀大小写取决于真实文件名,而 PATHEXT 里通常是大写,
  // 所以两边都归一化再比。
  const ext = path.extname(candidate).toUpperCase()
  return ext !== '' && executableExtensions(env).some((entry) => entry.toUpperCase() === ext)
}

/**
 * 在 PATH 里找一个命令,返回可直接 spawn 的绝对路径。
 *
 * Windows 上按 PATHEXT 逐个后缀试(`dsh` → `dsh.cmd`);文件系统大小写不敏感,
 * 所以统一用小写后缀去试,命中的真实文件可能是 `.CMD`。
 */
function findExecutableIn(searchPath, name, env = process.env) {
  if (!searchPath) return undefined
  const names = isWindows && path.extname(name) === ''
    ? executableExtensions(env).map((ext) => `${name}${ext.toLowerCase()}`)
    : [name]
  for (const dir of searchPath.split(path.delimiter)) {
    if (!dir) continue
    for (const candidate of names) {
      const full = path.join(dir, candidate)
      if (isExecutableFile(full, env)) return full
    }
  }
  return undefined
}

/**
 * 终止一棵进程树。**只在 Windows 上做额外动作**,POSIX 保持调用方原有的信号阶梯。
 *
 * 为什么要 `/t`:dsh 会再派生子孙进程(工具调用的 pwsh、rg sidecar 等)。Windows 上
 * 只杀 dsh 自己的 pid,那些孙子进程会活下来继续占着工作目录和文件句柄 —— 表现是
 * "壳退了但目录删不掉""后台还有 node 在跑"。
 *
 * `spawnImpl` 可注入,便于单测断言参数(否则测试会真的去杀进程)。
 *
 * @returns 是否发起了终止动作(Windows 上总返回 true;其它平台返回 false,交由调用方)。
 */
function killProcessTree(pid, { force = true, spawnImpl = spawn } = {}) {
  if (!isWindows) return false
  if (!Number.isInteger(pid) || pid <= 0) return false
  const args = ['/pid', String(pid), '/t', ...(force ? ['/f'] : [])]
  try {
    // windowsHide:GUI 进程里 spawn 控制台程序会凭空弹一个黑窗。
    const killer = spawnImpl('taskkill', args, { windowsHide: true, stdio: 'ignore' })
    killer.unref?.()
    return true
  } catch {
    return false
  }
}

/**
 * 生成一个 Windows 命令 shim(`.cmd`)的脚本内容。
 *
 * 为什么需要:pnpm / dsh 这类命令在 Windows 上不是可执行文件,`.cmd` 才是。
 * 而在 `%DESKTOP_HOME%\bin` 里放符号链接是行不通的 —— 建符号链接需要管理员权限
 * 或开发者模式,普通安装的机器两者都没有(实测报"此操作需要管理员权限")。
 * 写一个真文件则不需要任何特权。
 *
 * `%~dp0` 不行:shim 和目标可能不在同一棵树里,所以这里写绝对路径(带引号兼容空格)。
 */
function commandShimScript(nodePath, scriptPath) {
  return [
    '@echo off',
    'setlocal',
    `"${nodePath}" "${scriptPath}" %*`,
    'exit /b %ERRORLEVEL%',
    ''
  ].join('\r\n')
}

/**
 * 原子地写一个 shim 文件(临时文件 + rename)。
 * 目标已存在也能覆盖:Node 在 Windows 上用 MoveFileEx(REPLACE_EXISTING)。
 */
function writeFileAtomic(target, content) {
  const temp = `${target}.tmp-${process.pid}`
  fs.writeFileSync(temp, content, 'utf8')
  try {
    fs.renameSync(temp, target)
  } catch (error) {
    try {
      fs.rmSync(temp, { force: true })
    } catch {}
    throw error
  }
  return target
}

/**
 * 给固定端口用:这个端口现在能不能监听。
 *
 * 只探回环地址 —— 后端也只绑 127.0.0.1,探测口径和实际绑定口径必须一致。
 */
function isPortAvailable(port, { host = '127.0.0.1', timeoutMs = 1000 } = {}) {
  return new Promise((resolve) => {
    const probe = net.createServer()
    let settled = false
    const finish = (available) => {
      if (settled) return
      settled = true
      try {
        probe.close()
      } catch {}
      resolve(available)
    }
    probe.once('error', () => finish(false))
    probe.once('listening', () => finish(true))
    probe.listen({ port, host, exclusive: true })
    setTimeout(() => finish(false), timeoutMs).unref?.()
  })
}

/**
 * 命令入口的**决策**:在某个平台上，这个命令应该长成什么样。
 *
 * 单独拆出来是为了可测:决策(写 shim 还是建链接、命令叫 `pnpm` 还是 `pnpm.cmd`)
 * 在任意平台上都能断言，而副作用才依赖真实平台能力 —— Windows 上建符号链接需要
 * 管理员权限，测试里没法凭空造出那个权限。
 */
function commandEntryPlan({ binDir, name, platform = process.platform }) {
  if (!binDir || !name) throw new TypeError('commandEntryPlan 需要 binDir 和 name')
  if (platform === 'win32') {
    // Windows 上命令必须是带 PATHEXT 后缀的真实文件
    return { kind: 'shim', command: path.join(binDir, `${name}.cmd`) }
  }
  return { kind: 'symlink', command: path.join(binDir, name) }
}

/**
 * 在 `binDir` 里准备一个名为 `name` 的命令入口。
 *
 * Windows:写 `.cmd` shim —— **不能用符号链接**。建符号链接需要管理员权限或开发者
 * 模式,普通机器两者都没有(实测报"此操作需要管理员权限"),而写一个真文件不需要
 * 任何特权。
 * POSIX:仍然是符号链接(保持原行为),目标脚本自带 shebang 和执行位。
 */
function ensureCommandEntry({
  binDir,
  name,
  scriptPath,
  nodePath,
  platform = process.platform
}) {
  if (!scriptPath) throw new TypeError('ensureCommandEntry 需要 scriptPath')
  const { kind, command } = commandEntryPlan({ binDir, name, platform })
  fs.mkdirSync(binDir, { recursive: true })

  if (kind === 'shim') {
    if (!nodePath) throw new Error('Windows 上的命令 shim 需要一个 node 可执行文件')
    writeFileAtomic(command, commandShimScript(nodePath, scriptPath))
    return { command, binDir, kind }
  }

  const temp = `${command}.tmp-${process.pid}`
  fs.rmSync(temp, { force: true })
  fs.symlinkSync(scriptPath, temp)
  try {
    fs.renameSync(temp, command)
  } catch (error) {
    try {
      fs.rmSync(temp, { force: true })
    } catch {}
    throw error
  }
  return { command, binDir, kind }
}

/**
 * 选定后端端口:优先用固定端口,被占用就回落 0(让系统分配)。
 *
 * 为什么要固定:`--port 0` 每次都是新端口,而 dsh 的会话 cookie 名是
 * `dsh-auth-<sha256(host:port)>` —— 端口进了哈希,于是每次启动都留一条新 cookie,
 * 攒够了(实测 64 条约 3.4KB)会顶穿 Node 的 16KB 请求头上限,返回 HTTP 431,
 * 表现为"插件全加载不出来"。固定端口从根上不再累积。
 *
 * 失败一律回落 0:启动后端绝不能因为"探测端口"这件事而失败。
 */
async function choosePort(preferred, options = {}) {
  if (!Number.isInteger(preferred) || preferred <= 0 || preferred > 65535) return 0
  try {
    return (await isPortAvailable(preferred, options)) ? preferred : 0
  } catch {
    return 0
  }
}

module.exports = {
  isWindows,
  PATH_KEY,
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
  isPortAvailable,
  choosePort
}
