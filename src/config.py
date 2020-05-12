PROD = True
PORT = 8080
REDIS_ADDRESS = 'redis://localhost'
LOG_FILE = 'prod.log'
LOG_LEVEL = 'DEBUG'
AGE = 24*60 # Minutes
STORAGE_PER_FOLDER = 10**9 # Bytes, 1 GB by default
UPLOAD_ROOT_DIRECTORY = '/var/www/clouddisk/files'
# a Folder will be placed in a random second level directory named from 1 to 1024 under UPLOAD_ROOT_DIRECTORY
UPLOAD_SECOND_DIRECTORY_RANGE = 2**10
DELETE_INTERVAL = 24*60*60 # Seconds i.e., daily
RECEIVE_TIMEOUT = 3600 # 1 Hour

# Test
import os
if os.environ.get('PROD', PROD) not in [True, 'True', '1']:
    PROD = False
    PORT = 8090
    LOG_FILE = 'test.log'
    LOG_LEVEL = 'DEBUG'
    AGE = 1
    UPLOAD_ROOT_DIRECTORY = './upload'
    STORAGE_PER_FOLDER = 10**6 # 1 MB
    DELETE_INTERVAL = 5
