// Pure logic for the USB drives plugin: parsing lsblk/sysfs output,
// formatting, and deciding what an action should do. Nothing here touches
// QML or runs processes, so it can be unit-tested outside the shell
// (see tests/model.test.mjs).

var PACKAGES = {
  "udisksctl": "udisks2",
  "udiskie-mount": "udiskie",
  "notify-send": "libnotify",
  "xdg-open": "xdg-utils"
}

function formatSize(bytes) {
  var units = ["B", "KB", "MB", "GB", "TB"]
  var value = Number(bytes) || 0
  var i = 0
  while (value >= 1000 && i < units.length - 1) { value /= 1000; i++ }
  return (value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)) + " " + units[i]
}

function formatRate(bytesPerSec) {
  return formatSize(bytesPerSec) + "/s"
}

// USB link speed from sysfs (Mb/s) to a readable label.
function linkLabel(mbps) {
  var n = Number(mbps) || 0
  if (n <= 0) return ""
  if (n <= 12) return "USB 1.1 · 12 Mb/s"
  if (n <= 480) return "USB 2.0 · 480 Mb/s"
  return "USB 3 · " + (n / 1000) + " Gb/s"
}

// Flatten a device's subtree. LUKS nests the real filesystem one level
// deeper (disk → partition → crypt), so the direct children are not enough.
function descendants(dev) {
  var out = []
  var kids = (dev && dev.children) || []
  for (var i = 0; i < kids.length; i++) {
    out.push(kids[i])
    out = out.concat(descendants(kids[i]))
  }
  return out
}

function mountsOf(dev) {
  var list = []
  var points = (dev && dev.mountpoints) || []
  for (var i = 0; i < points.length; i++) if (points[i]) list.push(points[i])
  return list
}

// "<disk> <Mb/s>" lines → { disk: "Mb/s" }
function parseSpeeds(text) {
  var speeds = {}
  var lines = String(text || "").split("\n")
  for (var i = 0; i < lines.length; i++) {
    var bits = lines[i].trim().split(/\s+/)
    if (bits.length === 2) speeds[bits[0]] = bits[1]
  }
  return speeds
}

// Mount points the running system depends on. A drive holding any of them is
// never listed, even when it looks removable: that is the case when Omarchy
// itself runs from a USB stick (installed there, or the live installer, which
// mounts the stick under /run/archiso). Keep in sync with scripts/eject.sh.
var SYSTEM_MOUNT = /^(\/|\/boot(\/.*)?|\/efi|\/home|\/usr(\/.*)?|\/var(\/.*)?|\[SWAP\]|\/run\/archiso(\/.*)?)$/

function isSystemMount(mountpoint) {
  return SYSTEM_MOUNT.test(String(mountpoint || ""))
}

function holdsSystem(d) {
  var nodes = [d].concat(descendants(d))
  for (var i = 0; i < nodes.length; i++) {
    var mounts = mountsOf(nodes[i])
    for (var j = 0; j < mounts.length; j++) if (isSystemMount(mounts[j])) return true
  }
  return false
}

function isRemovableDisk(d) {
  if (!d || d.type !== "disk") return false
  if (!(d.tran === "usb" || d.hotplug === true)) return false
  return !!d.size && Number(d.size) > 0
}

function driveFromDevice(d, speeds) {
  var nodes = [d].concat(descendants(d))
  var mounts = []
  var label = ""
  var used = 0
  var total = 0
  var locked = 0
  for (var j = 0; j < nodes.length; j++) {
    var p = nodes[j]
    var pm = mountsOf(p)
    mounts = mounts.concat(pm)
    if (pm.length > 0 && p.fssize) {
      used += Number(p.fsused) || 0
      total += Number(p.fssize) || 0
    }
    // An unlocked LUKS container has its crypt mapping as a child.
    if (p.fstype === "crypto_LUKS" && !(p.children && p.children.length)) locked++
    if (!label && p.label) label = p.label
  }
  var model = [d.vendor, d.model]
    .filter(function(s) { return s && String(s).trim() })
    .map(function(s) { return String(s).trim() }).join(" ")
  return {
    path: d.path,
    dev: d.name,
    name: label || model || d.name,
    model: model,
    size: formatSize(d.size),
    mounts: mounts,
    mounted: mounts.length > 0,
    locked: locked > 0 && mounts.length === 0,
    used: used,
    total: total,
    usedFraction: total > 0 ? used / total : 0,
    usage: total > 0 ? formatSize(used) + " of " + formatSize(total) + " used" : "",
    link: linkLabel((speeds || {})[d.name])
  }
}

