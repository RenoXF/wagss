#!/bin/bash
# WAGSS Deployment Script for Debian 12 LXC on Proxmox
# Uses external PostgreSQL server
# Usage: bash deploy.sh

set -e

APP_NAME="wagss"
APP_USER="wagss"
APP_DIR="/home/${APP_USER}"
MEDIA_DIR="/home/${APP_USER}/data/media"
LOG_DIR="/home/${APP_USER}/logs"

echo "========================================="
echo "  WAGSS Deployment for Debian LXC"
echo "========================================="

# Check root
if [ "$EUID" -ne 0 ]; then
  echo "Error: Run as root (bash deploy.sh)"
  exit 1
fi

# Check Debian version
if [ -f /etc/os-release ]; then
  . /etc/os-release
  echo "  OS: ${PRETTY_NAME:-$ID $VERSION_ID}"
fi

# ── 1. Install System Dependencies ──
echo ""
echo "[1/6] Installing system dependencies..."
apt-get update -qq
apt-get install -y -qq curl build-essential ca-certificates locales

# Ensure UTF-8 locale
if ! grep -q "en_US.UTF-8" /etc/locale.gen 2>/dev/null; then
  echo "en_US.UTF-8 UTF-8" >> /etc/locale.gen
  locale-gen en_US.UTF-8 2>/dev/null || true
fi

# ── 2. Install Bun ──
echo ""
echo "[2/6] Installing Bun..."
if ! command -v bun &> /dev/null; then
  curl -fsSL https://bun.sh/install | bash
fi
# Ensure symlink to system-wide path
BUN_BIN=$(find /root/.bun/bin /home/*/.bun/bin /usr/local/bin -name bun -type f 2>/dev/null | head -1)
if [ -z "${BUN_BIN}" ]; then
  echo "  Error: bun not found after install"
  exit 1
fi
cp "${BUN_BIN}" /usr/local/bin/bun
chmod 755 /usr/local/bin/bun
echo "  Binary: ${BUN_BIN} -> /usr/local/bin/bun"
echo "  Version: $(/usr/local/bin/bun --version)"

# ── 3. Install LibreOffice ──
echo ""
echo "[3/6] Installing LibreOffice..."
if ! command -v libreoffice &> /dev/null; then
  apt-get install -y -qq libreoffice-core libreoffice-writer libreoffice-calc libreoffice-impress --no-install-recommends
fi

# ── 4. Create User & Directories ──
echo ""
echo "[4/6] Creating user and directories..."
if ! id "${APP_USER}" &>/dev/null; then
  useradd -r -m -s /bin/bash -d /home/${APP_USER} ${APP_USER}
fi
mkdir -p ${MEDIA_DIR}/images ${MEDIA_DIR}/videos ${MEDIA_DIR}/audios ${MEDIA_DIR}/documents ${MEDIA_DIR}/stickers ${MEDIA_DIR}/converted ${LOG_DIR}
chown -R ${APP_USER}:${APP_USER} /home/${APP_USER}

# ── 5. Install Dependencies ──
echo ""
echo "[5/6] Installing dependencies..."
su - ${APP_USER} -c "cd ${APP_DIR} && /usr/local/bin/bun install"

# ── 6. Setup PM2 ──
echo ""
echo "[6/6] Setting up PM2..."
if ! command -v pm2 &> /dev/null; then
  echo "  Installing PM2..."
  npm install -g pm2
else
  echo "  PM2 already installed: $(pm2 -v)"
fi

# Stop if already running
su - ${APP_USER} -c "pm2 delete wagss 2>/dev/null || true"

# Start app
su - ${APP_USER} -c "cd ${APP_DIR} && pm2 start /usr/local/bin/bun --name wagss -- run src/index.ts"

# Save process list
su - ${APP_USER} -c "pm2 save"

# Setup auto-start on boot (needs root to write init script)
pm2 startup -u ${APP_USER} --hp /home/${APP_USER} || true

chown -R ${APP_USER}:${APP_USER} /home/${APP_USER}

echo ""
echo "========================================="
echo "  Deployment Complete!"
echo "========================================="
echo ""
echo "  Next steps:"
echo ""
echo "  1. Copy and edit .env file:"
echo "     cp ${APP_DIR}/.env.example ${APP_DIR}/.env"
echo "     nano ${APP_DIR}/.env"
echo ""
echo "     Isi DB_HOST, DB_PORT, DB_DATABASE, DB_USERNAME, DB_PASSWORD"
echo "     sesuai PostgreSQL server Anda."
echo "     Generate JWT_SECRET: openssl rand -hex 32"
echo ""
echo "  2. Restart after editing .env:"
echo "     pm2 restart wagss"
echo ""
echo "  3. Check logs:"
echo "     pm2 logs wagss"
echo ""
echo "  4. Monitor:"
echo "     pm2 monit"
echo ""
echo "  5. Access web UI:"
echo "     http://LXC_IP:3000"
echo ""
