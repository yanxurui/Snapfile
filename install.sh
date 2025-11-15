set -x # echo on
set -e # exit on error

user=yxr
prefix=/var/www/snapfile
pyversion=3.12.6

## 1. install prerequisites
packageList="nginx redis supervisor npm"
for p in $packageList; do
  rpm --quiet --query $p || sudo yum install -y $p
done

## 2. build client code
cwd=$(pwd)

# Check if Node.js is available
if ! command -v node &> /dev/null; then
    echo "Node.js is not available. Please install Node.js first."
    exit 1
fi

echo "Building Vue.js client..."
cd $cwd/client

# Install dependencies
echo "Installing npm dependencies..."
npm install

# Build the client
echo "Building client for production..."
npm run build

# Verify build output exists
if [ ! -d "dist" ]; then
    echo "Error: Build failed, dist directory not found"
    exit 1
fi

cd $cwd

## 3. install
echo "Installing application files..."
mkdir -p $prefix

# Copy built client files to web directory
echo "Copying built client files to $prefix..."
/bin/cp -Rf $cwd/client/dist/* $prefix/

# Setup configuration files
ln -sf $cwd/snapfile.conf /etc/nginx/conf.d/snapfile.conf
ln -sf $cwd/supervisord.ini /etc/supervisord.d/snapfile.ini
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

    cd $cwd
    pyenv local $pyversion
    pip install -e .
EOF

# NGINX 403 due to permission issue, check
# namei -om /var/www/Snapfile/client/dist

## 4. start
read -p "Please prepare https certificates for NGINX. Press enter to continue:"
systemctl restart redis
systemctl restart nginx
systemctl restart supervisord
supervisorctl start snapfile && echo "cheers!"