// Output of scripts/list.sh: lsblk JSON, a "---" line, then link speeds.
// Returns null when the JSON is unusable so callers keep their last list.
function parseDrives(raw) {
  var text = String(raw || "")
  var cut = text.indexOf("\n---\n")
  var json = cut >= 0 ? text.slice(0, cut) : text
  var speeds = parseSpeeds(cut >= 0 ? text.slice(cut + 5) : "")
  var data
  try { data = JSON.parse(json) } catch (e) { return null }
  if (!data || !Array.isArray(data.blockdevices)) return null
  var out = []
  for (var i = 0; i < data.blockdevices.length; i++) {
    var d = data.blockdevices[i]
    if (isRemovableDisk(d) && !holdsSystem(d)) out.push(driveFromDevice(d, speeds))
  }
  return out
}

// Output of scripts/stat.sh ("<disk> <fields of /sys/block/<disk>/stat>")
// against the previous sample → { stat, rates }. Rates are bytes per second.
function computeRates(lastStat, raw, now) {
  var prevAll = lastStat || {}
  var stat = {}
  var rates = {}
  var lines = String(raw || "").split("\n")
  for (var i = 0; i < lines.length; i++) {
    var f = lines[i].trim().split(/\s+/)
    if (f.length < 8) continue
    // After the name: [2] sectors read, [6] sectors written, 512 bytes each.
    var cur = { t: now, read: Number(f[3]) * 512, write: Number(f[7]) * 512 }
    if (!isFinite(cur.read) || !isFinite(cur.write)) continue
    stat[f[0]] = cur
    var prev = prevAll[f[0]]
    if (prev && now > prev.t) {
      var secs = (now - prev.t) / 1000
      rates[f[0]] = {
        read: Math.max(0, (cur.read - prev.read) / secs),
        write: Math.max(0, (cur.write - prev.write) / secs)
      }
    }
  }
  return { stat: stat, rates: rates }
}

// Below 1 KB/s counts as no traffic.
function rateText(rate) {
  if (!rate) return ""
  var parts = []
  if (rate.read >= 1024) parts.push("↓ " + formatRate(rate.read))
  if (rate.write >= 1024) parts.push("↑ " + formatRate(rate.write))
  return parts.length ? parts.join("  ") : "Idle"
}

// Bar label: used space of the fullest mounted drive, e.g. "42%".
function barUsage(drives) {
  var best = -1
  var list = drives || []
  for (var i = 0; i < list.length; i++)
    if (list[i].total > 0) best = Math.max(best, list[i].usedFraction)
  return best < 0 ? "" : Math.round(best * 100) + "%"
}

// Output of scripts/deps.sh: one missing command per line.
function parseMissing(text) {
  return String(text || "").split("\n")
    .map(function(s) { return s.trim() })
    .filter(function(s) { return s })
}

function missingHint(tool) {
  return tool + " (" + (PACKAGES[tool] || tool) + ")"
}

function has(missing, tool) {
  return (missing || []).indexOf(tool) < 0
}

