#!/bin/bash
# WAGSS Deployment Script for Debian 12 LXC on Proxmox
# Uses external PostgreSQL server
# Usage: bash deploy.sh

set -e

APP_NAME="wagss"
APP_USER="wagss"
APP_DIR="/home/${APP_USER}/${APP_NAME}"
MEDIA_DIR="/home/${APP_USER}/${APP_NAME}/data/media"
LOG_DIR="/home/${APP_USER}/${APP_NAME}/logs"

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

# ── Database Configuration ──
echo ""
echo "── Database Configuration ──"
echo "Masukkan koneksi ke PostgreSQL server eksternal"
echo ""

read -p "DB Host [127.0.0.1]: " DB_HOST
DB_HOST=${DB_HOST:-127.0.0.1}

read -p "DB Port [5432]: " DB_PORT
DB_PORT=${DB_PORT:-5432}

read -p "DB Username [wagss]: " DB_USER
DB_USER=${DB_USER:-wagss}

read -s -p "DB Password: " DB_PASS
echo ""
if [ -z "$DB_PASS" ]; then
  echo "Error: DB Password wajib diisi"
  exit 1
fi

read -p "DB Database [whatsapp]: " DB_NAME
DB_NAME=${DB_NAME:-whatsapp}

# ── 1. Install System Dependencies ──
echo ""
echo "[1/7] Installing system dependencies..."
apt-get update -qq
apt-get install -y -qq curl git build-essential libpq-dev ca-certificates locales sudo postgresql-client

# Ensure UTF-8 locale
if ! grep -q "en_US.UTF-8" /etc/locale.gen 2>/dev/null; then
  echo "en_US.UTF-8 UTF-8" >> /etc/locale.gen
  locale-gen en_US.UTF-8 2>/dev/null || true
fi

# ── 2. Install Bun ──
echo ""
echo "[2/7] Installing Bun..."
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
echo "[3/7] Installing LibreOffice..."
if ! command -v libreoffice &> /dev/null; then
  apt-get install -y -qq libreoffice-core libreoffice-writer libreoffice-calc libreoffice-impress --no-install-recommends
fi

# ── 4. Create User & Directories ──
echo ""
echo "[4/7] Creating user and directories..."
if ! id "${APP_USER}" &>/dev/null; then
  useradd -r -m -s /bin/bash -d /home/${APP_USER} ${APP_USER}
fi
mkdir -p ${MEDIA_DIR}/images ${MEDIA_DIR}/videos ${MEDIA_DIR}/audios ${MEDIA_DIR}/documents ${MEDIA_DIR}/stickers ${MEDIA_DIR}/converted ${LOG_DIR}
chown -R ${APP_USER}:${APP_USER} /home/${APP_USER}/${APP_NAME}

# ── 5. Clone Repository ──
echo ""
echo "[5/7] Cloning repository..."
if [ -d "${APP_DIR}" ]; then
  echo "  Updating existing installation..."
  cd ${APP_DIR}
  sudo -u ${APP_USER} git pull
else
  sudo -u ${APP_USER} git clone https://github.com/RenoXF/wagss.git ${APP_DIR}
  cd ${APP_DIR}
fi

# Install dependencies
sudo -u ${APP_USER} bash -c "export PATH=/home/${APP_USER}/.bun/bin:\$PATH && cd ${APP_DIR} && bun install"

# ── 6. Create .env ──
echo ""
echo "[6/7] Creating .env configuration..."
JWT_SECRET=$(openssl rand -hex 32)
LIBREOFFICE_BIN=$(which libreoffice 2>/dev/null || echo "/usr/bin/libreoffice")

if [ ! -f "${APP_DIR}/.env" ]; then
  cat > ${APP_DIR}/.env << EOF
DB_CONNECTION=pgsql
DB_HOST=${DB_HOST}
DB_PORT=${DB_PORT}
DB_DATABASE=${DB_NAME}
DB_USERNAME=${DB_USER}
DB_PASSWORD=${DB_PASS}
DB_POOLED=true
JWT_SECRET=${JWT_SECRET}
PORT=3000
HOSTNAME=0.0.0.0
MEDIA_PATH=${MEDIA_DIR}
AUTO_DOWNLOAD_ALL=true
AUTO_DOWNLOAD_STICKER=true
LIBREOFFICE_PATH=${LIBREOFFICE_BIN}
NODE_ENV=production
DEFAULT_USERS=
EOF
  chown ${APP_USER}:${APP_USER} ${APP_DIR}/.env
  chmod 600 ${APP_DIR}/.env
  echo "  .env created"
else
  echo "  .env already exists, skipping"
fi

# ── 7. Setup Systemd Service ──
echo ""
echo "[7/7] Setting up systemd service..."
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
echo "  1. Edit DEFAULT_USERS di .env"
echo "     nano ${APP_DIR}/.env"
echo ""
echo "     Format: DEFAULT_USERS=[{\"username\":\"admin\",\"password\":\"YOUR_PASS\",\"displayName\":\"Admin\"}]"
echo ""
echo "  2. Start the service"
echo "     systemctl start ${APP_NAME}"
echo ""
echo "  3. Check status"
echo "     systemctl status ${APP_NAME}"
echo "     journalctl -u ${APP_NAME} -f"
echo ""
echo "  4. Access web UI"
echo "     http://LXC_IP:3000"
echo ""
echo "  DB Host: ${DB_HOST}:${DB_PORT}"
echo "  DB Name: ${DB_NAME}"
echo "  DB User: ${DB_USER}"
echo ""
