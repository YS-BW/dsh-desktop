'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')
const { resolveDshHome, resolveDesktopHome, resolveWorkspace } = require('../runtime-paths')

test('macOS directories derive from the current home, never a developer-specific path', () => {
  const osModule = { homedir: () => '/Users/another-person' }
  const app = { getPath: (name) => (name === 'documents' ? '/Users/another-person/Documents' : undefined) }

  assert.equal(resolveDshHome({ env: {}, osModule, pathModule: path.posix }), '/Users/another-person/.dsh')
  assert.equal(resolveDesktopHome({ env: {}, osModule, pathModule: path.posix }), '/Users/another-person/.dsh-desktop')
  assert.equal(resolveWorkspace({ env: {}, app, osModule, pathModule: path.posix }), '/Users/another-person/Documents/DSH')
})

test('Windows directories use the active profile and the system documents location', () => {
  const osModule = { homedir: () => 'C:\\Users\\Ada' }
  const app = { getPath: (name) => (name === 'documents' ? 'C:\\Users\\Ada\\OneDrive\\Documents' : undefined) }

  assert.equal(resolveDshHome({ env: {}, osModule, pathModule: path.win32 }), 'C:\\Users\\Ada\\.dsh')
  assert.equal(resolveDesktopHome({ env: {}, osModule, pathModule: path.win32 }), 'C:\\Users\\Ada\\.dsh-desktop')
  assert.equal(resolveWorkspace({ env: {}, app, osModule, pathModule: path.win32 }), 'C:\\Users\\Ada\\OneDrive\\Documents\\DSH')
})

test('explicit directory overrides take precedence on either platform', () => {
  const env = {
    DSH_MIN_HOME: 'D:\\dsh-data',
    DSH_MIN_DESKTOP_HOME: 'D:\\desktop-data',
    DSH_MIN_WORKSPACE: 'D:\\projects\\workspace'
  }
  const options = { env, app: { getPath: () => 'ignored' }, osModule: { homedir: () => 'ignored' }, pathModule: path.win32 }

  assert.equal(resolveDshHome(options), 'D:\\dsh-data')
  assert.equal(resolveDesktopHome(options), 'D:\\desktop-data')
  assert.equal(resolveWorkspace(options), 'D:\\projects\\workspace')
})
