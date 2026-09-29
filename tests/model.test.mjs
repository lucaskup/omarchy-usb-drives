import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { loadModel } from './helpers/model.mjs'

const M = loadModel()
// Objects built inside the vm context have a different Object prototype, so
// deepStrictEqual would reject them; round-trip through JSON first.
const plain = (v) => JSON.parse(JSON.stringify(v))
const fixture = (name) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')

// Minimal lsblk -J device builder; unspecified columns are null like lsblk's.
function blk(name, fields = {}, children) {
  const d = {
    name, path: `/dev/${name}`, type: 'part', tran: null, hotplug: true, size: 1e9,
    label: null, vendor: null, model: null, fstype: null, fsused: null, fssize: null,
    mountpoints: [null], ...fields,
  }
  if (children) d.children = children
  return d
}
const usbDisk = (name, fields, children) => blk(name, { type: 'disk', tran: 'usb', ...fields }, children)
const listOutput = (devices, speeds = '') => JSON.stringify({ blockdevices: devices }) + '\n---\n' + speeds

describe('formatSize', () => {
  const cases = [
    [0, '0 B'], [999, '999 B'], [1000, '1.0 KB'], [8192, '8.2 KB'], [99_949, '99.9 KB'],
    [100_000, '100 KB'], [16_231_956_480, '16.2 GB'], [2e12, '2.0 TB'], [5e15, '5000 TB'],
  ]
  for (const [bytes, want] of cases) test(`${bytes} → ${want}`, () => assert.equal(M.formatSize(bytes), want))
  test('non-numbers count as zero', () => {
    assert.equal(M.formatSize(null), '0 B')
    assert.equal(M.formatSize('abc'), '0 B')
    assert.equal(M.formatSize(undefined), '0 B')
  })
  test('numeric strings (older lsblk) are accepted', () => assert.equal(M.formatSize('16231956480'), '16.2 GB'))
  test('formatRate appends /s', () => assert.equal(M.formatRate(10_100_000), '10.1 MB/s'))
})

describe('linkLabel', () => {
  const cases = [
    [undefined, ''], ['', ''], [0, ''], [-1, ''], ['1.5', 'USB 1.1 · 12 Mb/s'], ['12', 'USB 1.1 · 12 Mb/s'],
    ['480', 'USB 2.0 · 480 Mb/s'], ['5000', 'USB 3 · 5 Gb/s'], ['10000', 'USB 3 · 10 Gb/s'],
    ['20000', 'USB 3 · 20 Gb/s'], [40000, 'USB 3 · 40 Gb/s'],
  ]
  for (const [mbps, want] of cases) test(`${mbps} → "${want}"`, () => assert.equal(M.linkLabel(mbps), want))
})

describe('descendants / mountsOf', () => {
  test('walks nested children depth-first', () => {
    const tree = blk('a', {}, [blk('b', {}, [blk('c')]), blk('d')])
    assert.deepEqual(plain(M.descendants(tree).map((d) => d.name)), ['b', 'c', 'd'])
  })
  test('handles missing input', () => {
    assert.equal(M.descendants(null).length, 0)
    assert.equal(M.descendants({}).length, 0)
    assert.equal(M.mountsOf(null).length, 0)
  })
  test('drops null mount points', () => {
    assert.deepEqual(plain(M.mountsOf({ mountpoints: [null, '/a', null, '/b'] })), ['/a', '/b'])
  })
})

describe('parseSpeeds', () => {
  test('reads "<disk> <speed>" lines and ignores junk', () => {
    assert.deepEqual(plain(M.parseSpeeds('sda 480\n  sdb 5000  \ngarbage\n\nsdc 1 2\n')), { sda: '480', sdb: '5000' })
  })
  test('empty input', () => assert.deepEqual(plain(M.parseSpeeds(undefined)), {}))
})

