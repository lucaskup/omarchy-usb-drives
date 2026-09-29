// A throwaway environment for running scripts/*.sh against fake tools.
// PATH holds only the fakes you ask for plus a fixed set of real coreutils,
// so a tool can be "not installed" simply by not faking it.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { pluginDir } from './model.mjs'

const fake = fileURLToPath(new URL('./fake.mjs', import.meta.url))
const REAL = ['bash', 'sh', 'awk', 'tac', 'sort', 'paste', 'sed', 'grep', 'head',
  'cat', 'dirname', 'readlink', 'env', 'node']
export const FAKES = ['lsblk', 'udisksctl', 'udiskie-mount', 'fuser', 'ps', 'setsid',
  'xdg-open', 'notify-send']

function which(cmd) {
  for (const dir of (process.env.PATH || '').split(':')) {
    const p = path.join(dir, cmd)
    try { fs.accessSync(p, fs.constants.X_OK); return fs.realpathSync(p) } catch {}
  }
  throw new Error(`${cmd} not found on PATH`)
}

export function sandbox({ devices = [], fakes = FAKES, ...rest } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usb-drives-test-'))
  const bin = path.join(dir, 'bin')
  fs.mkdirSync(bin)
  for (const cmd of REAL) fs.symlinkSync(which(cmd), path.join(bin, cmd))
  for (const cmd of fakes)
    fs.writeFileSync(path.join(bin, cmd), `#!/bin/sh\nexec "${which('node')}" "${fake}" ${cmd} "$@"\n`, { mode: 0o755 })

  const statePath = path.join(dir, 'state.json')
  const callsPath = path.join(dir, 'calls.jsonl')
  fs.writeFileSync(statePath, JSON.stringify({
    devices: devices.map((d) => ({ parent: '', type: 'part', fstype: '', mountpoint: '', label: '', ...d })),
    ...rest,
  }))
  fs.writeFileSync(callsPath, '')

  return {
    dir,
    run(script, args = [], env = {}) {
      const r = spawnSync(path.join(bin, 'bash'), [path.join(pluginDir, 'scripts', script), ...args], {
        encoding: 'utf8',
        env: { PATH: bin, FAKE_STATE: statePath, FAKE_CALLS: callsPath, ...env },
      })
      return { code: r.status, stdout: r.stdout, stderr: r.stderr }
    },
    calls() {
      return fs.readFileSync(callsPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    },
    // Calls to one tool, as "arg arg arg" strings.
    callsTo(tool) {
      return this.calls().filter((c) => c[0] === tool).map((c) => c.slice(1).join(' '))
    },
    state() { return JSON.parse(fs.readFileSync(statePath, 'utf8')) },
    cleanup() { fs.rmSync(dir, { recursive: true, force: true }) },
  }
}

export const disk = (name, extra = {}) => ({ path: `/dev/${name}`, type: 'disk', ...extra })
export const part = (name, parent, extra = {}) => ({ path: `/dev/${name}`, parent: `/dev/${parent}`, type: 'part', ...extra })
