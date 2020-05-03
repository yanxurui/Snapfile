AGE = 1 # Days
STORAGE_PER_FOLDER = 10**9 # Bytes, 1 GB by default
UPLOAD_ROOT_DIRECTORY = './upload'
# a Folder will be placed in a random second level directory named from 1 to 1024 under UPLOAD_ROOT_DIRECTORY
UPLOAD_SECOND_DIRECTORY_RANGE = 2**10


import os

if not os.path.isdir(UPLOAD_ROOT_DIRECTORY):
    os.mkdir(UPLOAD_ROOT_DIRECTORY)
    # raise SystemExit('Upload path "%s" does not exist.' % UPLOAD_ROOT_DIRECTORY)
# for i in range(1, UPLOAD_SECOND_DIRECTORY_RANGE):
#     second = os.path.join(UPLOAD_ROOT_DIRECTORY, str(i))
#     if not os.path.isdir(second):
#         os.mkdir(second)
