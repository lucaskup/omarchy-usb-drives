#!/bin/bash
# Usage: open.sh <disk> <use-udiskie: 1|0>
# Mounts the drive and opens its first mount point in the file manager.
# udiskie-mount -r mounts every partition and asks for the passphrase of a
# locked LUKS drive. Without it, udisksctl mounts plain partitions only.
disk="$1"
use_udiskie="$2"
[ -n "$disk" ] || { echo "Usage: open.sh <disk> <1|0>" >&2; exit 2; }

if [ "$use_udiskie" = 1 ]; then
  udiskie-mount -r "$disk" >/dev/null 2>&1
else
  # Unmounted filesystems only: 2 columns means MOUNTPOINT was empty.
  lsblk -lnpo PATH,FSTYPE,MOUNTPOINT "$disk" \
    | awk 'NF==2 && $2!="crypto_LUKS" && $2!="swap" {print $1}' \
    | while read -r dev; do
        udisksctl mount -b "$dev" >/dev/null 2>&1
      done
fi

mp=$(lsblk -lnpo MOUNTPOINT "$disk" | awk 'NF' | head -1)
[ -n "$mp" ] || { echo "Nothing on the drive could be mounted" >&2; exit 1; }
# Detach: xdg-open can stay alive as long as the file manager window does.
setsid -f xdg-open "$mp" >/dev/null 2>&1
