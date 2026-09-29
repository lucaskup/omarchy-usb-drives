#!/bin/bash
# Usage: holders.sh <disk-or-partition>...
# Prints the programs keeping any mounted filesystem on the given devices
# busy, as one line: "nautilus, vim". Prints nothing when nothing does, or
# when fuser is not installed.
command -v fuser >/dev/null || exit 0

for target in "$@"; do
  lsblk -lnpo PATH,MOUNTPOINT "$target" 2>/dev/null | awk 'NF>1 {print $1}'
done | while read -r dev; do
  # fuser -m accepts the mounted device and prints PIDs with access letters
  # appended, e.g. "1234c".
  for pid in $(fuser -m "$dev" 2>/dev/null); do
    pid=${pid%%[!0-9]*}
    [ -n "$pid" ] && ps -o comm= -p "$pid"
  done
done | sort -u | paste -sd, - | sed 's/,/, /g'
exit 0
