#!/bin/sh
set -e

ACTION=install
case "$1" in
  configure)
    if [ -n "${2:-}" ]; then ACTION=upgrade; fi
    ;;
  2)
    ACTION=upgrade
    ;;
  1)
    ACTION=install
    ;;
esac

# Create the service account. systemd-sysusers is preferred; useradd is the
# fallback for containers and minimal images.
if ! id anycursor >/dev/null 2>&1; then
  if command -v systemd-sysusers >/dev/null 2>&1; then
    systemd-sysusers /usr/lib/sysusers.d/anycursor.conf >/dev/null 2>&1 || true
  fi
fi
if ! id anycursor >/dev/null 2>&1; then
  if command -v useradd >/dev/null 2>&1; then
    useradd --system --home-dir /var/lib/anycursor --shell /usr/sbin/nologin \
      --user-group anycursor >/dev/null 2>&1 || true
  fi
fi

if command -v systemd-tmpfiles >/dev/null 2>&1; then
  systemd-tmpfiles --create /usr/lib/tmpfiles.d/anycursor.conf >/dev/null 2>&1 || true
fi

install -d -m 0750 -o anycursor -g anycursor /etc/anycursor 2>/dev/null || mkdir -p /etc/anycursor

# Seed once. Never overwrite an existing config or environment file.
if [ ! -e /etc/anycursor/config.json ]; then
  install -m 0600 -o anycursor -g anycursor \
    /usr/lib/anycursor/config/anycursor.linux.example.json \
    /etc/anycursor/config.json
fi
if [ ! -e /etc/anycursor/anycursor.env ]; then
  install -m 0600 -o anycursor -g anycursor \
    /usr/lib/anycursor/config/anycursor.env.example \
    /etc/anycursor/anycursor.env
fi

chown anycursor:anycursor /etc/anycursor /etc/anycursor/config.json /etc/anycursor/anycursor.env 2>/dev/null || true
chmod 0750 /etc/anycursor 2>/dev/null || true
chmod 0600 /etc/anycursor/config.json /etc/anycursor/anycursor.env 2>/dev/null || true

# Standard paths only; a custom SELinux module is not needed unless local policy
# labels differ. restorecon is best effort and harmless elsewhere.
if command -v restorecon >/dev/null 2>&1; then
  restorecon -R /etc/anycursor /var/lib/anycursor /usr/lib/anycursor >/dev/null 2>&1 || true
fi

if [ -d /run/systemd/system ]; then
  systemctl daemon-reload >/dev/null 2>&1 || true
  systemctl enable anycursor.service >/dev/null 2>&1 || true
  if [ "$ACTION" = upgrade ]; then
    systemctl try-restart anycursor.service >/dev/null 2>&1 || true
  else
    systemctl restart anycursor.service >/dev/null 2>&1 \
      || systemctl start anycursor.service >/dev/null 2>&1 || true
  fi
fi

cat <<'EOF'
AnyCursor is installed. Configure it before exposing it:
  /etc/anycursor/config.json
  /etc/anycursor/anycursor.env

Loopback-only default: http://127.0.0.1:43110/
Remote access requires ANY_CURSOR_ACCESS_TOKEN and a non-loopback gateway.host.
See /usr/share/doc/anycursor/README.linux.md.
EOF

exit 0