describe('parseDrives', () => {
  test('real capture: USB stick kept, internal NVMe and zram dropped', () => {
    const drives = plain(M.parseDrives(fixture('real-vfat-stick.txt')))
    assert.equal(drives.length, 1)
    const [d] = drives
    assert.equal(d.name, 'MYSTICK')
    assert.equal(d.model, 'SMI USB DISK', 'vendor padding trimmed')
    assert.equal(d.path, '/dev/sda')
    assert.equal(d.dev, 'sda')
    assert.equal(d.size, '16.2 GB')
    assert.deepEqual(d.mounts, ['/run/media/user/MYSTICK'])
    assert.equal(d.mounted, true)
    assert.equal(d.locked, false)
    assert.equal(d.usage, '8.2 KB of 16.2 GB used')
    assert.equal(d.link, 'USB 2.0 · 480 Mb/s')
  })

  test('filters by transport, hotplug, type and size', () => {
    const drives = plain(M.parseDrives(listOutput([
      usbDisk('sda', { label: 'USB' }),
      blk('sdb', { type: 'disk', tran: 'sata', hotplug: false }),     // internal SATA
      blk('mmcblk0', { type: 'disk', tran: null, hotplug: true }),     // SD reader
      blk('loop0', { type: 'loop', tran: null, hotplug: false }),
      usbDisk('sdc', { size: 0 }),                                     // empty card reader slot
      usbDisk('sdd', { size: null }),
      blk('sr0', { type: 'rom', tran: 'usb' }),                        // USB optical drive
    ]))).map((d) => d.dev)
    assert.deepEqual(drives, ['sda', 'mmcblk0'])
  })

  test('name falls back from label to vendor+model to device name', () => {
    const names = plain(M.parseDrives(listOutput([
      usbDisk('sda', {}, [blk('sda1', { label: 'PART' })]),
      usbDisk('sdb', { vendor: 'Kingston', model: 'DataTraveler ' }),
      usbDisk('sdc', { vendor: '   ', model: null }),
    ]))).map((d) => d.name)
    assert.deepEqual(names, ['PART', 'Kingston DataTraveler', 'sdc'])
  })

  test('filesystem directly on the disk (no partition table)', () => {
    const [d] = plain(M.parseDrives(listOutput([
      usbDisk('sda', { fstype: 'exfat', label: 'RAW', mountpoints: ['/run/media/u/RAW'], fsused: 5e8, fssize: 1e9 }),
    ])))
    assert.equal(d.mounted, true)
    assert.equal(d.usedFraction, 0.5)
  })

  test('multiple partitions: usage sums mounted ones only', () => {
    const [d] = plain(M.parseDrives(listOutput([usbDisk('sda', {}, [
      blk('sda1', { fstype: 'vfat', mountpoints: ['/a'], fsused: 1e9, fssize: 4e9 }),
      blk('sda2', { fstype: 'ext4', mountpoints: ['/b', '/c'], fsused: 1e9, fssize: 4e9 }),
      blk('sda3', { fstype: 'ntfs', fsused: 9e9, fssize: 9e9 }),        // not mounted
    ])])))
    assert.deepEqual(d.mounts, ['/a', '/b', '/c'])
    assert.equal(d.used, 2e9)
    assert.equal(d.total, 8e9)
    assert.equal(d.usedFraction, 0.25)
    assert.equal(d.usage, '2.0 GB of 8.0 GB used')
  })

  test('nothing mounted: no usage, not mounted', () => {
    const [d] = plain(M.parseDrives(listOutput([usbDisk('sda', {}, [blk('sda1', { fstype: 'vfat' })])])))
    assert.equal(d.mounted, false)
    assert.equal(d.usage, '')
    assert.equal(d.usedFraction, 0)
    assert.equal(d.locked, false)
  })

  test('installer ISO: full partition, label from the first child', () => {
    const [d] = plain(M.parseDrives(listOutput([usbDisk('sda', { size: 16231956480 }, [
      blk('sda1', { fstype: 'iso9660', label: 'OMARCHY_202609', mountpoints: ['/run/media/u/OMARCHY'], fsused: 6161121280, fssize: 6161121280 }),
      blk('sda2', { fstype: 'vfat', label: 'EFI' }),
    ])])))
    assert.equal(d.name, 'OMARCHY_202609')
    assert.equal(d.usedFraction, 1)
  })

  test('LUKS locked: flagged locked, nothing mounted', () => {
    const [d] = plain(M.parseDrives(listOutput([usbDisk('sda', {}, [blk('sda1', { fstype: 'crypto_LUKS' })])])))
    assert.equal(d.locked, true)
    assert.equal(d.mounted, false)
  })

  test('LUKS unlocked and mounted: mount and usage found one level deeper', () => {
    const [d] = plain(M.parseDrives(listOutput([usbDisk('sda', {}, [
      blk('sda1', { fstype: 'crypto_LUKS' }, [
        blk('luks-1234', { type: 'crypt', fstype: 'ext4', label: 'SECRET', mountpoints: ['/run/media/u/SECRET'], fsused: 1e9, fssize: 2e9 }),
      ]),
    ])])))
    assert.equal(d.locked, false)
    assert.equal(d.name, 'SECRET')
    assert.deepEqual(d.mounts, ['/run/media/u/SECRET'])
    assert.equal(d.usedFraction, 0.5)
  })

  test('LUKS unlocked but not mounted: neither locked nor mounted', () => {
    const [d] = plain(M.parseDrives(listOutput([usbDisk('sda', {}, [
      blk('sda1', { fstype: 'crypto_LUKS' }, [blk('luks-1234', { type: 'crypt', fstype: 'ext4' })]),
    ])])))
    assert.equal(d.locked, false)
    assert.equal(d.mounted, false)
  })

  test('mounted but lsblk has no usage numbers (e.g. some FUSE/network fs)', () => {
    const [d] = plain(M.parseDrives(listOutput([usbDisk('sda', {}, [
      blk('sda1', { fstype: 'ntfs', mountpoints: ['/n'], fsused: null, fssize: 'n/a' }),
    ])])))
    assert.equal(d.mounted, true)
    assert.equal(d.used, 0)
    assert.equal(d.total, 0)
    assert.equal(d.usage, '')
  })

  test('driveFromDevice without speed info', () => {
    assert.equal(M.driveFromDevice(usbDisk('sda'), undefined).link, '')
  })

  test('drives the running system uses are never listed', () => {
    const drives = plain(M.parseDrives(listOutput([
      usbDisk('sda', { label: 'DATA' }, [blk('sda1', { fstype: 'vfat', mountpoints: ['/run/media/u/DATA'] })]),
      // Omarchy installed on a USB SSD: btrfs root with subvolumes
      usbDisk('sdb', {}, [
        blk('sdb1', { fstype: 'vfat', mountpoints: ['/boot'] }),
        blk('sdb2', { fstype: 'crypto_LUKS' }, [blk('root', { type: 'crypt', fstype: 'btrfs', mountpoints: ['/var/log', '/home', '/'] })]),
      ]),
      // live installer stick
      usbDisk('sdc', {}, [blk('sdc1', { fstype: 'iso9660', mountpoints: ['/run/archiso/bootmnt'] })]),
      // stick used as swap
      usbDisk('sdd', {}, [blk('sdd1', { fstype: 'swap', mountpoints: ['[SWAP]'] })]),
    ]))).map((d) => d.dev)
    assert.deepEqual(drives, ['sda'])
  })

  test('link speed only for disks listed after ---', () => {
    const drives = plain(M.parseDrives(listOutput([usbDisk('sda'), usbDisk('sdb')], 'sdb 5000\n')))
    assert.deepEqual(drives.map((d) => d.link), ['', 'USB 3 · 5 Gb/s'])
  })

  test('works without the --- section', () => {
    const drives = plain(M.parseDrives(JSON.stringify({ blockdevices: [usbDisk('sda')] })))
    assert.equal(drives.length, 1)
    assert.equal(drives[0].link, '')
  })

  test('no removable drives → empty list (not null)', () => {
    assert.deepEqual(plain(M.parseDrives(listOutput([]))), [])
  })

  test('unusable output → null so the last list is kept', () => {
    for (const bad of ['', 'not json', '{}', '{"blockdevices": 5}', 'null', undefined])
      assert.equal(M.parseDrives(bad), null, JSON.stringify(bad))
  })
})

