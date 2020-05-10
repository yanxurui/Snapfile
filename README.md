# File Transfer

an anonymous file transfer application that enables you to access the file from any device without any account

## Change log
### Version 0.1

* instant messaging is implemented by websocket
* 2 messge types: text and file: text body and file name are stored in the data field of a message 
* upload
	* each folder has a corresponding path in the server where files uploaded to this folder are stored
	* uploading is handled directly in Python
* download: files are served by NGINX using `X-accel`



## Test
```bash
cd tests
python -m unittest
```

## Deploy
For CentOS

run as yxr
```
clone project to /home/yxr/CloudUDisk/
```

run as root
```
ln -sf /home/yxr/CloudUDisk/nginx.conf /etc/nginx/
mkdir -p /var/www/clouddisk/
chown -R yxr /var/www/clouddisk/

<!--
ln -s /home/yxr/CloudUDisk/src/static /var/www/clouddisk/static
does not work
403 due to permission issue
namei -om /var/www/clouddisk/static
-->

/bin/cp -r /home/yxr/CloudUDisk/src/static /var/www/clouddisk/
mkdir /var/www/clouddisk/files
```

