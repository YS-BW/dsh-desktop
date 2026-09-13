'use strict'

/**
 * 运行期目录的唯一入口。
 *
 * 不使用用户名、盘符或安装目录猜路径。`os.homedir()` 在 macOS / Windows 上都会
 * 返回当前登录用户的主目录；工作区则优先交给 Electron 查询操作系统登记的“文档”
 * 目录，能正确处理 Windows 的 OneDrive 重定向和非英文用户目录。
 */

const os = require('node:os')
const path = require('node:path')

function resolveOverride(env, name, fallback, pathModule = path) {
  const value = env?.[name]
  return value ? pathModule.resolve(value) : fallback()
}

function resolveDshHome({ env = process.env, osModule = os, pathModule = path } = {}) {
  return resolveOverride(env, 'DSH_MIN_HOME', () => pathModule.join(osModule.homedir(), '.dsh'), pathModule)
}

function resolveDesktopHome({ env = process.env, osModule = os, pathModule = path } = {}) {
  return resolveOverride(
    env,
    'DSH_MIN_DESKTOP_HOME',
    () => pathModule.join(osModule.homedir(), '.dsh-desktop'),
    pathModule
  )
}

function resolveWorkspace({ env = process.env, app, osModule = os, pathModule = path } = {}) {
  return resolveOverride(
    env,
    'DSH_MIN_WORKSPACE',
    () => {
      let documents
      try {
        documents = app?.getPath('documents')
      } catch {}
      // 早期启动或诊断态拿不到 Electron 路径时仍有跨平台的可用兜底。
      const base = typeof documents === 'string' && documents ? documents : pathModule.join(osModule.homedir(), 'Documents')
      return pathModule.join(base, 'DSH')
    },
    pathModule
  )
}

module.exports = { resolveDshHome, resolveDesktopHome, resolveWorkspace }
