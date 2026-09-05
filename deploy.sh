#!/bin/bash
# WAGSS Deployment Script for Debian 12 LXC on Proxmox
# Usage: bash deploy.sh
# Run as root inside the LXC container

set -e

APP_NAME="wagss"
APP_USER="wagss"
APP_DIR="/opt/${APP_NAME}"
DB_NAME="whatsapp"
DB_USER="wagss"
MEDIA_DIR="/var/lib/${APP_NAME}/media"
LOG_DIR="/var/log/${APP_NAME}"

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
else
  echo "Warning: Cannot detect OS version"
fi

# 1. Install system dependencies
echo ""
echo "[1/8] Installing system dependencies..."
apt-get update -qq
apt-get install -y -qq curl git build-essential libpq-dev ca-certificates locales sudo

# Ensure UTF-8 locale (required by PostgreSQL)
if ! grep -q "en_US.UTF-8" /etc/locale.gen 2>/dev/null; then
  echo "en_US.UTF-8 UTF-8" >> /etc/locale.gen
  locale-gen en_US.UTF-8 2>/dev/null || true
fi

# 2. Install Bun
echo ""
echo "[2/8] Installing Bun..."
if ! command -v bun &> /dev/null; then
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
  echo 'export PATH="$HOME/.bun/bin:$PATH"' >> /etc/profile.d/bun.sh
  echo "  Installed: $(bun --version)"
else
  echo "  Already installed: $(bun --version)"
fi

# 3. Install PostgreSQL
echo ""
echo "[3/8] Installing PostgreSQL..."
if ! command -v psql &> /dev/null; then
  apt-get install -y -qq postgresql postgresql-contrib
fi
systemctl enable postgresql
systemctl start postgresql

# 4. Install LibreOffice (headless)
echo ""
echo "[4/8] Installing LibreOffice..."
if ! command -v libreoffice &> /dev/null; then
  apt-get install -y -qq libreoffice-core libreoffice-writer libreoffice-calc libreoffice-impress --no-install-recommends
fi

# 5. Create system user and directories
echo ""
echo "[5/8] Creating system user and directories..."
if ! id "${APP_USER}" &>/dev/null; then
  useradd -r -m -s /bin/bash -d /home/${APP_USER} ${APP_USER}
fi
mkdir -p ${MEDIA_DIR}/images ${MEDIA_DIR}/videos ${MEDIA_DIR}/audios ${MEDIA_DIR}/documents ${MEDIA_DIR}/stickers ${MEDIA_DIR}/converted ${LOG_DIR}
chown -R ${APP_USER}:${APP_USER} ${MEDIA_DIR} ${LOG_DIR}

# 6. Clone or update repo
echo ""
echo "[6/8] Setting up application..."
if [ -d "${APP_DIR}" ]; then
  echo "  Updating existing installation..."
  cd ${APP_DIR}
  sudo -u ${APP_USER} git pull
else
  echo "  Cloning repository..."
  REPO_URL="${GIT_REPO_URL:-https://github.com/yourusername/wagss.git}"
  sudo -u ${APP_USER} git clone ${REPO_URL} ${APP_DIR}
  cd ${APP_DIR}
fi

# Install dependencies
sudo -u ${APP_USER} bash -c "export PATH=/home/${APP_USER}/.bun/bin:\$PATH && cd ${APP_DIR} && bun install"

# 7. Setup database
echo ""
echo "[7/8] Setting up database..."
DB_PASS=$(openssl rand -hex 16)
JWT_SECRET=$(openssl rand -hex 32)

sudo -u postgres psql -c "CREATE USER ${DB_USER} WITH PASSWORD '${DB_PASS}';" 2>/dev/null || true
sudo -u postgres psql -c "CREATE DATABASE ${DB_NAME} OWNER ${DB_USER};" 2>/dev/null || true
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE ${DB_NAME} TO ${DB_USER};" 2>/dev/null || true

# Run migrations
sudo -u ${APP_USER} bash -c "export PATH=/home/${APP_USER}/.bun/bin:\$PATH && cd ${APP_DIR} && DB_USERNAME=${DB_USER} DB_PASSWORD=${DB_PASS} DB_DATABASE=${DB_NAME} bun run db:migrate"

# 8. Create .env file
echo ""
echo "[8/8] Creating configuration..."
LIBREOFFICE_BIN=$(which libreoffice 2>/dev/null || echo "/usr/bin/libreoffice")

if [ ! -f "${APP_DIR}/.env" ]; then
  cat > ${APP_DIR}/.env << EOF
DB_CONNECTION=pgsql
DB_HOST=127.0.0.1
DB_PORT=5432
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
else
  echo "  .env already exists, skipping"
fi

# Setup systemd service
echo ""
echo "Setting up systemd service..."
cp ${APP_DIR}/wagss.service /etc/systemd/system/${APP_NAME}.service
systemctl daemon-reload
systemctl enable ${APP_NAME}

echo ""
echo "========================================="
echo "  Deployment Complete!"
echo "========================================="
echo ""
echo "  Next steps:"
echo "  1. Edit .env to add DEFAULT_USERS with your passwords"
echo "     nano ${APP_DIR}/.env"
echo ""
echo "  2. Start the service"
echo "     systemctl start ${APP_NAME}"
echo ""
echo "  3. Check status"
echo "     systemctl status ${APP_NAME}"
echo "     journalctl -u ${APP_NAME} -f"
echo ""
echo "  4. Access web UI"
echo "     http://YOUR_LXC_IP:3000"
echo ""
echo "  5. Proxmox NAT (run on Proxmox host)"
echo "     iptables -t nat -A PREROUTING -i <public_iface> -p tcp --dport 3000 -j DNAT --to-destination <LXC_IP>:3000"
echo ""
echo "  Database: ${DB_NAME}"
echo "  DB User: ${DB_USER}"
echo "  DB Pass: ${DB_PASS}"
echo "  (saved in ${APP_DIR}/.env)"
echo ""
