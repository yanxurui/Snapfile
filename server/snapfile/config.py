# DEFAULT
import os

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
ENABLE_ENCRYPTION = True
DELETE_INTERVAL = 24*60*60 # seconds i.e., daily
HEARTBEAT = 30 # seconds
RECEIVE_TIMEOUT = 3600 # 1 hour

# PROD or TEST
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
elif ENV == 'E2E':
    # Dedicated configuration for the Playwright end-to-end suite.
    # The e2e launcher (client/tests/e2e/server.mjs) starts an isolated, in-memory
    # Redis and an upload directory just for the test run and points us at them
    # via the env vars below, so a run never touches dev/prod data.
    #
    # The defaults are deliberately *fail-safe*: they point at the launcher's
    # ephemeral Redis (:6390, started only for tests) and a separate db, never
    # the developer's real instance. So even `ENV=E2E python -m snapfile` run by
    # hand will refuse to connect rather than flush localhost:6379 db0, which
    # startup() would otherwise wipe (it flushes for any non-PROD env).
    PORT = int(os.environ.get('SNAPFILE_PORT', 8091))
    REDIS_ADDRESS = os.environ.get('REDIS_ADDRESS', 'redis://127.0.0.1:6390')
    REDIS_DB = int(os.environ.get('REDIS_DB', 15)) # distinct from dev(0)/prod(1)
    UPLOAD_ROOT_DIRECTORY = os.environ.get('SNAPFILE_UPLOAD', './upload_e2e')
    LOG_FILE = os.environ.get('SNAPFILE_LOG', 'e2e.log')
    # Folders must outlive the whole suite, so keep them long-lived and do not
    # let the background reaper delete anything mid-test.
    AGE = 24*60*60
    DELETE_INTERVAL = 24*60*60
    STORAGE_PER_FOLDER = 10**7 # 10 MB, plenty for the e2e file fixtures
else: # DEV
    DELETE_INTERVAL = 60
