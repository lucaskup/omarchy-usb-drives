import QtQuick
import Quickshell
import Quickshell.Io
import "Model.js" as Model

// Single shared instance that tracks USB drives for every bar widget. The bar
// creates one widget per monitor; keeping the udisks monitor, lsblk scans and
// eject jobs here means they run once no matter how many screens there are.
// Decisions and parsing live in Model.js; the shell work lives in scripts/.
Item {
  id: root

  property var shell: null
  property var manifest: null

  property var drives: []
  property string busyPath: ""
  // Live throughput per disk name: { sda: { read: bytesPerSec, write: bytesPerSec } }
  property var rates: ({})
  property var lastStat: ({})
  // Widgets with an open popup; rates are only sampled while this is > 0.
  property int rateWatchers: 0
  // Programs keeping a drive busy after a failed eject: { "/dev/sda": "vim" }.
  property var blockers: ({})
  property string lastHolderPath: ""
  // Tools that were not found on PATH; filled in at startup.
  property var missing: []

  readonly property bool present: drives.length > 0

  function script(name) {
    return Model.urlToPath(Qt.resolvedUrl("scripts/" + name))
  }

  function refresh() {
    if (!listProc.running) listProc.running = true
  }

  function watchRates(on) {
    rateWatchers = Math.max(0, rateWatchers + (on ? 1 : -1))
    if (rateWatchers === 0) { lastStat = ({}); rates = ({}) }
  }

  function formatRate(bytes) { return Model.formatRate(bytes) }

  function notify(n) {
    if (!n) return
    if (missing.indexOf("notify-send") >= 0) {
      console.warn("usb-drives: " + n.title + ": " + n.body)
      return
    }
    Quickshell.execDetached(Model.notifyCommand(n.title, n.body, n.urgent))
  }

  function openDrive(drive) {
    var plan = Model.openPlan(drive, missing)
    if (plan.kind === "error") notify({ title: plan.title, body: plan.body, urgent: true })
    else if (plan.kind === "open") Quickshell.execDetached(["xdg-open", plan.path])
    else if (plan.kind === "mount" && !openProc.running) {
      openProc.driveName = drive.name
      openProc.command = ["bash", script("open.sh"), drive.path, plan.useUdiskie ? "1" : "0"]
      openProc.running = true
    }
  }

  function ejectDrive(drive, quiet) {
    var plan = Model.ejectPlan(drive, missing, ejectProc.running)
    if (plan.kind === "error") notify({ title: plan.title, body: plan.body, urgent: true })
    if (plan.kind !== "eject") return
    busyPath = drive.path
    blockers = Model.afterEject(blockers, drive.path, 0, "")
    ejectProc.drivePath = drive.path
    ejectProc.driveName = drive.name
    ejectProc.quiet = quiet === true
    ejectProc.command = ["bash", script("eject.sh"), drive.path]
    ejectProc.running = true
  }

  Component.onCompleted: {
    depProc.running = true
    refresh()
  }

  Process {
    id: depProc
    command: ["bash", root.script("deps.sh")]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        root.missing = Model.parseMissing(text)
        if (root.missing.length) console.warn("usb-drives: missing tools: " + root.missing.join(", "))
      }
    }
  }

  Process {
    id: listProc
    command: ["bash", root.script("list.sh")]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var next = Model.parseDrives(text)
        if (!next) return
        root.drives = next
        root.blockers = Model.pruneBlockers(root.blockers, next)
      }
    }
  }

  // udisks reports plug, unplug, mount, unmount, unlock and lock events here;
  // each burst of output triggers one debounced rescan.
  Process {
    id: monitorProc
    running: true
    command: ["udisksctl", "monitor"]
    stdout: SplitParser { onRead: function(line) { debounce.restart() } }
    onExited: restartMonitor.start()
  }

  Timer { id: restartMonitor; interval: 5000; onTriggered: monitorProc.running = true }
  Timer { id: debounce; interval: 400; onTriggered: root.refresh() }
  // Fallback in case the monitor misses something.
  Timer { interval: 15000; running: true; repeat: true; onTriggered: root.refresh() }
  // Writes change used space without any udisks event, so rescan more often
  // while a popup is showing it.
  Timer { interval: 3000; running: root.rateWatchers > 0 && root.present; repeat: true; onTriggered: root.refresh() }

  // Sample /sys/block/<disk>/stat once a second while any popup is open.
  Process {
    id: statProc
    command: ["bash", root.script("stat.sh")].concat(root.drives.map(function(d) { return d.dev }))
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var next = Model.computeRates(root.lastStat, text, Date.now())
        root.lastStat = next.stat
        root.rates = next.rates
      }
    }
  }

  Timer {
    interval: 1000
    running: root.rateWatchers > 0 && root.present
    repeat: true
    triggeredOnStart: true
    onTriggered: if (!statProc.running) statProc.running = true
  }

  // While a popup is open, re-check who holds each blocked drive, so the row
  // updates as programs are closed and clears once the drive is free.
  Process {
    id: holdersProc
    property string drivePath: ""
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.blockers = Model.updateHolders(root.blockers, holdersProc.drivePath, text)
    }
  }

  Timer {
    interval: 2000
    running: root.rateWatchers > 0 && Object.keys(root.blockers).length > 0
    repeat: true
    onTriggered: {
      if (holdersProc.running) return
      var path = Model.nextBlockerPath(root.blockers, root.lastHolderPath)
      if (!path) return
      root.lastHolderPath = path
      holdersProc.drivePath = path
      holdersProc.command = ["bash", root.script("holders.sh"), path]
      holdersProc.running = true
    }
  }

  Process {
    id: openProc
    property string driveName: ""
    stderr: StdioCollector { id: openErr; waitForEnd: true }
    onExited: function(exitCode) {
      root.notify(Model.openResult(driveName, exitCode, openErr.text))
      root.refresh()
    }
  }

  Process {
    id: ejectProc
    property string driveName: ""
    property string drivePath: ""
    property bool quiet: false
    stderr: StdioCollector { id: ejectErr; waitForEnd: true }
    onExited: function(exitCode) {
      root.busyPath = ""
      root.blockers = Model.afterEject(root.blockers, drivePath, exitCode, ejectErr.text)
      root.notify(Model.ejectResult(driveName, exitCode, ejectErr.text, quiet))
      root.refresh()
    }
  }
}
