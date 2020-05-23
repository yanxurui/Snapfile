# DEFAULT
PROD = False
PORT = 8080
REDIS_ADDRESS = 'redis://localhost'
LOG_LEVEL = 'DEBUG'
LOG_FILE = 'test.log'
AGE = 24*60*60 # 1 day
STORAGE_PER_FOLDER = 10**9 # bytes, 1 GB by default
UPLOAD_ROOT_DIRECTORY = './upload'
# a Folder will be placed in a random second level directory named from 1 to 1024 under UPLOAD_ROOT_DIRECTORY
UPLOAD_SECOND_DIRECTORY_RANGE = 2**10
DELETE_INTERVAL = 24*60*60 # seconds i.e., daily
HEARTBEAT = 30 # seconds
RECEIVE_TIMEOUT = 3600 # 1 hour

# PROD or TEST
import os
ENV = os.environ.get('ENV')
if ENV == 'PROD':
    PROD = True
    LOG_LEVEL = 'INFO'
    LOG_FILE = '/var/www/snapfile/logs/snapfile.log'
    UPLOAD_ROOT_DIRECTORY = '/var/www/snapfile/files'
elif ENV == 'TEST':
    PORT = 8090
    AGE = 6
    STORAGE_PER_FOLDER = 10**6 # 1 MB
    DELETE_INTERVAL = 4
