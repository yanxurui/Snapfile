import os
import sys
import json
import logging
import mimetypes
import struct

from pprint import pprint
from functools import wraps
from datetime import datetime

import asyncio
import aiohttp
from aiohttp import web, WSCloseCode
from aiohttp_security import remember, forget, check_authorized
from user_agents import parse

from . import config
from . import auth
from .model import Message, MsgType, Folder

log = logging.getLogger(__name__)


def get_client_display_name(request):
    if 'User-Agent' not in request.headers:
        return 'Unknown'
    user_agent = parse(request.headers['User-Agent'])
    return '{}/{}'.format(
        user_agent.os.family,
        user_agent.browser.family)


async def signup(request):
    form_data = await request.post()
    identity = form_data['identity']
    if len(identity) > 32:
        raise web.HTTPBadRequest()
    age = form_data.get('age')
    await Folder.create(identity, age)
    identity = await auth.login(request.app['folders'], identity)
    resp = web.Response(status=201, text='Folder created!')
    await remember(request, resp, identity)
    return resp


async def login(request):
    assert request.method == 'POST'
    form_data = await request.post()
    identity = form_data['identity']
    if not identity:
        raise web.HTTPBadRequest()
    # return 200 because ajax has trouble handling redirecting if 302 is returned
    resp = web.Response()
    # usually this should be user name & password
    identity = await auth.login(request.app['folders'], identity)
    await remember(request, resp, identity)
    return resp


async def logout(request):
    await check_authorized(request)
    location = request.app.router['static'].url_for(filename='/login.html')
    resp = web.HTTPFound(location)
    await forget(request, resp)
    raise resp


async def allow(request):
    """check if a user is logged in
    for NGINX auth_request directive
    """
    await check_authorized(request)
    return web.Response()


async def index(request):
    try:
        await check_authorized(request)
    except web.HTTPUnauthorized:
        location = request.app.router['static'].url_for(filename='/login.html')
        raise web.HTTPFound(location)
    directory = request.app.router['static'].get_info()['directory']
    location = os.path.join(directory, 'index.html')
    return web.FileResponse(path=location)


async def ws(request):
    # todo
    # what if the websocket client does not support ping pong?
    # what if the client lost network and does not send back the 
    # pong? will an exception be thrown here? NO.
    ws_current = web.WebSocketResponse(heartbeat=config.HEARTBEAT)
    ws_ready = ws_current.can_prepare(request)
    if not ws_ready.ok:
        raise web.HTTPBadRequest()
    await ws_current.prepare(request) # establish
    # When the client is unauthorized, it does not work by simply raising an HTTPException before or after the handshake
    # Instead, we call the `close` method after ws is established and the client is responsible for redirection
    try:
        folder = await check_authorized(request)
    except web.HTTPUnauthorized:
        log.info('close ws connection due to unauthorization')
        await ws_current.close(code=4000, message='You may have logged out')  # Custom code for unauthorized
        return ws_current
    name = get_client_display_name(request)
    ws_current['name'] = name
    folder.connect(ws_current)
    info = folder.format_for_view()
    info['name'] = name
    await ws_current.send_json({
        'action': 'connect',
        'info': info})

    try:
        # loop for message
        while True:
            # the timeout should never occur because of the heartbeat mechanism
            ws_msg = await ws_current.receive(config.RECEIVE_TIMEOUT)
            if ws_msg.type == aiohttp.WSMsgType.TEXT:
                if folder.expired:
                    log.info('expiration detected for websocket')
                    await ws_current.close(code=aiohttp.WSCloseCode.GOING_AWAY, message='Expired!')
                    break
                ws_data = json.loads(ws_msg.data)
                a = ws_data['action']
                if a == 'send':
                    msg = Message(
                        type=MsgType.TEXT,
                        data=ws_data['data'],
                        size=len(ws_data['data']),
                        sender=name
                    )
                    await folder.send(msg)
                elif a == 'pull':
                    msgs = await folder.retrieve(ws_data['offset'])
                    await ws_current.send_json({
                        'action': 'send',
                        'msgs': [m.format_for_view() for m in msgs]
                    })
                else:
                    log.warning('unknow action')
            else:
                # ws_msg.type == aiohttp.WSMsgType.CLOSING if closed by remove_expired_folders task
                if ws_msg.type == aiohttp.WSMsgType.CLOSE:
                    assert ws_current.closed
                    # there are a few scenarios where this will happen;
                    # case 1:
                    # client such as chrome will gracefully send a close msg when closing the tab
                    # but other browsers such as safari will not notify the server at all
                    # case 2:
                    # disconnected detected by heartbeat
                    log.info('{} disconnected with close code {}.'.format(name, ws_current.close_code))
                elif ws_msg.type == aiohttp.WSMsgType.CLOSING:
                    # call ws.close() in other coroutines will also lead to here through CLOSING
                    # in this case we don't have to call close again
                    pass
                elif ws_msg.type == aiohttp.WSMsgType.CLOSED:
                    # Connection already closed (e.g., client aborted)
                    log.info('{} connection already closed (aborted)'.format(name))
                else:
                    log.warning('unknown message type {}'.format(str(ws_msg.type)))
                break
    except asyncio.TimeoutError as e:
        log.error('timeout') # we should not reach here since heartbeat is turned on
        await ws_current.close(code=aiohttp.WSCloseCode.TRY_AGAIN_LATER, message='Are you still there?')
    except:
        # capture all exceptions not just Exception
        log.info('{} detected for {}'.format(sys.exc_info()[0], name))
        # CancelledError will be thrown when
        # 1. the client aborts
        # 2. the client lost network and heartbeat fails
        # this exception will be handled by the library automatically
        raise # throw whatever is captured here
    finally:
        log.debug('{} exits'.format(name))
        folder.disconnect(ws_current)
    return ws_current


