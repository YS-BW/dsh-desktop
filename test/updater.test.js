'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { createUpdater } = require('../updater')

function makeEngine(updater, version) {
  const bin = updater.engineBinPath(updater.engineDir(version))
  fs.mkdirSync(path.dirname(bin), { recursive: true })
  fs.writeFileSync(bin, '')
}

test('reusing an installed engine reports success and updates rollback state', async (t) => {
  const desktopHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-updater-test-'))
  t.after(() => fs.rmSync(desktopHome, { recursive: true, force: true }))
  const updater = createUpdater({
    desktopHome,
    nodePath: process.execPath,
    npmCliPath: '/unused',
    bundledVersion: '0.9.0'
  })

  makeEngine(updater, '1.0.0')
  updater.promote('1.0.0')
  makeEngine(updater, '2.0.0')

  const result = await updater.install('2.0.0')
  assert.equal(result.ok, true)
  assert.equal(result.reused, true)
  assert.equal(result.version, '2.0.0')
  assert.equal(updater.currentVersion(), '2.0.0')
  assert.equal(updater.previousState(), '1.0.0')
  assert.equal('sizeBytes' in updater.listEngines()[0], false)
  assert.equal(typeof updater.listEngines({ includeSize: true })[0].sizeBytes, 'number')
})

test('stale rollback target from an older bundled engine is removed after app reinstall', (t) => {
  const desktopHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-updater-test-'))
  t.after(() => fs.rmSync(desktopHome, { recursive: true, force: true }))
  const updater = createUpdater({
    desktopHome,
    nodePath: process.execPath,
    npmCliPath: '/unused',
    bundledVersion: '0.1.5-rc.1'
  })

  makeEngine(updater, '0.1.5-rc.1')
  fs.writeFileSync(path.join(desktopHome, 'current'), '0.1.5-rc.1\n')
  fs.writeFileSync(path.join(desktopHome, 'previous'), '0.1.2-rc.1\n')

  assert.equal(updater.previousState(), undefined)
  const result = updater.reconcilePointers()
  assert.deepEqual(result.corrected, ['previous=0.1.2-rc.1'])
  assert.equal(fs.existsSync(path.join(desktopHome, 'previous')), false)
  assert.equal(updater.currentVersion(), '0.1.5-rc.1')
})

test('rollback keeps working when the previous engine really exists', (t) => {
  const desktopHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-updater-test-'))
  t.after(() => fs.rmSync(desktopHome, { recursive: true, force: true }))
  const updater = createUpdater({
    desktopHome,
    nodePath: process.execPath,
    npmCliPath: '/unused',
    bundledVersion: '0.1.5-rc.1'
  })

  makeEngine(updater, '0.1.5-rc.1')
  makeEngine(updater, '0.1.2-rc.1')
  fs.writeFileSync(path.join(desktopHome, 'current'), '0.1.5-rc.1\n')
  fs.writeFileSync(path.join(desktopHome, 'previous'), '0.1.2-rc.1\n')

  assert.equal(updater.previousState(), '0.1.2-rc.1')
  const result = updater.rollback()
  assert.deepEqual(result, { ok: true, version: '0.1.2-rc.1', target: 'engine' })
  assert.equal(updater.currentVersion(), '0.1.2-rc.1')
  assert.equal(updater.previousState(), '0.1.5-rc.1')
})