describe('computeRates', () => {
  // /sys/block/<disk>/stat: reads merges sectors ticks writes merges sectors ...
  const line = (disk, readSectors, writeSectors) => `${disk} 1 0 ${readSectors} 0 1 0 ${writeSectors} 0 0 0 0`

  test('first sample has no rates yet', () => {
    const r = plain(M.computeRates({}, line('sda', 100, 200), 1000))
    assert.deepEqual(r.rates, {})
    assert.deepEqual(r.stat.sda, { t: 1000, read: 100 * 512, write: 200 * 512 })
  })

  test('bytes per second from the sector delta', () => {
    const first = M.computeRates({}, line('sda', 0, 0), 0)
    const second = plain(M.computeRates(first.stat, line('sda', 2048, 20480), 2000))
    assert.deepEqual(second.rates.sda, { read: 2048 * 512 / 2, write: 20480 * 512 / 2 })
  })

  test('counter reset (re-plug) never gives negative rates', () => {
    const first = M.computeRates({}, line('sda', 5000, 5000), 0)
    const second = plain(M.computeRates(first.stat, line('sda', 10, 10), 1000))
    assert.deepEqual(second.rates.sda, { read: 0, write: 0 })
  })

  test('same or older timestamp gives no rate', () => {
    const first = M.computeRates({}, line('sda', 0, 0), 1000)
    assert.deepEqual(plain(M.computeRates(first.stat, line('sda', 9, 9), 1000).rates), {})
    assert.deepEqual(plain(M.computeRates(first.stat, line('sda', 9, 9), 500).rates), {})
  })

  test('several disks, short and garbage lines skipped, unplugged disks dropped', () => {
    const first = M.computeRates({}, [line('sda', 0, 0), line('sdb', 0, 0)].join('\n'), 0)
    const raw = [line('sda', 1024, 0), 'sdb 1 2 3', 'sdc x x x x x x x x', '', 'junk'].join('\n')
    const second = plain(M.computeRates(first.stat, raw, 1000))
    assert.deepEqual(Object.keys(second.stat), ['sda'])
    assert.deepEqual(second.rates, { sda: { read: 1024 * 512, write: 0 } })
  })

  test('empty input and missing previous state', () => {
    assert.deepEqual(plain(M.computeRates(null, '', 0)), { stat: {}, rates: {} })
    assert.deepEqual(plain(M.computeRates(undefined, undefined, 0)), { stat: {}, rates: {} })
  })
})

