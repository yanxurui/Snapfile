PROD=False

AGE = 1 # Days
STORAGE_PER_FOLDER = 10**9 # Bytes, 1 GB by default
if PROD:
	UPLOAD_ROOT_DIRECTORY = '/var/www/clouddisk/files'
else:
	# UPLOAD_ROOT_DIRECTORY = './upload'
	UPLOAD_ROOT_DIRECTORY = '/var/www/clouddisk/files'

# a Folder will be placed in a random second level directory named from 1 to 1024 under UPLOAD_ROOT_DIRECTORY
UPLOAD_SECOND_DIRECTORY_RANGE = 2**10

REDIS_ADDRESS = 'redis://localhost'
