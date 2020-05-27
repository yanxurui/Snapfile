# Snapfile

An anonymous file transfer application that enables you to access files from any device without any account


## Features
* anonymous chat room
* file transfer across any devices
* expires after one day


## Change log
### Version 0.3
* drag&drop to upload files

### Version 0.2
* better at handle disconnection
* cancel uploading file

### Version 0.1
* instant messaging is implemented by websocket
* 2 messge types: text and file: text body and file name are stored in the data field of a message 
* upload
	* each folder has a corresponding path in the server where files uploaded to this folder are stored
	* uploading is handled directly in Python
* download: files are served by NGINX using `X-accel`
* backend only uses a single thread in Python


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

# 2. change default configuration
vim snapfile/config.file

# 3. install package
python setup.py -e .

# 4. start
snapfile
```

some default configuration
* PORT: The server will listen to port 8090
* LOG_FILE: Logs are output to `test.log` in the current workding directory (i.e., CWD)
* UPLOAD_ROOT_DIRECTORY: Files are stored in `./upload` in CWD

### Deploy in production (CentOS)
Run as root
```sh
bash install.sh
```

The directory structure of /var/www/snapfile
```
`-- snapfile
    |-- db
    |   `-- appendonly.aof
    |   `-- dump.rdb
    |-- files
    |   `-- 324
    |       `-- thfaxm
    |           `-- 1
    |-- logs
    |   |-- nginx_access.log
    |   |-- nginx_err.log
    |   |-- snapfile.log
    |   `-- snapfile.out
    `-- static
        |-- index.html
        |-- login.html
        |-- main.css
        |-- main.js
        `-- test.html
```

## Test

### test_api.py
Functional test for APIs of python backend:
using the classical python unittest
```sh
cd tests
python -m unittest -v -p test*.py
```

* use a separate port 8090
* select db 0 of Redis
* clean all data at startup

### test_nginx.py
Functional test for NGINX config in a production environment.

### benchmark.py
stress test for aiohttp.
