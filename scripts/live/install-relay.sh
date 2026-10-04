#!/usr/bin/env bash
# Installs or updates the live relay host (run as root on the VM by scripts/deploy-live.ts):
# Node, Caddy (automatic HTTPS), one Occulta release, and the service that runs the desktop client
# as transaction relayer and libp2p relay. Safe to run again: each step checks what is there.
#
# Files it expects next to itself: release.tgz (git archive of the commit), node.env (the data
# password), and on the first install node-data.tgz (the encrypted data folder).
# Arguments: <node version> <relay host name> <relayer account> <network id>
set -euo pipefail

NODE_VERSION="$1"
HOST="$2"
RELAYER_ACCOUNT="$3"
NETWORK="$4"
HERE="$(cd "$(dirname "$0")" && pwd)"
RELEASE_ID="$(date -u +%Y%m%dT%H%M%SZ)"

export DEBIAN_FRONTEND=noninteractive

# Node, the same version the project is developed with.
if [ "$(/opt/node/bin/node --version 2>/dev/null)" != "$NODE_VERSION" ]; then
  apt-get update -q
  apt-get install -y -q xz-utils curl ca-certificates gnupg
  rm -rf /opt/node && mkdir -p /opt/node
  curl -fsSL "https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-linux-x64.tar.xz" | tar -xJ --strip-components=1 -C /opt/node
fi

# Caddy from its official Debian repository; it gets and renews the certificate on its own.
if ! command -v caddy >/dev/null; then
  apt-get install -y -q debian-keyring debian-archive-keyring apt-transport-https curl gnupg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q
  apt-get install -y -q caddy
fi

# A system user without a login; its home is the data folder.
id occulta >/dev/null 2>&1 || useradd --system --home-dir /var/lib/occulta --shell /usr/sbin/nologin occulta
install -d -o occulta -g occulta -m 700 /var/lib/occulta
if [ ! -d /var/lib/occulta/node ]; then
  tar -xzf "$HERE/node-data.tgz" -C /var/lib/occulta
  chown -R occulta:occulta /var/lib/occulta/node
fi
install -d -m 700 /etc/occulta
install -m 600 "$HERE/node.env" /etc/occulta/node.env

# The release: production dependencies only, then switch the "current" link to it.
install -d /opt/occulta/releases
mkdir -p "/opt/occulta/releases/$RELEASE_ID"
tar -xzf "$HERE/release.tgz" -C "/opt/occulta/releases/$RELEASE_ID"
(cd "/opt/occulta/releases/$RELEASE_ID" && PATH="/opt/node/bin:$PATH" npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error)
ln -sfn "/opt/occulta/releases/$RELEASE_ID" /opt/occulta/current
# Keep the three newest releases.
ls -1dt /opt/occulta/releases/* | tail -n +4 | xargs -r rm -rf

cat > /etc/systemd/system/occulta-node.service <<UNIT
[Unit]
Description=Occulta transaction relayer and libp2p relay (${NETWORK})
After=network-online.target
Wants=network-online.target

[Service]
User=occulta
EnvironmentFile=/etc/occulta/node.env
WorkingDirectory=/opt/occulta/current
ExecStart=/opt/node/bin/node apps/desktop/src/main.ts start --data-dir /var/lib/occulta/node --network ${NETWORK} --no-shell --log-level info --relayer --relayer-account ${RELAYER_ACCOUNT} --relayer-fee-eth 0.0001 --relayer-fee-usdg 0.01 --relayer-host 127.0.0.1 --relayer-port 8646 --libp2p-relay --libp2p-relay-host 127.0.0.1 --libp2p-relay-port 8647 --libp2p-relay-announce /dns4/${HOST}/tcp/443/wss
Restart=always
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/occulta
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT

# Browsers' libp2p connections are WebSocket upgrades; everything else is the relayer's HTTP API.
# No access log: the relay host keeps no record of who connects.
cat > /etc/caddy/Caddyfile <<CADDY
${HOST} {
	@libp2p header Upgrade websocket
	reverse_proxy @libp2p 127.0.0.1:8647
	reverse_proxy 127.0.0.1:8646
}
CADDY

systemctl daemon-reload
systemctl enable occulta-node.service caddy.service >/dev/null
systemctl restart occulta-node.service
systemctl reload caddy.service || systemctl restart caddy.service
echo "installed release $RELEASE_ID"
