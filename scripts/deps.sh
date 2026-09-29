#!/bin/bash
# Prints each tool the plugin uses that is not on PATH, one per line.
for c in udisksctl udiskie-mount notify-send xdg-open; do
  command -v "$c" >/dev/null || echo "$c"
done
exit 0