describe('rateText', () => {
  test('no sample yet → nothing', () => assert.equal(M.rateText(undefined), ''))
  test('below 1 KB/s both ways → Idle', () => assert.equal(M.rateText({ read: 1023, write: 0 }), 'Idle'))
  test('only the moving direction is shown', () => {
    assert.equal(M.rateText({ read: 0, write: 10_100_000 }), '↑ 10.1 MB/s')
    assert.equal(M.rateText({ read: 2_000_000, write: 0 }), '↓ 2.0 MB/s')
  })
  test('both directions', () => assert.equal(M.rateText({ read: 1024, write: 2048 }), '↓ 1.0 KB/s  ↑ 2.0 KB/s'))
})

describe('barUsage', () => {
  test('fullest mounted drive, rounded', () => {
    assert.equal(M.barUsage([{ total: 0, usedFraction: 0 }, { total: 1, usedFraction: 0.424 }, { total: 1, usedFraction: 0.2 }]), '42%')
  })
  test('an empty mounted drive shows 0%', () => assert.equal(M.barUsage([{ total: 1, usedFraction: 0 }]), '0%'))
  test('nothing mounted → no label', () => {
    assert.equal(M.barUsage([{ total: 0, usedFraction: 0 }]), '')
    assert.equal(M.barUsage([]), '')
    assert.equal(M.barUsage(null), '')
  })
})

describe('dependencies', () => {
  test('parseMissing trims and drops blanks', () => {
    assert.deepEqual(plain(M.parseMissing('udiskie-mount\n\n  xdg-open \n')), ['udiskie-mount', 'xdg-open'])
    assert.deepEqual(plain(M.parseMissing('')), [])
    assert.deepEqual(plain(M.parseMissing(null)), [])
  })
  test('missingHint names the Arch package', () => {
    assert.equal(M.missingHint('udisksctl'), 'udisksctl (udisks2)')
    assert.equal(M.missingHint('udiskie-mount'), 'udiskie-mount (udiskie)')
    assert.equal(M.missingHint('notify-send'), 'notify-send (libnotify)')
    assert.equal(M.missingHint('xdg-open'), 'xdg-open (xdg-utils)')
    assert.equal(M.missingHint('mystery'), 'mystery (mystery)')
  })
})

