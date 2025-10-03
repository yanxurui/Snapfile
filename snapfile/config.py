# DEFAULT
PROD = False
PORT = 8090
REDIS_ADDRESS = 'redis://localhost'
REDIS_DB = 0
LOG_LEVEL = 'DEBUG'
LOG_FILE = None
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
    PORT = 8080
    REDIS_DB = 1
    LOG_LEVEL = 'DEBUG'
    LOG_FILE = None # rely on supervisord to manage log rotation
    UPLOAD_ROOT_DIRECTORY = '/var/www/snapfile/files'
elif ENV == 'TEST':
    AGE = 8
    LOG_FILE = 'test.log'
    STORAGE_PER_FOLDER = 10**6 # 1 MB
    DELETE_INTERVAL = 6
else: # DEV
    DELETE_INTERVAL = 60
