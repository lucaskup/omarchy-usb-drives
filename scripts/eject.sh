#!/bin/bash
# Usage: eject.sh <disk>
# 0. Refuse drives the running system is using.
# 1. Unmount every mounted filesystem, deepest first. If one is busy, name
#    the programs holding it (see holders.sh).
# 2. Lock every unlocked LUKS container (power-off refuses while one is open).
# 3. Power the drive off so it is safe to pull.
# udisks lets the active session do all three without a password.
disk="$1"
[ -n "$disk" ] || { echo "Usage: eject.sh <disk>" >&2; exit 2; }

here=$(dirname "$0")

# Never eject the drive the system is running from (Omarchy on a USB stick,
# or the live installer). The popup already hides such drives; this guards
# the script itself. Keep in sync with SYSTEM_MOUNT in Model.js.
# With -l, lsblk puts each extra mount point of a device on its own line.
system_mount='^(/|/boot(/.*)?|/efi|/home|/usr(/.*)?|/var(/.*)?|\[SWAP\]|/run/archiso(/.*)?)$'
if held=$(lsblk -lnpo MOUNTPOINTS "$disk" | grep -E -m1 "$system_mount"); then
  echo "Refusing to eject $disk: the running system uses it ($held)" >&2
  exit 3
fi

lsblk -lnpo PATH,MOUNTPOINT "$disk" | awk 'NF>1 {print $1}' | tac | while read -r dev; do
  if ! err=$(udisksctl unmount -b "$dev" 2>&1 >/dev/null); then
    apps=$(bash "$here/holders.sh" "$dev")
    if [ -n "$apps" ]; then echo "Still in use by: $apps" >&2; else echo "$err" >&2; fi
    exit 1
  fi
done || exit 1

lsblk -lnpo PATH,FSTYPE "$disk" | awk '$2=="crypto_LUKS" {print $1}' | tac | while read -r dev; do
  if lsblk -lnpo TYPE "$dev" | grep -qx crypt; then
    udisksctl lock -b "$dev" >/dev/null || exit 1
  fi
done || exit 1

udisksctl power-off -b "$disk"
