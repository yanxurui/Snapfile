import asyncio
import os
import secrets
from time import monotonic

from aiohttp import web
from aiohttp_security import check_authorized

from . import config
from .model import Message, MsgType
from .views import get_client_display_name


def release(folder, token):
    upload = folder.uploads.pop(token, None)
    if upload is not None:
        folder.reserved_size -= upload['charge']


async def admit(request):
    folder = await check_authorized(request)
    try:
        data = await request.json()
    except (ValueError, UnicodeError):
        raise web.HTTPBadRequest(text='Invalid admission')
    if not isinstance(data, dict):
        raise web.HTTPBadRequest(text='Invalid admission')
    size = data.get('size')
    metadata = data.get('metadata')
    if (type(size) is not int or size < 53 or
            not isinstance(metadata, str) or not 1 <= len(metadata) <= config.MAX_FILE_METADATA or
            not metadata.isascii()):
        raise web.HTTPBadRequest(text='Invalid encrypted file size or metadata')
    charge = size + len(metadata)
    async with folder.quota_lock:
        for token, upload in list(folder.uploads.items()):
            if upload['task'] is None and upload['expires'] < monotonic():
                release(folder, token)
        if len(folder.uploads) >= config.MAX_PENDING_UPLOADS:
            raise web.HTTPTooManyRequests(text='Too many pending uploads')
        if folder.current_size + folder.reserved_size + charge > folder.storage_limit:
            raise web.HTTPRequestHeaderFieldsTooLarge(text='Storage space not enough')
        token = secrets.token_urlsafe(24)
        file_id = await folder.gen_file_id()
        folder.uploads[token] = {
            'size': size, 'metadata': metadata, 'charge': charge, 'id': file_id,
            'expires': monotonic() + config.UPLOAD_ADMISSION_TIMEOUT, 'task': None,
            'committing': False, 'cancelling': False,
        }
        folder.reserved_size += charge
    return web.json_response({'token': token}, status=201)


async def cancel(request):
    folder = await check_authorized(request)
    token = request.match_info['token']
    async with folder.quota_lock:
        upload = folder.uploads.get(token)
        if upload is not None:
            if upload['task'] is not None and not upload['committing'] and not upload['cancelling']:
                upload['cancelling'] = True
                upload['task'].cancel()
            elif upload['task'] is None:
                release(folder, token)
    return web.Response(status=204)


async def upload(request):
    folder = await check_authorized(request)
    token = request.match_info['token']
    if request.content_type != 'application/octet-stream':
        raise web.HTTPUnsupportedMediaType()
    async with folder.quota_lock:
        item = folder.uploads.get(token)
        if item is None:
            raise web.HTTPNotFound(text='Upload admission not found')
        if item['task'] is not None:
            raise web.HTTPConflict(text='Upload already started')
        if item['expires'] < monotonic():
            release(folder, token)
            raise web.HTTPGone(text='Upload admission expired')
        item['task'] = asyncio.current_task()
    path = os.path.join(config.UPLOAD_ROOT_DIRECTORY, folder.get_file_path(item['id']))
    partial = path + '.part'
    committed = False
    renamed = False
    try:
        size = 0
        with open(partial, 'xb') as output:
            while True:
                try:
                    chunk = await asyncio.wait_for(request.content.read(64 * 1024), config.UPLOAD_READ_TIMEOUT)
                except asyncio.TimeoutError:
                    raise web.HTTPRequestTimeout(text='Upload stalled')
                if not chunk:
                    break
                size += len(chunk)
                if size > item['size']:
                    raise web.HTTPRequestEntityTooLarge(max_size=item['size'], actual_size=size)
                output.write(chunk)
        if size != item['size']:
            raise web.HTTPBadRequest(text='Incomplete encrypted upload')
        async with folder.quota_lock:
            if folder.expired:
                raise web.HTTPGone(text='Folder expired')
            message = Message(type=MsgType.FILE, data=item['metadata'], size=item['charge'],
                              sender=get_client_display_name(request), file_id=item['id'])
            item['committing'] = True
            os.replace(partial, path)
            renamed = True
            await folder._save(message)
            committed = True
            release(folder, token)
        await folder.broadcast(message)
        return web.json_response({'id': item['id']})
    finally:
        try:
            if not committed:
                try:
                    os.remove(path if renamed else partial)
                except FileNotFoundError:
                    pass
        finally:
            async with folder.quota_lock:
                release(folder, token)
