#!/bin/bash
# Usage: stat.sh <disk>...   e.g. stat.sh sda sdb
# Prints "<disk> <fields of /sys/block/<disk>/stat>" for each disk.
sysfs="${SYSFS:-/sys}"
for d in "$@"; do
  case "$d" in */*|""|.|..) continue ;; esac
  [ -r "$sysfs/block/$d/stat" ] && echo "$d $(cat "$sysfs/block/$d/stat")"
done
exit 0
