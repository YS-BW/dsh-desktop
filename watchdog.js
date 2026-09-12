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
 * 用法：node watchdog.js <parentPid> <backendPid>
 */

const [, , parentPidArg, backendPidArg] = process.argv
const parentPid = Number(parentPidArg)
const backendPid = Number(backendPidArg)

if (!Number.isInteger(parentPid) || !Number.isInteger(backendPid)) process.exit(0)

const INTERVAL_MS = 1500
/** 壳还没起来完就被判定死亡的时间余量。 */
const GRACE_MS = 2000
const startedAt = Date.now()

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function shutdown(pid) {
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    return
  }
  // DSH 自己给 5 秒排空（PROCESS_SHUTDOWN_TIMEOUT_MS = 5e3），等 7 秒再强杀。
  const deadline = Date.now() + 7000
  const timer = setInterval(() => {
    if (!alive(pid)) {
      clearInterval(timer)
      process.exit(0)
    }
    if (Date.now() > deadline) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {}
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