// What "Open" should do for a drive, given the missing tools:
//   { kind: "open", path }            already mounted, open it
//   { kind: "mount", useUdiskie }     run scripts/open.sh
//   { kind: "error", title, body }    tell the user why not
function openPlan(drive, missing) {
  if (!drive) return { kind: "none" }
  if (!has(missing, "xdg-open"))
    return { kind: "error", title: "Cannot open " + drive.name, body: "xdg-open is not installed (package xdg-utils)" }
  if (drive.mounted) return { kind: "open", path: drive.mounts[0] }
  var udiskie = has(missing, "udiskie-mount")
  if (!udiskie && drive.locked)
    return { kind: "error", title: "Cannot unlock " + drive.name, body: "Encrypted drives need udiskie-mount (package udiskie)" }
  if (!udiskie && !has(missing, "udisksctl"))
    return { kind: "error", title: "Cannot mount " + drive.name, body: "udisksctl is not installed (package udisks2)" }
  return { kind: "mount", useUdiskie: udiskie }
}

function ejectPlan(drive, missing, busy) {
  if (!drive || busy) return { kind: "none" }
  if (!has(missing, "udisksctl"))
    return { kind: "error", title: "Cannot eject " + drive.name, body: "udisksctl is not installed (package udisks2)" }
  return { kind: "eject" }
}

// Notification after scripts/eject.sh exits, or null for none.
function ejectResult(name, exitCode, stderr, quiet) {
  if (exitCode === 0)
    return quiet ? null : { title: name + " ejected", body: "Safe to remove", urgent: false }
  var msg = String(stderr || "").trim() || "The drive may still be in use"
  return { title: "Could not eject " + name, body: msg, urgent: true }
}

function openResult(name, exitCode, stderr) {
  if (exitCode === 0) return null
  return { title: "Could not open " + name, body: String(stderr || "").trim() || "Mounting failed", urgent: true }
}

function notifyCommand(title, body, urgent) {
  var cmd = ["notify-send", "-a", "USB drives"]
  if (urgent) cmd.push("-u", "critical")
  return cmd.concat([String(title), String(body)])
}

// Qt.resolvedUrl() gives file:// URLs; Process wants a filesystem path.
function urlToPath(url) {
  return decodeURIComponent(String(url).replace(/^file:\/\//, ""))
}

// ---------------------------------------------------------------- blockers
// Programs keeping a drive busy, per drive path: { "/dev/sda": "vim, nautilus" }.
// Set when an eject fails because of them, refreshed while the popup is open
// (scripts/holders.sh), and dropped once nothing holds the drive any more.

// "Still in use by: a, b" from scripts/eject.sh → "a, b"
function parseBusy(stderr) {
  var m = /^Still in use by: (.+)$/m.exec(String(stderr || ""))
  return m ? m[1].trim() : ""
}

function copyWithout(map, key) {
  var next = {}
  for (var k in map || {}) if (k !== key) next[k] = map[k]
  return next
}

function afterEject(blockers, path, exitCode, stderr) {
  var next = copyWithout(blockers, path)
  var names = exitCode === 0 ? "" : parseBusy(stderr)
  if (names) next[path] = names
  return next
}

// Output of scripts/holders.sh for one drive.
function updateHolders(blockers, path, text) {
  if (!(path in (blockers || {}))) return blockers || {}
  var names = String(text || "").trim()
  var next = copyWithout(blockers, path)
  if (names) next[path] = names
  return next
}

// Drop drives that were unplugged or are no longer mounted.
function pruneBlockers(blockers, drives) {
  var next = {}
  var list = drives || []
  for (var k in blockers || {}) {
    for (var i = 0; i < list.length; i++)
      if (list[i].path === k && list[i].mounted) { next[k] = blockers[k]; break }
  }
  return next
}

// Which drive to re-check next, cycling through them one per tick.
function nextBlockerPath(blockers, previous) {
  var keys = Object.keys(blockers || {}).sort()
  if (keys.length === 0) return ""
  var i = keys.indexOf(previous)
  return keys[(i + 1) % keys.length]
}

function blockerText(names) {
  return names ? "In use by " + names + ". Close it and eject again." : ""
}
