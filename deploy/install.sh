set -x # echo on
set -e # exit on error

# Always operate from the repository root so every path is predictable
cd "$(dirname "$0")/.."

user=yxr
prefix=/var/www/snapfile
pyversion=3.12.6
PROJECT_ROOT=$(pwd)
CLIENT_DIR="$PROJECT_ROOT/client"
SERVER_DIR="$PROJECT_ROOT/server"
DEPLOY_DIR="$PROJECT_ROOT/deploy"
CLIENT_DIST_DIR="$CLIENT_DIR/dist"

## 1. install prerequisites
packageList="nginx redis supervisor npm"
for p in $packageList; do
    rpm --quiet --query $p || sudo yum install -y $p
done


## 2. build client code
# Vite 5 requires Node 18+. Official Node 18+ binaries need glibc >= 2.28, which
# this deploy target (CentOS 7, glibc 2.17) does NOT have, so we can't always
# build on the server. If a new-enough Node is present we build here; otherwise
# we fall back to a pre-built client/dist (build it on a dev machine / CI and
# copy it over), and only error out if neither is available.
REQUIRED_NODE_MAJOR=18

node_major=0
if command -v node &> /dev/null; then
    node_major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
fi

if [ "$node_major" -ge "$REQUIRED_NODE_MAJOR" ]; then
    echo "Building Vue.js client (node $(node --version))..."
    cd "$CLIENT_DIR"
    npm ci || npm install
    npm run build
    cd "$PROJECT_ROOT"
elif [ -f "$CLIENT_DIST_DIR/index.html" ]; then
    echo "Node ${REQUIRED_NODE_MAJOR}+ not found (have: $(node --version 2>/dev/null || echo none))."
    echo "Using the pre-built client already in $CLIENT_DIST_DIR."
else
    echo "ERROR: building the client needs Node ${REQUIRED_NODE_MAJOR}+, but this host has $(node --version 2>/dev/null || echo 'no node')."
    echo "On CentOS 7 (glibc 2.17) Node ${REQUIRED_NODE_MAJOR}+ cannot run, so build the client elsewhere and copy it here:"
    echo "  (dev machine) cd client && npm ci && npm run build"
    echo "  rsync -a client/dist/ ${user}@<this-host>:${CLIENT_DIST_DIR}/"
    echo "then re-run this script."
    exit 1
fi

# Verify build output exists
if [ ! -f "$CLIENT_DIST_DIR/index.html" ]; then
    echo "Error: client build output not found at $CLIENT_DIST_DIR"
    exit 1
fi

## 3. install
echo "Installing application files..."
mkdir -p $prefix/static

# Copy built client files to web directory.
# Use --delete (or clear first) so stale assets from a previous build/UI don't
# linger next to the new content-hashed files.
echo "Copying built client files to $prefix/static..."
if command -v rsync &> /dev/null; then
    rsync -a --delete "$CLIENT_DIST_DIR/" "$prefix/static/"
else
    rm -rf "${prefix:?}/static/"*
    /bin/cp -Rf "$CLIENT_DIST_DIR/." "$prefix/static/"
fi

# Setup configuration files
ln -sf "$DEPLOY_DIR/snapfile.conf" /etc/nginx/conf.d/snapfile.conf
ln -sf "$DEPLOY_DIR/supervisord.ini" /etc/supervisord.d/snapfile.ini
sed -i 's|appendonly no|appendonly yes|' /etc/redis.conf
sed -i "s|dir .*|dir ${prefix}/db|" /etc/redis.conf

cd $prefix
mkdir -p files
mkdir -p logs
mkdir -p db
chown -R $user $prefix
chown -R redis $prefix/db

sudo -i -u $user <<EOF
    set -v
    set -e

    if [ ! -d /home/$user/.pyenv/versions/$pyversion ]
    then
        echo "please install $pyversion using pyenv for user $user first"
        exit 1
    fi

    cd "$SERVER_DIR"
    pyenv local $pyversion
    pip install -e .
EOF

# NGINX 403 due to permission issue, check
# namei -om /var/www/snapfile/static

## 4. start
# Only prompt when run interactively, so non-interactive/CI runs don't hang.
if [ -t 0 ]; then
    read -p "Please ensure HTTPS certificates for NGINX are in place. Press enter to continue:" _
else
    echo "Non-interactive run: assuming HTTPS certificates for NGINX are already in place."
fi
systemctl restart redis
systemctl restart nginx
systemctl restart supervisord
supervisorctl start snapfile && echo "cheers!"
