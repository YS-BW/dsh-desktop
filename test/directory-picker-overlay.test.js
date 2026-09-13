'use strict'

/**
 * Desktop 不能依赖后端子进程弹出的原生目录框：在嵌入式 Electron 窗口下它可能
 * 不会获得焦点。这个测试让真实 DSH 解析壳随附的官方 --patch 覆盖层，确认自动
 * 选择器被禁用，并改由官方的 host + client 浏览组件接管。
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const test = require('node:test')

const ROOT = path.join(__dirname, '..')
const patch = path.join(ROOT, 'desktop-directory-picker.patch.yml')
const dshBin = require.resolve('@deepseek-ai/dsh/lib/bin.js')

test('Desktop overlay pins DSH to the in-app directory browser', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-desktop-picker-test-'))
  try {
    const result = spawnSync(process.execPath, [dshBin, 'web', '--patch', patch, '--dump-config'], {
      encoding: 'utf8',
      env: { ...process.env, DSH_HOME: home },
      timeout: 15000
    })

    assert.equal(result.status, 0, `DSH 应接受目录选择器覆盖层：${result.stderr}`)
    const config = result.stdout
    assert.match(
      config,
      /id: directory-picker\n\s+name: '@deepseek-ai\/dsh-host-directory-picker-auto'\n\s+disabled: true/,
      '必须禁用自动选择器，避免它弹出失焦的系统目录框'
    )
    assert.match(config, /id: directory-picker-browse\n\s+name: '@deepseek-ai\/dsh-host-directory-picker-browse'/)
    assert.match(config, /id: ui-directory-picker-browse\n\s+name: '@deepseek-ai\/dsh-client-ui-directory-picker-browse'/)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})