describe('openPlan', () => {
  const mounted = { name: 'S', mounted: true, locked: false, mounts: ['/m1', '/m2'] }
  const plainDrive = { name: 'S', mounted: false, locked: false, mounts: [] }
  const locked = { name: 'S', mounted: false, locked: true, mounts: [] }

  test('no drive → nothing', () => assert.equal(M.openPlan(null, []).kind, 'none'))
  test('mounted → open the first mount point', () => assert.deepEqual(plain(M.openPlan(mounted, [])), { kind: 'open', path: '/m1' }))
  test('unmounted → mount with udiskie', () => assert.deepEqual(plain(M.openPlan(plainDrive, [])), { kind: 'mount', useUdiskie: true }))
  test('locked → mount with udiskie (it prompts)', () => assert.deepEqual(plain(M.openPlan(locked, [])), { kind: 'mount', useUdiskie: true }))
  test('no udiskie, plain drive → udisksctl fallback', () => {
    assert.deepEqual(plain(M.openPlan(plainDrive, ['udiskie-mount'])), { kind: 'mount', useUdiskie: false })
  })
  test('no udiskie, locked drive → error', () => {
    const p = M.openPlan(locked, ['udiskie-mount'])
    assert.equal(p.kind, 'error')
    assert.match(p.body, /udiskie/)
  })
  test('no udiskie and no udisksctl → error', () => {
    const p = M.openPlan(plainDrive, ['udiskie-mount', 'udisksctl'])
    assert.equal(p.kind, 'error')
    assert.match(p.body, /udisks2/)
  })
  test('no xdg-open → error, even when mounted', () => {
    const p = M.openPlan(mounted, ['xdg-open'])
    assert.equal(p.kind, 'error')
    assert.equal(p.title, 'Cannot open S')
  })
  test('missing list may be undefined', () => assert.equal(M.openPlan(mounted, undefined).kind, 'open'))
})

describe('ejectPlan / results', () => {
  const drive = { name: 'S' }
  test('eject when possible', () => assert.equal(M.ejectPlan(drive, [], false).kind, 'eject'))
  test('ignored while another eject runs', () => assert.equal(M.ejectPlan(drive, [], true).kind, 'none'))
  test('ignored without a drive', () => assert.equal(M.ejectPlan(null, [], false).kind, 'none'))
  test('error without udisksctl', () => {
    const p = M.ejectPlan(drive, ['udisksctl'], false)
    assert.equal(p.kind, 'error')
    assert.equal(p.title, 'Cannot eject S')
  })

  test('success notifies unless quiet', () => {
    assert.deepEqual(plain(M.ejectResult('S', 0, '', false)), { title: 'S ejected', body: 'Safe to remove', urgent: false })
    assert.equal(M.ejectResult('S', 0, '', true), null)
  })
  test('failure always notifies, with the script message', () => {
    assert.deepEqual(plain(M.ejectResult('S', 1, ' Still in use by: vim \n', true)),
      { title: 'Could not eject S', body: 'Still in use by: vim', urgent: true })
  })
  test('failure without a message gets a generic one', () => {
    assert.equal(M.ejectResult('S', 1, '', false).body, 'The drive may still be in use')
    assert.equal(M.ejectResult('S', 1, undefined, false).body, 'The drive may still be in use')
  })

  test('openResult: silent on success, urgent on failure', () => {
    assert.equal(M.openResult('S', 0, ''), null)
    assert.deepEqual(plain(M.openResult('S', 1, 'Nothing on the drive could be mounted\n')),
      { title: 'Could not open S', body: 'Nothing on the drive could be mounted', urgent: true })
    assert.equal(M.openResult('S', 1, '').body, 'Mounting failed')
  })
})

describe('notifyCommand / urlToPath', () => {
  test('normal and critical notifications', () => {
    assert.deepEqual(plain(M.notifyCommand('T', 'B', false)), ['notify-send', '-a', 'USB drives', 'T', 'B'])
    assert.deepEqual(plain(M.notifyCommand('T', 'B', true)), ['notify-send', '-a', 'USB drives', '-u', 'critical', 'T', 'B'])
  })
  test('titles are passed as arguments, never through a shell', () => {
    assert.equal(M.notifyCommand("it's $(rm -rf ~)", 'b', false)[3], "it's $(rm -rf ~)")
  })
  test('file URLs become paths, including escaped characters', () => {
    assert.equal(M.urlToPath('file:///home/u/.config/omarchy/plugins/x/scripts/eject.sh'), '/home/u/.config/omarchy/plugins/x/scripts/eject.sh')
    assert.equal(M.urlToPath('file:///home/my%20user/a.sh'), '/home/my user/a.sh')
    assert.equal(M.urlToPath('/already/a/path'), '/already/a/path')
  })
})

