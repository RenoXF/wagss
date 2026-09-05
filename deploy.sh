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
apt-get install -y -qq curl git build-essential ca-certificates locales

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
  export PATH="$HOME/.bun/bin:$PATH"
  echo 'export PATH="$HOME/.bun/bin:$PATH"' >> /etc/profile.d/bun.sh
  echo "  Installed: $(bun --version)"
else
  echo "  Already installed: $(bun --version)"
fi

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

# ── 5. Setup Repository ──
echo ""
echo "[5/6] Setting up repository..."
if [ -d "${APP_DIR}/.git" ]; then
  echo "  Repository already exists at ${APP_DIR}"
  cd ${APP_DIR}
  su - ${APP_USER} -c "cd ${APP_DIR} && git pull"
else
  echo "  Cloning repository..."
  su - ${APP_USER} -c "git clone https://github.com/RenoXF/wagss.git ${APP_DIR}"
  cd ${APP_DIR}
fi

# Install dependencies
su - ${APP_USER} -c "export PATH=/home/${APP_USER}/.bun/bin:\$PATH && cd ${APP_DIR} && bun install"

# ── 6. Setup Systemd Service ──
echo ""
echo "[6/6] Setting up systemd service..."
if [ -f "${APP_DIR}/wagss.service" ]; then
  cp ${APP_DIR}/wagss.service /etc/systemd/system/${APP_NAME}.service
  systemctl daemon-reload
  systemctl enable ${APP_NAME}
else
  echo "  wagss.service not found, skipping"
fi

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
echo "  2. Start the service:"
echo "     systemctl start wagss"
echo ""
echo "  3. Check status:"
echo "     systemctl status wagss"
echo "     journalctl -u wagss -f"
echo ""
echo "  4. Access web UI:"
echo "     http://LXC_IP:3000"
echo ""
