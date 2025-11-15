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
# Check if Node.js is available
if ! command -v node &> /dev/null; then
    echo "Node.js is not available. Please install Node.js first."
    exit 1
fi

echo "Building Vue.js client..."
cd "$CLIENT_DIR"

# Install dependencies
echo "Installing npm dependencies..."
npm install

# Build the client
echo "Building client for production..."
npm run build

# Verify build output exists
if [ ! -d "$CLIENT_DIST_DIR" ]; then
    echo "Error: Build failed, dist directory not found"
    exit 1
fi

cd "$PROJECT_ROOT"

## 3. install
echo "Installing application files..."
mkdir -p $prefix/static

# Copy built client files to web directory
echo "Copying built client files to $prefix/static..."
/bin/cp -Rf "$CLIENT_DIST_DIR/." $prefix/static/

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
read -p "Please prepare https certificates for NGINX. Press enter to continue:"
systemctl restart redis
systemctl restart nginx
systemctl restart supervisord
supervisorctl start snapfile && echo "cheers!"