async def upload(request):
    folder = await check_authorized(request)
    name = get_client_display_name(request)
    
    # Get filename from query parameter and content type from header
    filename = request.query.get('name')
    content_type = request.headers.get('Content-Type', 'application/octet-stream')
    
    if not filename:
        raise web.HTTPBadRequest(text='Filename is required')
    
    # Handle both Content-Length and chunked transfer encoding
    content_length = request.headers.get('Content-Length')
    transfer_encoding = request.headers.get('Transfer-Encoding')
    
    if content_length is not None:
        # Traditional upload with known size
        expected_size = int(content_length)
        if expected_size + folder.current_size > folder.storage_limit:
            log.warning('Storage limit exceeds: {} > {}'.format(expected_size + folder.current_size, folder.storage_limit))
            raise web.HTTPRequestHeaderFieldsTooLarge()
    elif transfer_encoding == 'chunked':
        # Streaming upload - we'll check size as we go
        expected_size = None
        log.info('Streaming upload detected for %s', filename)
    else:
        # Neither Content-Length nor chunked encoding
        raise web.HTTPBadRequest(text='Content-Length or Transfer-Encoding: chunked required')
    
    log.info('start uploading %s (type: %s)' % (filename, content_type))
    file_id = await folder.gen_file_id()
    file_path = os.path.join(config.UPLOAD_ROOT_DIRECTORY, folder.get_file_path(file_id))
    size = 0
    
    try:
        with open(file_path, 'wb') as f:
            # Read raw file data from request body
            while True:
                chunk = await request.content.read(1024*1024)  # Read 1MB at a time
                if not chunk:
                    break
                size += len(chunk)
                
                # Check storage limit for streaming uploads
                if expected_size is None and size + folder.current_size > folder.storage_limit:
                    log.warning('Storage limit exceeds during streaming upload: {} > {}'.format(
                        size + folder.current_size, folder.storage_limit))
                    raise web.HTTPRequestHeaderFieldsTooLarge()
                
                log.debug('writing {} for {} ...'.format(len(chunk), filename[:30]))
                f.write(chunk)  # block op
        
        # Validate size for non-streaming uploads
        if expected_size is not None:
            assert expected_size == size, 'Content-Length should match uploaded size'
    except:
        # if client abort uploading
        # asyncio.exceptions.CancelledError will be captured here
        os.remove(file_path)
        log.warning('interrupt uploading {} due to {}'.format(filename, sys.exc_info()[0]))
        raise
    
    log.info('finish uploading {}'.format(filename))
    count = 1
    msg = Message(
        type=MsgType.FILE,
        data=filename,
        size=size,
        sender=name,
        file_id=file_id,
    )
    await folder.send(msg)
    return web.Response(text='{} file(s) uploaded'.format(count))


async def download(request):
    folder = await check_authorized(request)
    file_id = request.query['id']
    file_name = request.query['name'] # we can not query the filename by file id in server side
    file_path = folder.get_file_path(file_id)
    
    if config.PROD:
        # Use NGINX X-Accel-Redirect for efficient file serving in production
        resp = web.Response(headers={
            'Content-Disposition': 'attachment; filename="{0}"'.format(file_name),
            'X-Accel-Redirect': '/download/{}'.format(file_path)
            })
        log.info('redirect to NGINX for file download')
        return resp
    else:
        # In TEST/DEV mode, serve file directly from Python
        ct, encoding = mimetypes.guess_type(file_name)
        if not ct:
            ct = "application/octet-stream"
        resp = web.StreamResponse(
            headers={
                'Content-Type': ct,
                'Content-Disposition': 'attachment; filename="{0}"'.format(file_name),
            },
        )
        chunk_size = 1024*1024
        full_file_path = os.path.join(config.UPLOAD_ROOT_DIRECTORY, file_path)
        # Without setting Content-Length, chunked transfer encoding will be used.
        # The downside is that the client has no way to estimate the ETA
        # So, let's infer the Content-Length from the file size
        try:
            file_size = os.path.getsize(full_file_path)
        except FileNotFoundError:
            # this is probably a bad request with an arbitrary file id
            raise web.HTTPNotFound()
        resp.content_length = file_size
        await resp.prepare(request)
        log.info('start downloading file: %s', file_name)
        with open(full_file_path, 'rb') as file:
            while True:
                chunk = file.read(chunk_size)
                if not chunk:
                    break
                log.debug('send %d bytes for %s', len(chunk), file_name)
                await resp.write(chunk)
        await resp.write_eof()
        log.info('finish downloading file %s', file_name)
        return resp


