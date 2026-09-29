import QtQuick
import qs.Commons
import qs.Ui
import "Model.js" as Model

// Bar icon that appears only while a USB drive is plugged in. The popup lists
// each drive with its size and mount point, and offers open and eject actions.
// This file is only the UI; Service.qml tracks the drives.
Panel {
  id: root
  moduleName: "lucaskup.usb-drives"
  ipcTarget: "lucaskup.usb-drives"

  readonly property string usbIcon: "󰕓"     // nf-md-usb
  readonly property string ejectIcon: "󰇪"   // nf-md-eject
  readonly property string folderIcon: "󰝰"  // nf-md-folder_open

  // All drive state and actions live in Service.qml, shared by every
  // monitor's copy of this widget.
  readonly property var service: bar && bar.shell ? bar.shell.serviceFor("lucaskup.usb-drives") : null
  readonly property var drives: service ? service.drives : []
  readonly property string busyPath: service ? service.busyPath : ""
  readonly property var rates: service ? service.rates : ({})
  readonly property var blockers: service ? service.blockers : ({})
  readonly property bool present: drives.length > 0

  readonly property var missing: service ? service.missing : []

  // Settings (manifest.json → barWidget.schema), editable per widget entry.
  readonly property bool showUsageOnBar: setting("showUsageOnBar", false) === true
  readonly property bool showConnection: setting("showConnection", true) !== false
  readonly property bool showTransferSpeed: setting("showTransferSpeed", true) !== false
  readonly property bool notifyOnEject: setting("notifyOnEject", true) !== false

  readonly property string barUsage: Model.barUsage(drives)
  readonly property bool showBarText: showUsageOnBar && barUsage !== "" && !(bar && bar.vertical)

  property int selectedIndex: 0
  property bool cursorActive: false
  property bool watchingRates: false

  function openDrive(drive) { if (service) service.openDrive(drive); close() }
  function ejectDrive(drive) { if (service) service.ejectDrive(drive, !notifyOnEject) }

  function setWatching(on) {
    if (!service || watchingRates === on) return
    watchingRates = on
    service.watchRates(on)
  }

  onOpenedChanged: {
    setWatching(opened && showTransferSpeed)
    if (opened) {
      if (service) service.refresh()
      cursorActive = false
      selectedIndex = 0
    }
  }

  onDrivesChanged: if (selectedIndex >= drives.length) selectedIndex = Math.max(0, drives.length - 1)
  onPresentChanged: if (!present) close()
  Component.onDestruction: setWatching(false)

  visible: present
  implicitWidth: present ? button.implicitWidth : 0
  implicitHeight: present ? button.implicitHeight : 0

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: root.showBarText ? root.barUsage + " " + root.usbIcon : root.usbIcon
    slotSize: Style.bar.iconSlot * (root.showBarText ? 2 : 1)
    tooltipText: root.drives.length === 1
      ? root.drives[0].name
      : root.drives.length + " USB drives"
    onPressed: function(b) {
      if (b === Qt.RightButton && root.drives.length > 0) root.openDrive(root.drives[0])
      else if (b === Qt.MiddleButton && root.drives.length === 1) root.ejectDrive(root.drives[0])
      else root.toggle()
    }
  }

  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened && root.present
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(340))
    contentHeight: panel.fittedContentHeight(column.implicitHeight)

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onMoveRequested: function(dx, dy) {
        if (!root.cursorActive) { root.cursorActive = true; return }
        var delta = dy !== 0 ? dy : dx
        root.selectedIndex = Math.max(0, Math.min(root.drives.length - 1, root.selectedIndex + delta))
      }
      onActivateRequested: if (root.cursorActive) root.openDrive(root.drives[root.selectedIndex])
      onDeleteRequested: if (root.cursorActive) root.ejectDrive(root.drives[root.selectedIndex])
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }

      Column {
        id: column
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: parent.top
        spacing: Style.space(14)

        // ---------- Hero ----------
        Row {
          width: parent.width
          spacing: Style.space(14)

          Text {
            id: heroIcon
            textFormat: Text.PlainText
            text: root.usbIcon
            color: root.bar.foreground
            font.family: root.bar.fontFamily
            font.pixelSize: Style.font.display
            anchors.verticalCenter: parent.verticalCenter
          }

          Column {
            anchors.verticalCenter: parent.verticalCenter
            spacing: Style.space(2)

            Text {
              text: "USB drives"
              color: root.bar.foreground
              font.family: root.bar.fontFamily
              font.pixelSize: Style.font.title
              font.bold: true
            }

            Text {
              textFormat: Text.PlainText
              text: (root.drives.length + " CONNECTED")
              color: Qt.darker(root.bar.foreground, 1.4)
              font.family: root.bar.fontFamily
              font.pixelSize: Style.font.caption
              font.bold: true
              font.letterSpacing: 1.2
            }
          }
        }

        PanelSeparator { foreground: root.bar.foreground }

        Text {
          visible: root.missing.length > 0
          width: parent.width
          wrapMode: Text.WordWrap
          textFormat: Text.PlainText
          text: "Missing: " + root.missing.map(Model.missingHint).join(", ")
            + ". Some actions will not work until installed."
          color: root.bar.urgent
          font.family: root.bar.fontFamily
          font.pixelSize: Style.font.bodySmall
        }

        Column {
          width: parent.width
          spacing: Style.space(4)

          Repeater {
            model: root.drives
            DriveRow {
              required property var modelData
              required property int index
              drive: modelData
              rowIndex: index
            }
          }
        }
      }
    }
  }

  component DriveRow: CursorSurface {
    id: row
    property var drive: ({})
    property int rowIndex: 0
    readonly property bool busy: root.busyPath === drive.path
    readonly property var rate: root.rates[drive.dev]
    readonly property string rateText: Model.rateText(rate)
    readonly property string blockerText: Model.blockerText(root.blockers[drive.path])

    width: parent ? parent.width : 0
    implicitHeight: rowContent.implicitHeight + Style.space(12)
    hasCursor: root.cursorActive && root.selectedIndex === rowIndex
    foreground: root.bar.foreground

    MouseArea {
      anchors.fill: parent
      hoverEnabled: true
      cursorShape: Qt.PointingHandCursor
      onContainsMouseChanged: if (containsMouse) { root.cursorActive = true; root.selectedIndex = row.rowIndex }
      onClicked: root.openDrive(row.drive)
    }

    Item {
      id: rowContent
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.verticalCenter: parent.verticalCenter
      anchors.leftMargin: Style.space(8)
      anchors.rightMargin: Style.space(4)
      implicitHeight: Math.max(labels.implicitHeight, actions.implicitHeight)

      Column {
        id: labels
        anchors.left: parent.left
        anchors.right: actions.left
        anchors.rightMargin: Style.space(8)
        anchors.verticalCenter: parent.verticalCenter
        spacing: Style.space(2)

        Text {
          width: parent.width
          textFormat: Text.PlainText
          text: row.drive.name || ""
          color: root.bar.foreground
          font.family: root.bar.fontFamily
          font.pixelSize: Style.font.body
          font.bold: true
          elide: Text.ElideRight
        }

        Text {
          width: parent.width
          textFormat: Text.PlainText
          text: row.busy
            ? "Ejecting…"
            : row.drive.size + " · " + (row.drive.mounted ? row.drive.mounts.join(", ") : (row.drive.locked ? "Locked" : "Not mounted"))
          color: root.bar.foreground
          opacity: 0.6
          font.family: root.bar.fontFamily
          font.pixelSize: Style.font.bodySmall
          elide: Text.ElideMiddle
        }

        Text {
          visible: text !== ""
          width: parent.width
          wrapMode: Text.WordWrap
          textFormat: Text.PlainText
          text: row.busy ? "" : row.blockerText
          color: root.bar.urgent
          font.family: root.bar.fontFamily
          font.pixelSize: Style.font.bodySmall
        }

        Item {
          visible: row.drive.total > 0
          width: parent.width
          implicitHeight: Style.space(4)

          Rectangle {
            id: track
            anchors.fill: parent
            radius: height / 2
            color: Qt.rgba(root.bar.foreground.r, root.bar.foreground.g, root.bar.foreground.b, 0.12)
          }

          Rectangle {
            anchors.left: track.left
            height: track.height
            radius: track.radius
            width: Math.max(track.height, track.width * row.drive.usedFraction)
            color: row.drive.usedFraction >= 0.9 ? root.bar.urgent : root.bar.foreground
            Behavior on width { NumberAnimation { duration: 320; easing.type: Easing.OutCubic } }
          }
        }

        Text {
          visible: text !== ""
          width: parent.width
          textFormat: Text.PlainText
          text: row.drive.usage || ""
          color: root.bar.foreground
          opacity: 0.6
          font.family: root.bar.fontFamily
          font.pixelSize: Style.font.bodySmall
          elide: Text.ElideRight
        }

        Text {
          visible: text !== ""
          width: parent.width
          textFormat: Text.PlainText
          text: root.showConnection ? (row.drive.link || "") : ""
          color: root.bar.foreground
          opacity: 0.6
          font.family: root.bar.fontFamily
          font.pixelSize: Style.font.bodySmall
          elide: Text.ElideRight
        }

        Text {
          visible: text !== ""
          width: parent.width
          textFormat: Text.PlainText
          text: root.showTransferSpeed ? row.rateText : ""
          color: root.bar.foreground
          opacity: 0.6
          font.family: root.bar.fontFamily
          font.pixelSize: Style.font.bodySmall
          elide: Text.ElideRight
        }
      }

      Row {
        id: actions
        anchors.right: parent.right
        anchors.verticalCenter: parent.verticalCenter
        spacing: Style.space(4)

        PanelActionButton {
          iconText: root.folderIcon
          tooltipText: row.drive.mounted ? "Open" : (row.drive.locked ? "Unlock and open" : "Mount and open")
          foreground: root.bar.foreground
          fontFamily: root.bar.fontFamily
          enabled: !row.busy
          onClicked: root.openDrive(row.drive)
        }

        PanelActionButton {
          iconText: root.ejectIcon
          tooltipText: "Eject"
          foreground: root.bar.foreground
          hoverColor: root.bar.urgent
          fontFamily: root.bar.fontFamily
          enabled: !row.busy
          onClicked: root.ejectDrive(row.drive)
        }
      }
    }
  }
}
