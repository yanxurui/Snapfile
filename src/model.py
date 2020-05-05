import os
import sys
import json
import random
import shutil
import logging
from enum import IntEnum
from datetime import datetime, timezone, timedelta

import aioredis
from aiohttp import web

import config

log = logging.getLogger(__name__)
redis = None


def format_size(num, suffix='B'):
    for unit in ['', 'K','M','G','T','P','E','Z']:
        if abs(num) < 1000.0:
            return '%.1f%s%s' % (num, unit, suffix)
        num /= 1000.0
    return '%.1f%s%s' % (num, 'Yi', suffix)

async def startup(app):
    global redis
    # use default db 0 for test purpose
    db = 1 if config.PROD else 0
    redis = await aioredis.create_redis_pool(config.REDIS_ADDRESS, db=db)
    if not config.PROD:
        await redis.flushdb()
    log.info('Redis ready')

    if not config.PROD:
        shutil.rmtree(config.UPLOAD_ROOT_DIRECTORY, ignore_errors=True)
    if not os.path.isdir(config.UPLOAD_ROOT_DIRECTORY):
        os.mkdir(config.UPLOAD_ROOT_DIRECTORY)
        # raise SystemExit('Upload path "%s" does not exist.' % config.UPLOAD_ROOT_DIRECTORY)
    # for i in range(1, config.UPLOAD_SECOND_DIRECTORY_RANGE):
    #     second = os.path.join(config.UPLOAD_ROOT_DIRECTORY, str(i))
    #     if not os.path.isdir(second):
    #         os.mkdir(second)


class MsgType(IntEnum):
    TEXT = 0
    FILE = 1


class Message(dict): 
    """To make this class serializable for json dumps, I create a dict like class
    checkout https://stackoverflow.com/a/5021467/6088837
    """
    __getattr__ = dict.__getitem__
    __setattr__ = dict.__setitem__

    def __init__(self, type, data, size, sender, date=None, file_id=None):
        self.type = type
        self.date = datetime.now(timezone.utc).isoformat() if date is None else date
        self.data = data
        self.size = size
        self.sender = sender
        self.file_id = file_id # exclusive to file

    def format_for_view(self):
        d = dict(self)
        d['size'] = format_size(self.size)
        return d


class Folder:
    def __init__(self,
                 identity,
                 created_time=None,
                 age=config.AGE,
                 storage_limit=config.STORAGE_PER_FOLDER,
                 current_size=0,
                 path=None,
                 **kwargs):
        # folder id is a random passcode generated by client and is never sent to the server
        # instead, only the hash of the folder id is passed to the server in each request 
        # and stored as the identity of this folder
        self.identity = identity
        self.created_time = datetime.now(timezone.utc).isoformat() if created_time is None else created_time
        self.age = age
        self.storage_limit = storage_limit
        self.current_size = current_size
        self.path = path
        if path is None:
            self.path = os.path.join(
                str(random.randint(1, config.UPLOAD_SECOND_DIRECTORY_RANGE)),
                self.identity)
            shutil.rmtree(self.path, ignore_errors=True)
            os.makedirs(os.path.join(config.UPLOAD_ROOT_DIRECTORY, self.path))

    @property
    def usage_percentage(self):
        return 100 * (self.current_size / self.storage_limit)

    @property
    def expire_at(self):
        return datetime.fromisoformat(self.created_time) + timedelta(days=self.age)
    
    def format_for_view(self):
        return {
            'created_time': self.created_time,
            'age': self.age,
            'storage_limit': format_size(self.storage_limit),
            'current_size': format_size(self.current_size),

            'expire_at': self.expire_at.isoformat(),
            'usage_percentage': '{:.1f}%'.format(self.usage_percentage)
        }

    def get_file_path(self, file_id=None):
        """rename uploaded file using file id to
        1. avoid overwritting by files with the same name
        2. special character support by browswer
        """
        return os.path.join(
            self.path,
            file_id)

    async def gen_file_id(self):
        """Generate the relative path of a new file
        """
        file_id = await redis.incr('#files:{}'.format(self.identity))
        return str(file_id)

    @staticmethod
    def _keys(identity):
        return 'folder:%s' % identity, 'messages:%s' % identity

    async def save(self, msg):
        """Save the message in this folder
        """
        folder_key, msg_key = self._keys(self.identity)
        tr = redis.multi_exec()
        # enqueue: "If key does not exist, it is created as empty"
        tr.rpush(msg_key, json.dumps(msg))
        # upload storage size
        self.current_size += msg.size
        tr.set(folder_key, json.dumps(self.__dict__))
        ok1, ok2 = await tr.execute()
        if not (ok1 and ok2):
            log.error('transaction failed')
            return False
        return True

    async def retrieve(self, offset):
        if offset < 0:
            raise web.HTTPBadRequest
        _, msg_key = self._keys(self.identity)
        # suppose total is the length of the message queue
        # offset > total occurs when the folder (identified by the id) is renewed (still empty) in the server
        # but the client holds messages belonging to the old folder
        # this should be fine because lrange will return an empty list
        msgs_json = await redis.lrange(msg_key, offset, -1, encoding='utf-8')
        return [Message(**json.loads(m)) for m in msgs_json]
  
    @classmethod
    async def signup(cls, identity):
        if await cls.exists(identity):
            # Anti brute force must be employed to disable this exploitation
            raise web.HTTPConflict(text='Identity conflicts, please try again!')
        if False:
            raise web.HTTPInsufficientStorage(text='Disk is full, please contact the admin! Thanks.')
        folder = cls(identity)
        folder_key, msg_key = cls._keys(identity)
        # we might save a Folder object as a hashmap (i.e., a dict)
        # but all field values are strings
        # save as a json object is more convenient
        await redis.set(folder_key, json.dumps(folder.__dict__))
        return True

    @classmethod
    async def fetch(cls, identity):
        folder_key, _ = cls._keys(identity)
        folder_json = await redis.get(folder_key, encoding='utf-8')
        if folder_json:
            folder_dict = json.loads(folder_json)
            folder = Folder(**folder_dict)
            if datetime.now(timezone.utc) > folder.expire_at:
                log.info('Folder expired')
                return None
            else:
                return folder
        else:
            return None

    @classmethod
    async def exists(cls, identity):
        folder_key, _ = cls._keys(identity)
        r = await redis.exists(folder_key)
        # int not bool
        return r == 1
