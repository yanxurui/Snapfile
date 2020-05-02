import os
import sys
import json
import random
import shutil
from enum import IntEnum
from datetime import datetime

from aiohttp import web

import config


redis = {}


class Folder:
    def __init__(self,
                 identity,
                 created_time=None,
                 age=config.AGE,
                 speed_limit=2**10,
                 storage_limit=config.STORAGE_PER_FOLDER,
                 current_size=0,
                 path=None):
        # folder id is a random passcode generated by client and is never sent to the server
        # instead, only the hash of the folder id is passed to the server in each request 
        # and stored as the identity of this folder
        self.identity = identity
        self.created_time = datetime.now() if created_time is None else created_time
        self.age = age
        self.speed_limit = speed_limit
        self.storage_limit = storage_limit
        self.current_size = current_size
        self.path = path
        if path is None:
            self.path = self._path(self.identity) 
            shutil.rmtree(self.path, ignore_errors=True)
            os.makedirs(self.path)
        # hold the current active connections
        self.connections = set()

    @classmethod
    def fetch(cls, identity):
        folder_key, _ = cls._keys(identity)
        folder_info_dict = redis.get(folder_key)
        if folder_info_dict:
            return Folder(identity, **folder_info_dict)
        return None

    @staticmethod
    def _path(identity):
        """Generate the relative path of a new Folder
        """
        return os.path.join(
            config.UPLOAD_ROOT_DIRECTORY,
            str(random.randint(1, config.UPLOAD_SECOND_DIRECTORY_RANGE)),
            identity)

    @staticmethod
    def _keys(identity):
        return 'folder:%s' % identity, 'messages:%s' % identity

    async def save(self, msg):
        """Save the message in this folder
        """
        folder_key, msg_key = self._keys(self.identity)
        # enqueue
        redis[msg_key].append(json.dumps(msg))
        # upload storage size
        redis[folder_key]['current_size'] += msg['size']
        # todo: the operations above should be in a transaction

    async def retrieve(self, offset):
        _, msg_key = self._keys(self.identity)
        queue = redis[msg_key]
        total = len(queue)
        assert offset >= 0 and offset <= total, '%d out of [0, %d]' % (offset, total)
        if offset == total:
            return []
        msgs_json = queue[-(total-offset):]
        return [json.loads(m) for m in msgs_json]
  
    @classmethod
    async def signup(cls, identity):
        if await cls.exists(identity):
            # Anti brute force must be employed to disable this exploitation
            raise web.HTTPConflict(text='Identity exists, please try again!')
        if False:
            raise web.HTTPInsufficientStorage(text='Disk is full, please contact the admin! Thanks.')
        folder = cls(identity)
        folder_key, msg_key = cls._keys(identity)
        redis[folder_key] = folder.__dict__
        redis[msg_key] = []
        return True

    @classmethod
    async def exists(cls, identity):
        folder_key, _ = cls._keys(identity)
        return folder_key in redis


class MsgType(IntEnum):
    TEXT = 0
    FILE = 1


def init():
    if not os.path.isdir(config.UPLOAD_ROOT_DIRECTORY):
        os.mkdir(config.UPLOAD_ROOT_DIRECTORY)
        # raise SystemExit('Upload path "%s" does not exist.' % config.UPLOAD_ROOT_DIRECTORY)
    # for i in range(1, config.UPLOAD_SECOND_DIRECTORY_RANGE):
    #     second = os.path.join(config.UPLOAD_ROOT_DIRECTORY, str(i))
    #     if not os.path.isdir(second):
    #         os.mkdir(second)
