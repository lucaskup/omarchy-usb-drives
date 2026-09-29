#!/bin/bash
# Prints lsblk's JSON view of all block devices, a "---" line, then one
# "<disk> <link speed in Mb/s>" line per SCSI disk that sits on a USB device.
# SYSFS overrides /sys for tests.
sysfs="${SYSFS:-/sys}"

lsblk -J -b -o NAME,PATH,TYPE,TRAN,HOTPLUG,SIZE,LABEL,VENDOR,MODEL,FSTYPE,FSUSED,FSSIZE,MOUNTPOINTS
echo ---
for b in "$sysfs"/block/sd*; do
  [ -e "$b" ] || continue
  p=$(readlink -f "$b/device") || continue
  # Walk up from the SCSI device until we reach the USB device, which is
  # the first ancestor with a "speed" file.
  while [ -n "$p" ] && [ "$p" != / ] && [ "$p" != "$sysfs" ]; do
    if [ -f "$p/speed" ]; then
      echo "${b##*/} $(cat "$p/speed")"
      break
    fi
    p=$(dirname "$p")
  done
done
