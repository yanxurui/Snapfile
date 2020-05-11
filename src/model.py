import os
import sys
import json
import random
import shutil
import logging
from enum import IntEnum
from time import time
from datetime import datetime, timezone, timedelta

import asyncio
import aioredis
from aiohttp import web
from concurrent.futures import ThreadPoolExecutor

import config

log = logging.getLogger(__name__)
redis = None
thread_pools = ThreadPoolExecutor()


def delete(path):
    log.info('start deleting {}'.format(path))
    shutil.rmtree(path, ignore_errors=True)
    log.info('finish deleting {}'.format(path))

def format_size(num, suffix='B'):
    for unit in ['', 'K','M','G','T','P','E','Z']:
        if abs(num) < 1000.0:
            return '%.1f%s%s' % (num, unit, suffix)
        num /= 1000.0
    return '%.1f%s%s' % (num, 'Yi', suffix)

async def remove_expired_folders(app):
    try:
        while True:
            started_time = time()
            log.info('start removing expired folders')
            total, deleted = 0, 0
            keys = await redis.keys('folder:*', encoding='utf-8')
            for k in keys:
                identity = k[k.find(':')+1:]
                total += 1
                f, connections = app['folders'].get(identity, (None, []))
                if f is None:
                    f = await Folder.open(identity)
                if not f.expired:
                    continue
                deleted += 1
                log.info('Folder {} expired'.format(identity))
                # 1. close all connected clients
                for ws in connections:
                    await ws.close()
                app['folders'].pop(identity, None) # delete if it exists
                # 2. delete data from redis
                await redis.delete(*Folder._keys(identity))
                # 3. delete files from disk
                # wait for a thread in asyncio
                # checkout https://stackoverflow.com/a/28492261/6088837
                path = os.path.join(config.UPLOAD_ROOT_DIRECTORY, f.path)
                await app.loop.run_in_executor(thread_pools, delete, path)
            log.info('finish removing expired folders')
            log.info('{} folders found and {} folders deleted pemanently.'.format(total, deleted))

            interval = time() - started_time
            if interval < config.DELETE_INTERVAL:
                await asyncio.sleep(config.DELETE_INTERVAL-interval)
    except asyncio.CancelledError:
        log.info('task canceled')
        # todo
    finally:
        pass

async def startup(app):
    global redis
    # use default db 0 for test purpose
    db = 1 if config.PROD else 0
    redis = await aioredis.create_redis_pool(config.REDIS_ADDRESS, db=db)
    if not config.PROD:
        await redis.flushdb()
        delete(config.UPLOAD_ROOT_DIRECTORY)
    if not os.path.isdir(config.UPLOAD_ROOT_DIRECTORY):
        os.mkdir(config.UPLOAD_ROOT_DIRECTORY)
        # raise SystemExit('Upload path "%s" does not exist.' % config.UPLOAD_ROOT_DIRECTORY)
    # add some quick or long running tasks
    asyncio.create_task(remove_expired_folders(app))


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
                 age=None,
                 storage_limit=config.STORAGE_PER_FOLDER,
                 current_size=0,
                 path=None,
                 **kwargs):
        # folder id is a random passcode generated by client and is never sent to the server
        # instead, only the hash of the folder id is passed to the server in each request 
        # and stored as the identity of this folder
        self.identity = identity
        self.created_time = datetime.now(timezone.utc).isoformat() if created_time is None else created_time
        self.age = config.AGE if age is None else age
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
        return datetime.fromisoformat(self.created_time) + timedelta(minutes=self.age)

    @property
    def expired(self):
        return datetime.now(timezone.utc) > self.expire_at

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
    async def create(cls, identity, age=None):
        if await cls._exists(identity):
            # Anti brute force must be employed to disable this exploitation
            raise web.HTTPConflict(text='Identity conflicts, please try again!')
        if False:
            raise web.HTTPInsufficientStorage(text='Disk is full, please contact the admin! Thanks.')
        folder = Folder(identity, age)
        folder_key, msg_key = cls._keys(identity)
        # we might save a Folder object as a hashmap (i.e., a dict)
        # but all field values are strings
        # save as a json object is more convenient
        await redis.set(folder_key, json.dumps(folder.__dict__))
        return True

    @classmethod
    async def open(cls, identity):
        folder_key, _ = cls._keys(identity)
        folder_json = await redis.get(folder_key, encoding='utf-8')
        if folder_json:
            folder_dict = json.loads(folder_json)
            return Folder(**folder_dict)
        else:
            return None

    @classmethod
    async def _exists(cls, identity):
        folder_key, _ = cls._keys(identity)
        r = await redis.exists(folder_key)
        # int not bool
        return r == 1
