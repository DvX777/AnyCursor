#!/bin/sh
set -e

# Stop and disable only on a real removal, not on an upgrade.
case "$1" in
  remove|0)
    if [ -d /run/systemd/system ]; then
      systemctl stop anycursor.service >/dev/null 2>&1 || true
      systemctl disable anycursor.service >/dev/null 2>&1 || true
    fi
    ;;
esac

exit 0
