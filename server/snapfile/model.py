import os
import json
import hashlib
import random
import shutil
import logging
import re
from enum import IntEnum
from time import time
from datetime import datetime, timezone, timedelta

import asyncio
import aiohttp
from aiohttp import web
from redis import asyncio as aioredis
from concurrent.futures import ThreadPoolExecutor

from . import config

log = logging.getLogger(__name__)
redis = None
thread_pools = ThreadPoolExecutor()
FILE_FORMAT = 'SNAPFE02' # Snapfile File Encryption format 02 (secretstream).


class InvalidFolderData(ValueError):
    pass


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
            keys = await redis.keys('folder:*')
            for k in keys:
                k = k.decode("utf-8")
                identity = k[k.find(':')+1:]
                total += 1
                f = app['folders'].get(identity, None)
                if f is None:
                    try:
                        f = await Folder.open(identity)
                    except InvalidFolderData:
                        log.warning('Skipping unsupported or invalid folder %s; data left untouched', identity)
                        continue
                if f is None:
                    continue
                if not f.expired:
                    continue
                deleted += 1
                log.info('Folder {} expired'.format(identity))
                # 1. close all connected clients
                await f.close_all(code=aiohttp.WSCloseCode.GOING_AWAY, message='Deleted')
                app['folders'].pop(identity, None) # delete if it exists
                # 2. delete files from disk
                # do a time consuming task in in a seprate thread and wait for the thread in asyncio
                # https://stackoverflow.com/a/28492261/6088837
                path = os.path.join(config.UPLOAD_ROOT_DIRECTORY, f.path)
                await asyncio.get_event_loop().run_in_executor(thread_pools, delete, path)
                # 3. delete data from redis
                await redis.delete(*Folder._keys(identity))
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
    redis = await aioredis.from_url(config.REDIS_ADDRESS, db=config.REDIS_DB)
    if not config.PROD:
        await redis.flushdb()
        delete(config.UPLOAD_ROOT_DIRECTORY)
    # makedirs (not mkdir) so an isolated, possibly nested upload root (e.g. the
    # isolated test uploads) can be created even if its parent doesn't exist yet.
    os.makedirs(config.UPLOAD_ROOT_DIRECTORY, exist_ok=True)
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

    def __init__(self, type, data, size, sender, date=None, file_id=None, id=None):
        self.type = type
        self.date = datetime.now(timezone.utc).isoformat() if date is None else date
        self.data = data
        self.size = size
        self.sender = sender
        self.file_id = file_id # Numbered ciphertext file on disk; file messages only.
        self.id = id # Zero-based history position across both chat and file messages.

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
                 path=None):
        self.identity = identity
        self.created_time = datetime.now(timezone.utc).isoformat() if created_time is None else created_time
        self.age = config.AGE if age is None else age
        self.storage_limit = storage_limit
        self.current_size = current_size
        self.path = path
        self.quota_lock = asyncio.Lock()
        self.uploads = {}
        self.reserved_size = 0
        if path is None:
            self.path = os.path.join(
                str(random.randint(1, config.UPLOAD_SECOND_DIRECTORY_RANGE)),
                self.identity)
            os.makedirs(os.path.join(config.UPLOAD_ROOT_DIRECTORY, self.path))
        self.connections = set() # holds all active websocket connections

    @property
    def usage_percentage(self):
        return 100 * (self.current_size / self.storage_limit)

    @property
    def expire_at(self):
        return datetime.fromisoformat(self.created_time) + timedelta(seconds=self.age)

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

    def serialize(self):
        """return a serialized str
        """
        o = dict(self.__dict__)
        del o['connections']
        del o['quota_lock']
        del o['uploads']
        del o['reserved_size']
        o['file_format'] = FILE_FORMAT
        return json.dumps(o)

    def get_file_path(self, file_id=None):
        """rename uploaded file using file id to
        1. avoid overwritting by files with the same name
        2. special character support by browswer
        """
        return os.path.join(
            self.path,
            file_id)

    async def gen_file_id(self):
        """Generate a new file id
        """
        file_id = await redis.incr('#files:{}'.format(self.identity))
        return str(file_id)

    def connect(self, ws):
        self.connections.add(ws)

    def disconnect(self, ws):
        self.connections.discard(ws)

    async def close_all(self, code=aiohttp.WSCloseCode.GOING_AWAY, message=''):
        log.info('close {} websocket connections'.format(len(self.connections)))
        for ws in list(self.connections):
            await ws.close(code=code, message=message)

    async def save(self, msg):
        async with self.quota_lock:
            if self.current_size + self.reserved_size + msg.size > self.storage_limit:
                raise web.HTTPRequestHeaderFieldsTooLarge(text='Storage space not enough')
            return await self._save(msg)

    async def _save(self, msg):
        """Save the message in this folder
        """
        folder_key, msg_key = self._keys(self.identity)
        async with redis.pipeline(transaction=True) as tr:
            # enqueue: "If key does not exist, it is created as empty"
            tr.rpush(msg_key, json.dumps(msg))
            # update total used size
            serialized = json.loads(self.serialize())
            serialized['current_size'] += msg.size
            tr.set(folder_key, json.dumps(serialized))
            message_count, folder_saved = await tr.execute()
            if not (message_count and folder_saved):
                log.error('transaction failed')
                raise RuntimeError('Failed to persist message')
            # Failed persistence must not charge the in-memory quota.
            self.current_size += msg.size
            msg.id = message_count - 1
        return True

    async def send(self, msg):
        await self.save(msg)
        await self.broadcast(msg)

    async def broadcast(self, msg):
        for ws in list(self.connections):
            if ws.closed:
                self.disconnect(ws)
                log.warning('%s disconnected but not aware.', ws['name'])
            elif ws.close_code is not None:
                # it should be a bug of aiohttp that we get here: closed = False but close_code is set
                # repro steps:
                # scenario 1
                # 1. login in chrome
                # 2. login in safari and then force quit the browser or wait for a couple of minutes
                # 3. send message from chrome
                # scenario 2
                # NGINX's proxy_read_timeout may also lead to this although the client will be closed with 1006
                # scenario 3:
                # long idle in desktop chrome or safari

                # todo: How can we cancel the coroutine that listen to this ws?
                # It does not work by simply calling ws.close()
                await ws.close()
                self.disconnect(ws)
                log.warning('{} is lost due to {}'.format(ws['name'], ws.close_code))
            else:
                try:
                    await ws.send_json({
                        'action': 'send',
                        'msgs': [msg.format_for_view()]
                    })
                except ConnectionResetError:
                    self.disconnect(ws)
                    log.warning('Client disconnected while broadcasting persisted message')

    async def retrieve(self, offset):
        if type(offset) is not int or not 0 <= offset <= 2**53 - 1:
            raise web.HTTPBadRequest(text='History offset must be a nonnegative safe integer')
        _, msg_key = self._keys(self.identity)
        # suppose total is the length of the message queue
        # offset > total occurs when the folder (identified by the id) is renewed (still empty) in the server
        # but the client holds messages belonging to the old folder
        # this should be fine because lrange will return an empty list
        msgs_json = await redis.lrange(msg_key, offset, offset + config.HISTORY_PAGE_SIZE - 1)
        results = []
        for index, m in enumerate(msgs_json, start=offset):
            msg = Message(**json.loads(m))
            msg.id = index
            # unfortunately, we could not use generator here: TypeError: object async_generator can't be used in 'await' expression
            results.append(msg)
        return results
  
    @staticmethod
    def _keys(identity):
        return 'folder:%s' % identity, 'messages:%s' % identity

    @classmethod
    async def create(cls, credential):
        identity = cls.identity_for(credential)
        if await cls._exists(identity):
            # Anti brute force must be employed to disable this exploitation
            raise web.HTTPConflict(text='Identity conflicts, please try again!')
        if False:
            raise web.HTTPInsufficientStorage(text='Disk is full, please contact the admin! Thanks.')
        folder = Folder(identity)
        folder_key, msg_key = cls._keys(identity)
        # we might save a Folder object as a hashmap (i.e., a dict)
        # but all field values are strings
        # save as a json object is more convenient
        await redis.set(folder_key, folder.serialize())
        log.info('Create a new folder {}'.format(identity))
        return True

    @classmethod
    async def login(cls, credential):
        return await cls.open(cls.identity_for(credential))

    @staticmethod
    def identity_for(credential):
        return hashlib.sha256(credential.encode('ascii')).hexdigest()

    @classmethod
    async def open(cls, identity):
        folder_key, _ = cls._keys(identity)
        folder_json = await redis.get(folder_key)
        if folder_json is None:
            return None
        try:
            folder_dict = json.loads(folder_json)
            fields = {'identity', 'created_time', 'age', 'storage_limit', 'current_size', 'path', 'file_format'}
            if not isinstance(folder_dict, dict) or set(folder_dict) != fields:
                raise ValueError('Invalid folder fields')
            if folder_dict.pop('file_format') != FILE_FORMAT or folder_dict['identity'] != identity:
                raise ValueError('Unsupported folder format')
            if not re.fullmatch(r'[0-9a-f]{64}', identity):
                raise ValueError('Invalid folder identity')
            for field in ('age', 'storage_limit', 'current_size'):
                if type(folder_dict[field]) is not int or folder_dict[field] < 0:
                    raise ValueError('Invalid folder size or age')
            if folder_dict['storage_limit'] == 0:
                raise ValueError('Invalid folder quota')
            created = datetime.fromisoformat(folder_dict['created_time'])
            if created.tzinfo is None:
                raise ValueError('Missing folder timezone')
            if not isinstance(folder_dict['path'], str) or not re.fullmatch(r'[1-9][0-9]*/' + identity, folder_dict['path']):
                raise ValueError('Invalid folder path')
            folder = Folder(**folder_dict)
            folder.expire_at  # Validate the persisted age before the reaper uses it.
            return folder
        except (ValueError, TypeError, OverflowError) as error:
            raise InvalidFolderData('Unsupported or invalid folder data. Create a new folder.') from error

    @classmethod
    async def _exists(cls, identity):
        folder_key, _ = cls._keys(identity)
        r = await redis.exists(folder_key)
        # int not bool
        return r == 1
