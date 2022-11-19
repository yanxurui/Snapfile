# Snapfile

An anonymous file transfer application that enables you to access files from any device without any account


## Features
* anonymous chat room
* file transfer across any devices where a modern browswer is available
* secure:
    * all user data (messages and files) will be encrypted. Since passcode is never persisted in the server side, no one except the owner can decrypt the data
    * expires automatically after one day


## Change log
### Version 0.4
* encryption & decryption

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

### Deploy in production mode (CentOS)
Change the `prefix` and `user` in `install.sh` and then run it using root
```sh
git pull
bash install.sh
```

The directory structure of `prefix`(/var/www/snapfile for example)
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


## Development

### NGINX

1. serve static files, such as html, css, etc
2. handle download efficiently
3. prevent from brute force attack
4. sharing port 443 with other services and forwarding to the backend (python web app in our case)

### Redis
keys:

* `#files:<folder identity>` int: the last file id in a given folder
* `folder:<folder identity>` str: meta data of a folder serialized in json format, like created time, quota, size, etc
* `messages::<folder identity>` list: messages (including file meta data) serialized in json format

### Supervisord
manage the lifecycle of the service
To restart the service, run the command below as root:
```
supervisorctl restart snapfile
```

### Test

need to install packages: websocket-client

#### test_api.py
Functional test for APIs of python backend:
using the classical python unittest
```sh
cd tests
python -m unittest -v test_api.py
```

* use a separate port 8090
* select db 0 of Redis
* clean all data at startup

some known issues:

The error below is due to a bug in package requests: [Revert PR 1440, do not modify cookie value by yanxurui · Pull Request #5459 · psf/requests](https://github.com/psf/requests/pull/5459)

```
json.decoder.JSONDecodeError: Expecting property name enclosed in double quotes: line 1 column 2 (char 1)
```

There might be a chance that test_api.TestExpire fails because the orphan process is cleang the data.
```
AssertionError: '1 folders found and 0 folders deleted' not found in 'xxx
```

#### test_nginx.py
Functional test for NGINX config in a production environment.

#### benchmark.py
stress test for aiohttp.
