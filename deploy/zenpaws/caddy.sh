#!/bin/bash
# Writes the Caddy front-end config for the self-hosted install, validates it,
# and reloads Caddy. When /etc/zenpaws/registration-closed exists, public
# practice sign-up is turned off (sign-in, password reset and invites still work).
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run with sudo"; exit 1; }

DOMAIN="${ZENPAWS_DOMAIN:-app.zenpawsdvm.com}"
SIGNUP_RULES=""
if [ -f /etc/zenpaws/registration-closed ]; then
  SIGNUP_RULES=$(cat <<'EOF'
  # Public practice sign-up is closed on this server.
  @signup path /register /register/*
  redir @signup /login 302
  @signupApi path_regexp signupapi ^/api/trpc/(.*,)?auth\.register(,.*)?$
  respond @signupApi "Registration is closed on this server." 403
EOF
)
fi

STATIC_DIR=/opt/openvpm/apps/web/.next/standalone/apps/web/.next/static

cat > /etc/caddy/Caddyfile <<EOF
${DOMAIN} {
  encode zstd gzip
${SIGNUP_RULES}
  # Serve build assets from disk. Next's standalone server only matches the
  # exact percent-encoding of route-segment paths like %5Bid%5D, so a client
  # or proxy that normalizes the URL would otherwise get 404 for page chunks.
  handle_path /_next/static/* {
    root * ${STATIC_DIR}
    header Cache-Control "public, max-age=31536000, immutable"
    file_server
  }

  reverse_proxy 127.0.0.1:3000 {
    # Next.js builds redirects from its internal address; send visitors to the public one.
    header_down Location ^https?://(localhost|127\\.0\\.0\\.1):3000 https://${DOMAIN}
  }
}
EOF

sudo -u caddy test -r "${STATIC_DIR}/chunks" || echo "WARN: caddy cannot read ${STATIC_DIR}; static assets will 404"
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl reload caddy
echo "Caddy reloaded (registration $( [ -f /etc/zenpaws/registration-closed ] && echo closed || echo open ))"
