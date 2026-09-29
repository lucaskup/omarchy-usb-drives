#!/usr/bin/env node
// Stand-in for lsblk, udisksctl, udiskie-mount, fuser, ps, setsid, xdg-open
// and notify-send. Invoked as `fake.mjs <tool> args...` from tiny wrappers in
// a per-test bin directory (see sandbox.mjs).
//
// State lives in $FAKE_STATE (JSON):
//   devices: [{ path, parent, type, fstype, mountpoint, label }]
//   fail:    { "unmount /dev/sda1": "message", ... }  command → forced error
//   fuser:   { "/dev/sda1": "123c 456" }             fuser -m output
//   ps:      { "123": "nautilus" }                    pid → comm
//   json:    "..."                                    lsblk -J output
// Every call is appended to $FAKE_CALLS as one JSON array per line.
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'

const [tool, ...args] = process.argv.slice(2)
const statePath = process.env.FAKE_STATE
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
const save = () => fs.writeFileSync(statePath, JSON.stringify(state))
fs.appendFileSync(process.env.FAKE_CALLS, JSON.stringify([tool, ...args]) + '\n')

const dev = (p) => state.devices.find((d) => d.path === p)
const subtree = (p) => {
  const out = [dev(p)].filter(Boolean)
  for (let i = 0; i < out.length; i++)
    for (const d of state.devices) if (d.parent === out[i].path) out.push(d)
  return out
}
// A device may give `mountpoints: [...]` (several) or a single `mountpoint`;
// MOUNTPOINT (singular) shows the first, like real lsblk.
const firstMount = (d) => d.mountpoint || (d.mountpoints || [])[0] || ''
const failure = (key) => state.fail && state.fail[key]
const die = (msg, code = 1) => { process.stderr.write(msg + '\n'); process.exit(code) }
const mountAt = (d) => { d.mountpoint = '/run/media/test/' + (d.label || d.path.split('/').pop()) }

switch (tool) {
  case 'lsblk': {
    if (args.includes('-J')) { process.stdout.write(state.json || '{"blockdevices":[]}\n'); break }
    // Only the -lnpo COLS DEVICE form the scripts use.
    const cols = args[args.indexOf('-lnpo') + 1].split(',').map((c) => c.toLowerCase())
    const target = args[args.length - 1]
    if (!dev(target)) die(`lsblk: ${target}: not a block device`, 32)
    for (const d of subtree(target)) {
      // MOUNTPOINTS: like real lsblk -l, extra mount points go on their own
      // lines. Devices may give `mountpoints: [...]` or a single `mountpoint`.
      if (cols.length === 1 && cols[0] === 'mountpoints') {
        for (const mp of d.mountpoints || [d.mountpoint]) if (mp) console.log(mp)
        continue
      }
      console.log(cols.map((c) => (c === 'mountpoint' ? firstMount(d) : d[c]) || '').filter(Boolean).join(' '))
    }
    break
  }
  case 'udisksctl': {
    const [verb, , path] = args // udisksctl <verb> -b <path>
    const msg = failure(`${verb} ${path}`)
    if (msg) die(msg)
    const d = dev(path)
    if (!d) die(`Error looking up object for device ${path}`)
    if (verb === 'unmount') { d.mountpoint = ''; d.mountpoints = []; console.log(`Unmounted ${path}.`) }
    else if (verb === 'mount') { mountAt(d); console.log(`Mounted ${path} at ${d.mountpoint}`) }
    else if (verb === 'lock') { state.devices = state.devices.filter((x) => x.parent !== path); console.log(`Locked ${path}.`) }
    else if (verb === 'power-off') { d.poweredOff = true }
    save()
    break
  }
  case 'udiskie-mount': {
    // -r <disk>: unlock LUKS (as if the passphrase was typed) and mount all.
    const disk = args[args.length - 1]
    const msg = failure(`udiskie-mount ${disk}`)
    if (msg) die(msg)
    for (const d of subtree(disk)) {
      if (d.fstype === 'crypto_LUKS' && !state.devices.some((x) => x.parent === d.path))
        state.devices.push({ path: '/dev/mapper/luks-' + d.path.split('/').pop(), parent: d.path, type: 'crypt', fstype: 'ext4', mountpoint: '', label: 'SECRET' })
    }
    for (const d of subtree(disk))
      if (d.fstype && !['crypto_LUKS', 'swap'].includes(d.fstype) && !d.mountpoint) mountAt(d)
    save()
    break
  }
  case 'fuser': {
    const out = (state.fuser || {})[args[args.length - 1]]
    if (!out) process.exit(1)
    process.stdout.write(out + '\n')
    break
  }
  case 'ps': {
    // Like procps: a PID with trailing letters is a usage error.
    if (!/^\d+$/.test(args[args.length - 1])) die('error: process ID list syntax error')
    const comm = (state.ps || {})[args[args.length - 1]]
    if (!comm) process.exit(1)
    console.log(comm)
    break
  }
  case 'setsid': {
    const rest = args[0] === '-f' ? args.slice(1) : args
    const r = spawnSync(rest[0], rest.slice(1), { stdio: 'inherit', env: process.env })
    process.exit(r.status ?? 1)
  }
  default:
    // xdg-open, notify-send: recording the call is enough.
    break
}
