# DEFAULT
import os

PROD = False
HOST = None # Bind all interfaces in DEV/PROD; NGINX normally fronts production.
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
HISTORY_PAGE_SIZE = 64
UPLOAD_ADMISSION_TIMEOUT = 60
UPLOAD_READ_TIMEOUT = 30
MAX_PENDING_UPLOADS = 8
MAX_FILE_METADATA = 24000
USE_X_ACCEL_REDIRECT = False

# PROD or TEST
ENV = os.environ.get('ENV')
if ENV == 'PROD':
    PROD = True
    USE_X_ACCEL_REDIRECT = True
    PORT = 8080
    REDIS_DB = 1
    LOG_LEVEL = 'DEBUG'
    LOG_FILE = None # rely on supervisord to manage log rotation
    UPLOAD_ROOT_DIRECTORY = '/var/www/snapfile/files'
elif ENV == 'TEST':
    HOST = '127.0.0.1'
    AGE = 8
    LOG_FILE = 'test.log'
    STORAGE_PER_FOLDER = 10**6 # 1 MB
    DELETE_INTERVAL = 6
    REDIS_ADDRESS = 'redis://127.0.0.1:6391'
    UPLOAD_ROOT_DIRECTORY = './upload_test'
elif ENV == 'E2E':
    # Test launchers override ports/paths in-process with private resources.
    # These standalone defaults never point at the normal DEV/PROD Redis DB.
    HOST = '127.0.0.1'
    PORT = 8091
    REDIS_ADDRESS = 'redis://127.0.0.1:6390'
    REDIS_DB = 15
    UPLOAD_ROOT_DIRECTORY = './upload_e2e'
    LOG_FILE = 'e2e.log'
    # Folders must outlive the whole suite, so keep them long-lived and do not
    # let the background reaper delete anything mid-test.
    AGE = 24*60*60
    DELETE_INTERVAL = 24*60*60
    STORAGE_PER_FOLDER = 96 * 1024 * 1024
else: # DEV
    DELETE_INTERVAL = 60
