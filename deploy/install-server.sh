#!/usr/bin/env bash
set -euo pipefail

[[ $(id -u) -eq 0 ]] || { echo 'Run as root' >&2; exit 1; }

source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
nginx_site=/etc/nginx/sites-available/play.butafor.online

[[ -f $nginx_site ]] || { echo "Missing $nginx_site" >&2; exit 1; }

if ! id catan-deploy >/dev/null 2>&1; then
  useradd --system --home-dir /srv/catan --shell /usr/sbin/nologin catan-deploy
fi

install -d -o catan-deploy -g catan-deploy -m 0755 /srv/catan /srv/catan/releases
install -d -m 0755 /usr/local/libexec /etc/nginx/snippets
install -m 0755 "$source_dir/catan-deploy.sh" /usr/local/libexec/catan-deploy
install -m 0644 "$source_dir/catan-deploy.service" /etc/systemd/system/
install -m 0644 "$source_dir/catan-deploy.timer" /etc/systemd/system/
install -m 0644 "$source_dir/nginx-catan.conf" /etc/nginx/snippets/catan.conf

if ! grep -Fq 'include /etc/nginx/snippets/catan.conf;' "$nginx_site"; then
  backup=$(mktemp /root/play.butafor.online.before-catan.XXXXXXXX)
  cp -- "$nginx_site" "$backup"
  python3 - "$nginx_site" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
config = path.read_text()
target = '    location / {\n'
if config.count(target) != 1:
    raise SystemExit('Expected exactly one existing root location')
path.write_text(config.replace(target, '    include /etc/nginx/snippets/catan.conf;\n\n' + target, 1))
PY
  if ! nginx -t || ! systemctl reload nginx; then
    cp -- "$backup" "$nginx_site"
    nginx -t
    systemctl reload nginx
    echo 'Restored previous Nginx configuration' >&2
    exit 1
  fi
fi

systemctl daemon-reload
systemctl enable --now catan-deploy.timer
systemctl start catan-deploy.service
