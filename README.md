# File Transfer

an anonymous file transfer application that enables you to access the file from any device without any account


## Features
	* anonymous chat room
	* file transferring across any devices
	* expires after one day


## Change log
### Version 0.1
* instant messaging is implemented by websocket
* 2 messge types: text and file: text body and file name are stored in the data field of a message 
* upload
	* each folder has a corresponding path in the server where files uploaded to this folder are stored
	* uploading is handled directly in Python
* download: files are served by NGINX using `X-accel`


## Install & Run

### Getting started quickly
prerequisites

* Python 3.8
* Redis

```sh
# 1. download source code
cd
git clone https://github.com/yanxurui/Snapfile
cd Snapfile

# 2. change configuration
vim snapfile/config.file

# 3. install package
# for production
python setup.py .
# for development
# python setup.py . e

# 4. start
snapfile
```

some default configuration when `PROD = False`
* PORT: The server will listen to port 8090 by default
* LOG_FILE: Logs are output to test.log in the current workding directory (i.e., CWD)
* UPLOAD_ROOT_DIRECTORY: Files are stored in ./upload in CWD

### Deploy in production (CentOS)
todo


## Test
using the classical python unittest
```sh
python -m unittest -v -p test*.py
```

### test_api.py
Functional test for APIs of python backend:
* use a separate port 8090
* select db 0 of Redis
* clean all data at startup

### test_nginx.py
Functional test for NGINX config in a production environment.

### benchmark.py
stress test for aiohttp.
