#!/bin/sh
set -e

if [ -d /run/systemd/system ]; then
  systemctl daemon-reload >/dev/null 2>&1 || true
fi

# Deliberately keep /etc/anycursor and /var/lib/anycursor. Removing user data
# is an explicit operator action, not a package side effect.
exit 0
