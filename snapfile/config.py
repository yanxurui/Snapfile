PROD = True
PORT = 8080
REDIS_ADDRESS = 'redis://localhost'
LOG_FILE = '/var/www/snapfile/logs/snapfile.log'
LOG_LEVEL = 'INFO'
AGE = 24*60 # minutes
STORAGE_PER_FOLDER = 10**9 # bytes, 1 GB by default
UPLOAD_ROOT_DIRECTORY = '/var/www/snapfile/files'
# a Folder will be placed in a random second level directory named from 1 to 1024 under UPLOAD_ROOT_DIRECTORY
UPLOAD_SECOND_DIRECTORY_RANGE = 2**10
DELETE_INTERVAL = 24*60*60 # seconds i.e., daily
HEARTBEAT = 30 # seconds
RECEIVE_TIMEOUT = 3600 # 1 hour

# Test
import os
if os.environ.get('PROD', str(PROD)).lower() not in {'true', 'yes', '1'}:
    PROD = False
    PORT = 8090
    LOG_FILE = 'test.log'
    LOG_LEVEL = 'DEBUG'
    AGE = 1
    UPLOAD_ROOT_DIRECTORY = './upload'
    STORAGE_PER_FOLDER = 10**6 # 1 MB
    DELETE_INTERVAL = 5