describe('blockers', () => {
  const busyErr = 'Still in use by: nautilus, vim\n'

  test('parseBusy reads the eject.sh busy line only', () => {
    assert.equal(M.parseBusy(busyErr), 'nautilus, vim')
    assert.equal(M.parseBusy('warning\nStill in use by: vim \nmore'), 'vim')
    assert.equal(M.parseBusy('Error unmounting: target is busy'), '')
    assert.equal(M.parseBusy(undefined), '')
  })

  test('afterEject: busy failure records the programs', () => {
    assert.deepEqual(plain(M.afterEject({}, '/dev/sda', 1, busyErr)), { '/dev/sda': 'nautilus, vim' })
  })
  test('afterEject: success or another error clears only that drive', () => {
    const start = { '/dev/sda': 'vim', '/dev/sdb': 'less' }
    assert.deepEqual(plain(M.afterEject(start, '/dev/sda', 0, '')), { '/dev/sdb': 'less' })
    assert.deepEqual(plain(M.afterEject(start, '/dev/sda', 1, 'not authorized')), { '/dev/sdb': 'less' })
    assert.deepEqual(plain(start), { '/dev/sda': 'vim', '/dev/sdb': 'less' }, 'input not mutated')
  })
  test('afterEject tolerates missing state', () => {
    assert.deepEqual(plain(M.afterEject(undefined, '/dev/sda', 1, busyErr)), { '/dev/sda': 'nautilus, vim' })
  })

  test('updateHolders: new list, cleared when empty, ignored for unknown drives', () => {
    const start = { '/dev/sda': 'nautilus, vim' }
    assert.deepEqual(plain(M.updateHolders(start, '/dev/sda', 'vim\n')), { '/dev/sda': 'vim' })
    assert.deepEqual(plain(M.updateHolders(start, '/dev/sda', '\n')), {})
    assert.deepEqual(plain(M.updateHolders(start, '/dev/sda', undefined)), {}, 'no output at all')
    assert.deepEqual(plain(M.updateHolders(start, '/dev/sdz', 'x')), start)
    assert.deepEqual(plain(M.updateHolders(undefined, '/dev/sda', 'x')), {})
  })

  test('pruneBlockers keeps only drives still plugged in and mounted', () => {
    const blockers = { '/dev/sda': 'a', '/dev/sdb': 'b', '/dev/sdc': 'c' }
    const drives = [{ path: '/dev/sda', mounted: true }, { path: '/dev/sdb', mounted: false }]
    assert.deepEqual(plain(M.pruneBlockers(blockers, drives)), { '/dev/sda': 'a' })
    assert.deepEqual(plain(M.pruneBlockers(blockers, null)), {})
    assert.deepEqual(plain(M.pruneBlockers(undefined, drives)), {})
  })

  test('nextBlockerPath cycles through drives in a stable order', () => {
    const b = { '/dev/sdb': 'x', '/dev/sda': 'y' }
    assert.equal(M.nextBlockerPath(b, ''), '/dev/sda')
    assert.equal(M.nextBlockerPath(b, '/dev/sda'), '/dev/sdb')
    assert.equal(M.nextBlockerPath(b, '/dev/sdb'), '/dev/sda')
    assert.equal(M.nextBlockerPath(b, '/dev/gone'), '/dev/sda')
    assert.equal(M.nextBlockerPath({}, ''), '')
    assert.equal(M.nextBlockerPath(null, ''), '')
  })

  test('blockerText', () => {
    assert.equal(M.blockerText('vim'), 'In use by vim. Close it and eject again.')
    assert.equal(M.blockerText(undefined), '')
    assert.equal(M.blockerText(''), '')
  })
})

describe('isSystemMount', () => {
  const system = ['/', '/boot', '/boot/efi', '/efi', '/home', '/usr', '/usr/local', '/var', '/var/log', '[SWAP]', '/run/archiso/bootmnt', '/run/archiso']
  const notSystem = ['/run/media/u/boot', '/run/media/u/STICK', '/home/u/usb', '/mnt/var', '/bootstick', '/homes', '/efi2', '/usrdata', '/run/archisox', '', null, undefined]
  for (const mp of system) test(`${mp} is a system mount`, () => assert.equal(M.isSystemMount(mp), true))
  for (const mp of notSystem) test(`${JSON.stringify(mp)} is not`, () => assert.equal(M.isSystemMount(mp), false))
})
