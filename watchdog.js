'use strict'

/**
 * 看门狗：盯着父进程（Electron 壳），壳一死就把后端收干净。
 *
 * 为什么不用 Electron 的 before-quit：壳可能被 `kill -9`、崩溃、或被系统强制结束，
 * 那时任何信号处理器都不会运行 —— 实测确实会留下占着端口的孤儿后端。
 *
 * 为什么单独起一个进程：这个看门狗自己必须活得比壳的处理逻辑更“抗造”。它不依赖
 * 任何 IPC，只轮询父进程是否还在（`process.kill(pid, 0)`），壳一消失就收尸，
 * 然后自己退出。
 *
 * 平台差异（重要）：
 *   · POSIX：先 SIGTERM 给 dsh 那 5 秒排空，7 秒后再 SIGKILL。
 *   · Windows：**没有可送达的 SIGTERM** —— `process.kill(pid, 'SIGTERM')` 在那边就是
 *     `TerminateProcess`，dsh 的 SIGTERM 处理器不会被调用；而且它派生的子孙进程
 *     （工具调用的 pwsh、rg 等）会全部活下来。所以那边直接
 *     `taskkill /pid <pid> /t /f`，`/t` 才是关键。
 *
 * 用法：node watchdog.js <parentPid> <backendPid>
 */

const { killProcessTree } = require('./platform')

const [, , parentPidArg, backendPidArg] = process.argv
const parentPid = Number(parentPidArg)
const backendPid = Number(backendPidArg)

if (!Number.isInteger(parentPid) || !Number.isInteger(backendPid)) process.exit(0)

const isWindows = process.platform === 'win32'

const INTERVAL_MS = 1500
/** 壳还没起来完就被判定死亡的时间余量。 */
const GRACE_MS = 2000
const startedAt = Date.now()

function alive(pid) {
  try {
    // signal 0 在 Windows 上也受支持：只做存在性探测，不真的发信号。
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** 第一次终止：POSIX 上给 dsh 一点排空时间；Windows 上只能连树一起收。 */
function terminate(pid) {
  if (isWindows) return killProcessTree(pid, { force: true })
  try {
    process.kill(pid, 'SIGTERM')
    return true
  } catch {
    return false
  }
}

/** 兜底强杀。 */
function forceKill(pid) {
  if (isWindows) killProcessTree(pid, { force: true })
  try {
    process.kill(pid, 'SIGKILL')
  } catch {}
}

function shutdown(pid) {
  if (!terminate(pid)) return
  // POSIX：DSH 自己给 5 秒排空（PROCESS_SHUTDOWN_TIMEOUT_MS = 5e3），等 7 秒再强杀。
  // Windows：上面那步已经是强制终止，这里的 7 秒只是「taskkill 没生效」的兜底。
  const deadline = Date.now() + 7000
  const timer = setInterval(() => {
    if (!alive(pid)) {
      clearInterval(timer)
      process.exit(0)
    }
    if (Date.now() > deadline) {
      forceKill(pid)
      clearInterval(timer)
      process.exit(0)
    }
  }, 200)
}

const tick = setInterval(() => {
  // 后端起得比壳晚，给一点余地再开始判定。
  if (Date.now() - startedAt < GRACE_MS) return
  if (!alive(backendPid)) {
    clearInterval(tick)
    process.exit(0) // 后端自己退了，没我们的事
  }
  if (!alive(parentPid)) {
    clearInterval(tick)
    shutdown(backendPid) // 壳没了 → 收尸
  }
}, INTERVAL_MS)
