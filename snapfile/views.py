import os
import json
import logging
from pprint import pprint
from functools import wraps
from datetime import datetime

import asyncio
import aiohttp
import aiohttp_jinja2
from aiohttp import web, WSCloseCode
WSCloseCode.Unauthorized = 4000 # Add a customized close code
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
    age = form_data.get('age')
    await Folder.create(identity, age)
    identity = await auth.login(request.app['folders'], identity)
    resp = web.Response(status=201, text='Folder created!')
    await remember(request, resp, identity)
    return resp


async def login(request):
    form_data = await request.post()
    identity = form_data['identity']
    # usually this should be user name & password
    identity = await auth.login(request.app['folders'], identity)
    # ajax has trouble handling redirecting if 302 is returned
    resp = web.Response()
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
        log.info('Close ws connection due to unauthorization')
        await ws_current.close(code=aiohttp.WSCloseCode.Unauthorized, message='You may have logged out')
        return ws_current
    name = get_client_display_name(request)
    ws_current['name'] = name
    folder.connect(ws_current)
    info = folder.format_for_view()
    info['name'] = name
    await ws_current.send_json({
        'action': 'connect',
        'info': info})

    # if the client is closed, a special exception will be thrown and handled by the library
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
                log.warning('unknown message type {}'.format(str(ws_msg.type)))
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
                break
    except asyncio.TimeoutError as e:
        log.error('timeout') # we should not reach here since heartbeat is turned on
        await ws_current.close(code=aiohttp.WSCloseCode.TRY_AGAIN_LATER, message='Are you still there?')
    except Exception as e:
        log.info('{} detected for {}.'.format(e.__class__.__name__, name))
        if isinstance(e, asyncio.CancelledError):
            log.info('cancelled')
            # this occurs when the user leaves this page ??
        raise # throw whatever is captured here
    finally:
        folder.disconnect(ws_current)
    return ws_current


async def upload(request):
    folder = await check_authorized(request)
    name = get_client_display_name(request)
    reader = await request.multipart()
    count = 0
    while True:
        # reader.next() will `yield` the fields of your form
        field = await reader.next()
        if field is None:
            break
        if field.name != 'myfile[]':
            raise web.HTTPBadRequest()
        filename = field.filename
        if filename is None:
            # no file is selected
            continue
        if request.headers.get('Content-Length') is None or request.headers.get('Transfer-Encoding') is not None:
            # I am not going to support chunked encoding
            # Do not rely on Content-Length if transfer is chunked.
            raise web.HTTPBadRequest()
        l = int(request.headers['Content-Length'])
        if l + folder.current_size > folder.storage_limit:
            # it should be fine to check storage limit using Content-Length which represents the total size of the request
            log.warning('Storage limit exceeds: {} > {}'.format(l+folder.current_size, folder.storage_limit))
            raise web.HTTPRequestHeaderFieldsTooLarge()
        log.info('start uploading %s' % filename)
        file_id = await folder.gen_file_id()
        file_path = os.path.join(config.UPLOAD_ROOT_DIRECTORY, folder.get_file_path(file_id))
        size = 0
        try:
            with open(file_path, 'wb') as f:
                while True:
                    chunk = await field.read_chunk(1024*1024)  # 8192 bytes by default.
                    if not chunk:
                        # todo: What else could cause this besides reaching the end of a file?
                        break
                    size += len(chunk)
                    log.debug('writing {} for {} ...'.format(len(chunk), filename[:30]))
                    f.write(chunk) # block op
        except Exception as e:
            os.remove(f.name)
            log.warning('interrupt uploading {} due to {}'.format(filename, e))
            raise
        log.info('finish uploading {}'.format(filename))
        count += 1
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
    pretty_name = request.query['name'] # we can not query the filename by file id in server side
    resp = web.Response(headers={
        'Content-Disposition': 'attachment; filename="{0}"'.format(pretty_name),
        'X-Accel-Redirect': '/download/{}'.format(folder.get_file_path(file_id))
        })
    return resp


