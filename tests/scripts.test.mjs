import { describe, test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { sandbox, disk, part, FAKES } from './helpers/sandbox.mjs'

let box
afterEach(() => box && box.cleanup())
const without = (...tools) => FAKES.filter((t) => !tools.includes(t))

describe('eject.sh', () => {
  test('plain stick: unmount, then power off', () => {
    box = sandbox({ devices: [disk('sda'), part('sda1', 'sda', { fstype: 'vfat', mountpoint: '/run/media/u/S' })] })
    const r = box.run('eject.sh', ['/dev/sda'])
    assert.equal(r.code, 0, r.stderr)
    assert.deepEqual(box.callsTo('udisksctl'), ['unmount -b /dev/sda1', 'power-off -b /dev/sda'])
    assert.equal(box.state().devices[0].poweredOff, true)
  })

  test('several mounted partitions: all unmounted, last listed first', () => {
    box = sandbox({ devices: [
      disk('sda'),
      part('sda1', 'sda', { fstype: 'vfat', mountpoint: '/a' }),
      part('sda2', 'sda', { fstype: 'ext4' }),
      part('sda3', 'sda', { fstype: 'ext4', mountpoint: '/c' }),
    ] })
    assert.equal(box.run('eject.sh', ['/dev/sda']).code, 0)
    assert.deepEqual(box.callsTo('udisksctl'), ['unmount -b /dev/sda3', 'unmount -b /dev/sda1', 'power-off -b /dev/sda'])
  })

  test('nothing mounted: only power off', () => {
    box = sandbox({ devices: [disk('sda'), part('sda1', 'sda', { fstype: 'vfat' })] })
    assert.equal(box.run('eject.sh', ['/dev/sda']).code, 0)
    assert.deepEqual(box.callsTo('udisksctl'), ['power-off -b /dev/sda'])
  })

  test('filesystem on the bare disk is unmounted too', () => {
    box = sandbox({ devices: [disk('sda', { fstype: 'exfat', mountpoint: '/raw' })] })
    assert.equal(box.run('eject.sh', ['/dev/sda']).code, 0)
    assert.deepEqual(box.callsTo('udisksctl'), ['unmount -b /dev/sda', 'power-off -b /dev/sda'])
  })

  test('busy: names the programs holding it and stops before power off', () => {
    box = sandbox({
      devices: [disk('sda'), part('sda1', 'sda', { fstype: 'vfat', mountpoint: '/m' })],
      fail: { 'unmount /dev/sda1': 'Error unmounting /dev/sda1: target is busy' },
      // Real fuser appends access letters (c = cwd, m = mmap, ...) to PIDs.
      fuser: { '/dev/sda1': '4242c 1717m' },
      ps: { 4242: 'vim', 1717: 'nautilus' },
    })
    const r = box.run('eject.sh', ['/dev/sda'])
    assert.equal(r.code, 1)
    assert.equal(r.stderr.trim(), 'Still in use by: nautilus, vim')
    assert.deepEqual(box.callsTo('udisksctl'), ['unmount -b /dev/sda1'])
  })

  test('busy but fuser finds nothing: shows the udisks error', () => {
    box = sandbox({
      devices: [disk('sda'), part('sda1', 'sda', { fstype: 'vfat', mountpoint: '/m' })],
      fail: { 'unmount /dev/sda1': 'Error unmounting /dev/sda1: target is busy' },
    })
    const r = box.run('eject.sh', ['/dev/sda'])
    assert.equal(r.code, 1)
    assert.equal(r.stderr.trim(), 'Error unmounting /dev/sda1: target is busy')
  })

  test('busy and fuser not installed: shows the udisks error', () => {
    box = sandbox({
      fakes: without('fuser'),
      devices: [disk('sda'), part('sda1', 'sda', { fstype: 'vfat', mountpoint: '/m' })],
      fail: { 'unmount /dev/sda1': 'target is busy' },
    })
    const r = box.run('eject.sh', ['/dev/sda'])
    assert.equal(r.code, 1)
    assert.equal(r.stderr.trim(), 'target is busy')
    assert.deepEqual(box.callsTo('fuser'), [])
  })

  test('first partition busy: later ones are not touched after the failure', () => {
    box = sandbox({
      devices: [disk('sda'), part('sda1', 'sda', { fstype: 'vfat', mountpoint: '/a' }), part('sda2', 'sda', { fstype: 'vfat', mountpoint: '/b' })],
      fail: { 'unmount /dev/sda2': 'busy' },
    })
    assert.equal(box.run('eject.sh', ['/dev/sda']).code, 1)
    assert.deepEqual(box.callsTo('udisksctl'), ['unmount -b /dev/sda2'])
  })

  test('unlocked LUKS: unmount the mapping, lock the container, power off', () => {
    box = sandbox({ devices: [
      disk('sda'),
      part('sda1', 'sda', { fstype: 'crypto_LUKS' }),
      { path: '/dev/mapper/luks-1', parent: '/dev/sda1', type: 'crypt', fstype: 'ext4', mountpoint: '/secret' },
    ] })
    const r = box.run('eject.sh', ['/dev/sda'])
    assert.equal(r.code, 0, r.stderr)
    assert.deepEqual(box.callsTo('udisksctl'), ['unmount -b /dev/mapper/luks-1', 'lock -b /dev/sda1', 'power-off -b /dev/sda'])
  })

  test('locked LUKS: nothing to lock', () => {
    box = sandbox({ devices: [disk('sda'), part('sda1', 'sda', { fstype: 'crypto_LUKS' })] })
    assert.equal(box.run('eject.sh', ['/dev/sda']).code, 0)
    assert.deepEqual(box.callsTo('udisksctl'), ['power-off -b /dev/sda'])
  })

  test('mixed: one unlocked and one locked LUKS partition', () => {
    box = sandbox({ devices: [
      disk('sda'),
      part('sda1', 'sda', { fstype: 'crypto_LUKS' }),
      { path: '/dev/mapper/luks-1', parent: '/dev/sda1', type: 'crypt', fstype: 'ext4' },
      part('sda2', 'sda', { fstype: 'crypto_LUKS' }),
    ] })
    assert.equal(box.run('eject.sh', ['/dev/sda']).code, 0)
    assert.deepEqual(box.callsTo('udisksctl'), ['lock -b /dev/sda1', 'power-off -b /dev/sda'])
  })

  test('lock fails: stop before power off', () => {
    box = sandbox({
      devices: [disk('sda'), part('sda1', 'sda', { fstype: 'crypto_LUKS' }), { path: '/dev/mapper/l', parent: '/dev/sda1', type: 'crypt', fstype: 'ext4' }],
      fail: { 'lock /dev/sda1': 'Error locking: device busy' },
    })
    const r = box.run('eject.sh', ['/dev/sda'])
    assert.equal(r.code, 1)
    assert.match(r.stderr, /Error locking/)
    assert.deepEqual(box.callsTo('udisksctl'), ['lock -b /dev/sda1'])
  })

  test('power off fails: exit code and message passed through', () => {
    box = sandbox({ devices: [disk('sda')], fail: { 'power-off /dev/sda': 'Error powering off drive: not authorized' } })
    const r = box.run('eject.sh', ['/dev/sda'])
    assert.notEqual(r.code, 0)
    assert.match(r.stderr, /not authorized/)
  })

  test('mount points with spaces', () => {
    box = sandbox({ devices: [disk('sda'), part('sda1', 'sda', { fstype: 'vfat', mountpoint: '/run/media/u/MY STICK' })] })
    assert.equal(box.run('eject.sh', ['/dev/sda']).code, 0)
    assert.deepEqual(box.callsTo('udisksctl'), ['unmount -b /dev/sda1', 'power-off -b /dev/sda'])
  })

  // The drive the system runs from must never be ejected, whatever the
  // popup shows. Each case: the guard fires before any udisksctl call.
  for (const [what, mountpoints] of [
    ['root', ['/']],
    ['btrfs root among other subvolumes', ['/var/log', '/home', '/']],
    ['/boot', ['/boot']],
    ['/boot/efi', ['/boot/efi']],
    ['/efi', ['/efi']],
    ['/home', ['/home']],
    ['/var/cache', ['/var/cache']],
    ['/usr', ['/usr']],
    ['active swap', ['[SWAP]']],
    ['live installer medium', ['/run/archiso/bootmnt']],
  ]) {
    test(`refuses a drive holding ${what}`, () => {
      box = sandbox({ devices: [disk('sda'), part('sda1', 'sda', { fstype: 'ext4', mountpoints })] })
      const r = box.run('eject.sh', ['/dev/sda'])
      assert.equal(r.code, 3)
      assert.match(r.stderr, /^Refusing to eject \/dev\/sda: the running system uses it/)
      assert.deepEqual(box.callsTo('udisksctl'), [])
    })
  }

  test('system mount inside LUKS is found too', () => {
    box = sandbox({ devices: [
      disk('sda'),
      part('sda1', 'sda', { fstype: 'crypto_LUKS' }),
      { path: '/dev/mapper/root', parent: '/dev/sda1', type: 'crypt', fstype: 'btrfs', mountpoints: ['/'] },
    ] })
    assert.equal(box.run('eject.sh', ['/dev/sda']).code, 3)
    assert.deepEqual(box.callsTo('udisksctl'), [])
  })

  test('look-alike paths are not system mounts', () => {
    box = sandbox({ devices: [disk('sda'), part('sda1', 'sda', { fstype: 'vfat', mountpoints: ['/run/media/u/boot', '/home/u/usb', '/mnt/var', '/bootstick'] })] })
    assert.equal(box.run('eject.sh', ['/dev/sda']).code, 0)
    assert.deepEqual(box.callsTo('udisksctl'), ['unmount -b /dev/sda1', 'power-off -b /dev/sda'])
  })

  test('missing argument: usage error, nothing run', () => {
    box = sandbox()
    const r = box.run('eject.sh', [])
    assert.equal(r.code, 2)
    assert.match(r.stderr, /Usage/)
    assert.deepEqual(box.calls(), [])
  })
})

describe('holders.sh', () => {
  const mountedStick = () => [disk('sda'), part('sda1', 'sda', { fstype: 'vfat', mountpoint: '/a' }), part('sda2', 'sda', { fstype: 'ext4', mountpoint: '/b' }), part('sda3', 'sda', { fstype: 'ext4' })]

  test('names programs across all mounted partitions, sorted and unique', () => {
    box = sandbox({
      devices: mountedStick(),
      fuser: { '/dev/sda1': '11c 22', '/dev/sda2': '22m 33' },
      ps: { 11: 'vim', 22: 'nautilus', 33: 'bash' },
    })
    const r = box.run('holders.sh', ['/dev/sda'])
    assert.equal(r.code, 0)
    assert.equal(r.stdout, 'bash, nautilus, vim\n')
    assert.deepEqual(box.callsTo('fuser'), ['-m /dev/sda1', '-m /dev/sda2'], 'unmounted sda3 not probed')
  })

  test('a single partition can be asked about', () => {
    box = sandbox({ devices: mountedStick(), fuser: { '/dev/sda1': '11', '/dev/sda2': '22' }, ps: { 11: 'vim', 22: 'less' } })
    assert.equal(box.run('holders.sh', ['/dev/sda2']).stdout, 'less\n')
  })

  test('nothing holding it → empty output', () => {
    box = sandbox({ devices: mountedStick() })
    const r = box.run('holders.sh', ['/dev/sda'])
    assert.equal(r.code, 0)
    assert.equal(r.stdout.trim(), '')
  })

  test('process exited between fuser and ps → skipped', () => {
    box = sandbox({ devices: mountedStick(), fuser: { '/dev/sda1': '11 99' }, ps: { 11: 'vim' } })
    assert.equal(box.run('holders.sh', ['/dev/sda']).stdout, 'vim\n')
  })

  test('unknown device or no arguments → empty, success', () => {
    box = sandbox({ devices: mountedStick() })
    assert.equal(box.run('holders.sh', ['/dev/nope']).code, 0)
    assert.equal(box.run('holders.sh', []).stdout.trim(), '')
  })

  test('fuser not installed → empty, success, nothing else run', () => {
    box = sandbox({ fakes: without('fuser'), devices: mountedStick() })
    const r = box.run('holders.sh', ['/dev/sda'])
    assert.equal(r.code, 0)
    assert.equal(r.stdout, '')
    assert.deepEqual(box.calls(), [])
  })
})

describe('open.sh', () => {
  test('udiskie mode: mount the whole drive recursively, then open it detached', () => {
    box = sandbox({ devices: [disk('sda'), part('sda1', 'sda', { fstype: 'vfat', label: 'S' })] })
    const r = box.run('open.sh', ['/dev/sda', '1'])
    assert.equal(r.code, 0, r.stderr)
    assert.deepEqual(box.callsTo('udiskie-mount'), ['-r /dev/sda'])
    assert.deepEqual(box.callsTo('setsid'), ['-f xdg-open /run/media/test/S'])
    assert.deepEqual(box.callsTo('xdg-open'), ['/run/media/test/S'])
    assert.deepEqual(box.callsTo('udisksctl'), [])
  })

  test('udiskie mode unlocks LUKS and opens the decrypted filesystem', () => {
    box = sandbox({ devices: [disk('sda'), part('sda1', 'sda', { fstype: 'crypto_LUKS' })] })
    assert.equal(box.run('open.sh', ['/dev/sda', '1']).code, 0)
    assert.deepEqual(box.callsTo('xdg-open'), ['/run/media/test/SECRET'])
  })

  test('udisksctl mode: mounts unmounted plain partitions only', () => {
    box = sandbox({ devices: [
      disk('sda'),
      part('sda1', 'sda', { fstype: 'vfat', label: 'A' }),
      part('sda2', 'sda', { fstype: 'ext4', mountpoint: '/already' }),
      part('sda3', 'sda', { fstype: 'crypto_LUKS' }),
      part('sda4', 'sda', { fstype: 'swap' }),
      part('sda5', 'sda'),                                // no filesystem
    ] })
    const r = box.run('open.sh', ['/dev/sda', '0'])
    assert.equal(r.code, 0, r.stderr)
    assert.deepEqual(box.callsTo('udisksctl'), ['mount -b /dev/sda1'])
    assert.deepEqual(box.callsTo('udiskie-mount'), [])
    // The first mount point in lsblk order wins.
    assert.deepEqual(box.callsTo('xdg-open'), ['/run/media/test/A'])
  })

  test('udisksctl mode: a failing partition does not stop the others', () => {
    box = sandbox({
      devices: [disk('sda'), part('sda1', 'sda', { fstype: 'ntfs' }), part('sda2', 'sda', { fstype: 'vfat', label: 'B' })],
      fail: { 'mount /dev/sda1': 'wrong fs type' },
    })
    assert.equal(box.run('open.sh', ['/dev/sda', '0']).code, 0)
    assert.deepEqual(box.callsTo('udisksctl'), ['mount -b /dev/sda1', 'mount -b /dev/sda2'])
    assert.deepEqual(box.callsTo('xdg-open'), ['/run/media/test/B'])
  })

  test('nothing mountable: error, file manager not opened', () => {
    box = sandbox({ devices: [disk('sda'), part('sda1', 'sda', { fstype: 'crypto_LUKS' })] })
    const r = box.run('open.sh', ['/dev/sda', '0'])
    assert.equal(r.code, 1)
    assert.equal(r.stderr.trim(), 'Nothing on the drive could be mounted')
    assert.deepEqual(box.callsTo('xdg-open'), [])
  })

  test('udiskie fails (e.g. passphrase cancelled): error', () => {
    box = sandbox({ devices: [disk('sda'), part('sda1', 'sda', { fstype: 'crypto_LUKS' })], fail: { 'udiskie-mount /dev/sda': 'cancelled' } })
    const r = box.run('open.sh', ['/dev/sda', '1'])
    assert.equal(r.code, 1)
    assert.match(r.stderr, /Nothing on the drive could be mounted/)
  })

  test('missing argument: usage error', () => {
    box = sandbox()
    assert.equal(box.run('open.sh', []).code, 2)
    assert.deepEqual(box.calls(), [])
  })
})

describe('deps.sh', () => {
  test('everything installed → no output', () => {
    box = sandbox()
    const r = box.run('deps.sh')
    assert.equal(r.code, 0)
    assert.equal(r.stdout, '')
  })
  test('lists each missing tool', () => {
    box = sandbox({ fakes: without('udiskie-mount', 'xdg-open') })
    assert.deepEqual(box.run('deps.sh').stdout.trim().split('\n'), ['udiskie-mount', 'xdg-open'])
  })
  test('nothing installed', () => {
    box = sandbox({ fakes: [] })
    assert.deepEqual(box.run('deps.sh').stdout.trim().split('\n'), ['udisksctl', 'udiskie-mount', 'notify-send', 'xdg-open'])
  })
})

// A fake /sys: block/<disk> → devices/.../<scsi device>, with the USB
// device (the one holding "speed") some levels up.
function fakeSysfs(root, disks) {
  for (const { name, speed, stat } of disks) {
    const usb = path.join(root, 'devices/pci0000:00/usb1', `1-${name}`)
    const scsi = path.join(usb, `1-${name}:1.0/host0/target0:0:0/0:0:0:0`)
    fs.mkdirSync(scsi, { recursive: true })
    if (speed !== undefined) fs.writeFileSync(path.join(usb, 'speed'), `${speed}\n`)
    const blockDir = path.join(root, 'block', name)
    fs.mkdirSync(blockDir, { recursive: true })
    fs.symlinkSync(scsi, path.join(blockDir, 'device'))
    if (stat) fs.writeFileSync(path.join(blockDir, 'stat'), stat + '\n')
  }
}

describe('list.sh', () => {
  test('lsblk JSON, separator, then link speed per USB disk', () => {
    box = sandbox({ json: '{"blockdevices":[]}\n' })
    const sys = path.join(box.dir, 'sys')
    fakeSysfs(sys, [{ name: 'sda', speed: 480 }, { name: 'sdb', speed: 5000 }, { name: 'sdc' }])
    const r = box.run('list.sh', [], { SYSFS: sys })
    assert.equal(r.code, 0, r.stderr)
    assert.equal(r.stdout, '{"blockdevices":[]}\n---\nsda 480\nsdb 5000\n')
    assert.match(box.callsTo('lsblk')[0], /^-J -b -o NAME,PATH,TYPE,TRAN,HOTPLUG,SIZE,LABEL,VENDOR,MODEL,FSTYPE,FSUSED,FSSIZE,MOUNTPOINTS$/)
  })

  test('no disks at all: separator only', () => {
    box = sandbox()
    const sys = path.join(box.dir, 'sys')
    fs.mkdirSync(path.join(sys, 'block'), { recursive: true })
    assert.equal(box.run('list.sh', [], { SYSFS: sys }).stdout, '{"blockdevices":[]}\n---\n')
  })
})

describe('stat.sh', () => {
  test('prints the stat line of each requested disk', () => {
    box = sandbox()
    const sys = path.join(box.dir, 'sys')
    fakeSysfs(sys, [{ name: 'sda', stat: '1 2 3 4 5 6 7' }, { name: 'sdb', stat: '9 9 9' }])
    const r = box.run('stat.sh', ['sda', 'sdb'], { SYSFS: sys })
    assert.equal(r.code, 0)
    assert.equal(r.stdout, 'sda 1 2 3 4 5 6 7\nsdb 9 9 9\n')
  })

  test('skips unknown disks and refuses path tricks', () => {
    box = sandbox()
    const sys = path.join(box.dir, 'sys')
    fakeSysfs(sys, [{ name: 'sda', stat: '1' }])
    // What "../../secret" would reach from $SYSFS/block/ without the guard.
    fs.mkdirSync(path.join(box.dir, 'secret'))
    fs.writeFileSync(path.join(box.dir, 'secret', 'stat'), 'leaked')
    const r = box.run('stat.sh', ['gone', '../../secret', '..', '', 'sda'], { SYSFS: sys })
    assert.equal(r.code, 0)
    assert.equal(r.stdout, 'sda 1\n')
  })

  test('no arguments: no output, success', () => {
    box = sandbox()
    const r = box.run('stat.sh', [])
    assert.equal(r.code, 0)
    assert.equal(r.stdout, '')
  })
})
