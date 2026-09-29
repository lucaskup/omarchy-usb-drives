// Runs the real scripts against real udisks, using throwaway loop devices
// instead of USB hardware. Opt-in, because it needs a desktop session that
// udisks trusts (active local seat) plus cryptsetup and gdbus:
//
//   USB_DRIVES_INTEGRATION=1 npm run test:integration
//
// Loop devices cannot be powered off, so eject.sh is expected to get all the
// way to power-off and fail only there.
import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { loadModel, pluginDir } from '../helpers/model.mjs'

const enabled = process.env.USB_DRIVES_INTEGRATION === '1'
const skip = !enabled && 'set USB_DRIVES_INTEGRATION=1 to run'
// udiskie (running on Omarchy by default) opens a passphrase dialog for every
// new LUKS device, including our throwaway image. Skip that test unless asked.
const udiskieRunning = spawnSync('pgrep', ['-f', 'bin/udiskie']).status === 0
const luksSkip = udiskieRunning && process.env.USB_DRIVES_INTEGRATION_LUKS !== '1' &&
  'udiskie is running and would pop up a passphrase dialog for the test image; ' +
  'set USB_DRIVES_INTEGRATION_LUKS=1 to run anyway (then cancel the dialog)'
const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' })
const script = (name) => path.join(pluginDir, 'scripts', name)
const lsblk = (dev, cols) => sh('lsblk', ['-lnpo', cols, dev]).trim().split('\n')

let work
const loops = []

// Format through udisks so no root is needed.
function format(dev, fstype, label) {
  const obj = sh('udisksctl', ['info', '-b', dev]).split('\n')[0].replace(/:$/, '')
  sh('gdbus', ['call', '--system', '--dest', 'org.freedesktop.UDisks2', '--object-path', obj,
    '--method', 'org.freedesktop.UDisks2.Block.Format', fstype,
    `{'label': <'${label}'>, 'auth.no_user_interaction': <true>}`])
}

function loopSetup(file) {
  const out = sh('udisksctl', ['loop-setup', '-f', file, '--no-user-interaction'])
  const dev = out.match(/\/dev\/loop\d+/)[0]
  loops.push(dev)
  return dev
}

// A running udiskie (as on Omarchy) may automount a freshly formatted
// volume first; accept that, otherwise mount it ourselves.
function mountIt(dev) {
  const current = () => lsblk(dev, 'MOUNTPOINT').filter(Boolean)[0]
  if (waitFor(current, 1500)) return current()
  const r = spawnSync('udisksctl', ['mount', '-b', dev, '--no-user-interaction'], { encoding: 'utf8' })
  if (r.status !== 0 && !/AlreadyMounted/.test(r.stderr)) throw new Error(r.stderr)
  assert.ok(waitFor(current), `${dev} did not mount`)
  return current()
}

function waitFor(check, ms = 5000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (check()) return true
    spawnSync('sleep', ['0.2'])
  }
  return false
}

describe('against real udisks', { skip }, () => {
  before(() => { work = fs.mkdtempSync(path.join(os.tmpdir(), 'usb-drives-it-')) })
  after(() => {
    for (const dev of loops) spawnSync('udisksctl', ['loop-delete', '-b', dev, '--no-user-interaction'])
    if (work) fs.rmSync(work, { recursive: true, force: true })
  })

  test('eject.sh unmounts and locks a LUKS volume', { skip: luksSkip }, () => {
    const img = path.join(work, 'luks.img')
    const key = path.join(work, 'key')
    fs.writeFileSync(key, 'integration-test')
    sh('truncate', ['-s', '64M', img])
    sh('cryptsetup', ['luksFormat', '-q', '--type', 'luks2', '--pbkdf', 'pbkdf2',
      '--pbkdf-force-iterations', '1000', '--key-file', key, img])
    const dev = loopSetup(img)
    const clear = sh('udisksctl', ['unlock', '-b', dev, '--key-file', key, '--no-user-interaction']).match(/\/dev\/dm-\d+/)[0]
    format(clear, 'vfat', 'ITLUKS')
    mountIt(clear)
    assert.ok(lsblk(dev, 'TYPE').includes('crypt'), 'volume should be unlocked before eject')

    const r = spawnSync('bash', [script('eject.sh'), dev], { encoding: 'utf8' })
    assert.notEqual(r.status, 0, 'loop devices cannot be powered off')
    assert.match(r.stderr, /drive|power/i, `expected a power-off error, got: ${r.stderr}`)
    assert.ok(waitFor(() => !lsblk(dev, 'TYPE').includes('crypt')), 'LUKS volume still unlocked')
  })

  test('eject.sh names the process keeping a volume busy', () => {
    const img = path.join(work, 'busy.img')
    sh('truncate', ['-s', '32M', img])
    const dev = loopSetup(img)
    format(dev, 'vfat', 'ITBUSY')
    const mp = mountIt(dev)
    const holder = spawnSync('bash', ['-c', `cd '${mp}' && exec sleep 30 &`, ], { stdio: 'ignore' })
    assert.equal(holder.status, 0)
    try {
      waitFor(() => spawnSync('fuser', ['-m', dev]).status === 0)
      const r = spawnSync('bash', [script('eject.sh'), dev], { encoding: 'utf8' })
      assert.equal(r.status, 1)
      assert.match(r.stderr, /Still in use by: .*sleep/)
      assert.equal(lsblk(dev, 'MOUNTPOINT').filter(Boolean).length, 1, 'should still be mounted')
    } finally {
      spawnSync('fuser', ['-km', dev])
      waitFor(() => spawnSync('fuser', ['-m', dev]).status !== 0)
      spawnSync('udisksctl', ['unmount', '-b', dev, '--no-user-interaction'])
    }
  })

  test('open.sh (udisksctl mode) mounts a volume and hands it to xdg-open', () => {
    const img = path.join(work, 'plain.img')
    sh('truncate', ['-s', '32M', img])
    const dev = loopSetup(img)
    format(dev, 'vfat', 'ITPLAIN')
    // Record instead of opening a real file manager window.
    const bin = path.join(work, 'bin')
    fs.mkdirSync(bin, { recursive: true })
    const log = path.join(work, 'xdg-open.log')
    fs.writeFileSync(path.join(bin, 'xdg-open'), `#!/bin/sh\necho "$1" >> '${log}'\n`, { mode: 0o755 })

    const r = spawnSync('bash', [script('open.sh'), dev, '0'], {
      encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    })
    assert.equal(r.status, 0, r.stderr)
    const mp = lsblk(dev, 'MOUNTPOINT').filter(Boolean)[0]
    assert.ok(mp, 'volume should be mounted')
    assert.ok(waitFor(() => fs.existsSync(log)), 'xdg-open was not called')
    assert.equal(fs.readFileSync(log, 'utf8').trim(), mp)
    spawnSync('udisksctl', ['unmount', '-b', dev, '--no-user-interaction'])
  })

  test('list.sh output on this machine parses', () => {
    const r = spawnSync('bash', [script('list.sh')], { encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    const drives = loadModel().parseDrives(r.stdout)
    assert.ok(Array.isArray(drives), 'parseDrives returned null for real lsblk output')
  })
})
