set -x # echo on
set -e # exit on error

## 1. install prerequisites
packageList="nginx redis supervisor"
for p in $packageList; do
  rpm --quiet --query $p || sudo yum install -y $packageName
done

## 2. install
prefix=/var/www/snapfile
pyversion=3.8.1

mkdir -p $prefix

cwd=$(pwd)
/bin/cp -Rf $cwd/snapfile/static $prefix
ln -sf $cwd/nginx.conf /etc/nginx/conf.d/snapfile.conf
ln -sf $cwd/supervisord.ini /etc/supervisord.d/snapfile.ini
sed -i 's|appendonly no|appendonly yes|' /etc/redis.conf
sed -i 's|dir /var/lib/redis|dir /var/www/snapfile/db|' /etc/redis.conf

cd $prefix
mkdir -p files
mkdir -p logs
mkdir -p db
chown -R yxr $prefix
chown -R redis $prefix/db

sudo -i -u yxr <<EOF
    set -v
    set -e

    if [ ! -d /home/yxr/.pyenv/versions/$pyversion ]
    then
        echo "please install $pyversion using pyenv for user yxr first"
        exit 1
    fi

    cd $cwd
    pyenv local $pyversion
    pip install -e .
EOF

# NGINX 403 due to permission issue, check
# namei -om /var/www/Snapfile/snapfile/static

## 3. start
read -p "Please prepare https certificates for NGINX. Press enter to continue:"
systemctl restart redis
systemctl restart nginx
systemctl restart supervisord
