import os
import sys
import json
import logging
import re
import base64
import binascii

import asyncio
import aiohttp
from aiohttp import web, WSCloseCode
WSCloseCode.Unauthorized = 4000 # Add a customized close code
from aiohttp_security import remember, forget, check_authorized
from user_agents import parse

from . import config
from . import auth
from .model import Message, MsgType, Folder

log = logging.getLogger(__name__)
CHAT_PREFIX = 'SNAPCHAT01.'
MAX_CHAT_BYTES = 64 * 1024
MAX_CHAT_ENVELOPE = len(CHAT_PREFIX) + ((MAX_CHAT_BYTES + 40) * 4 + 2) // 3
MAX_WS_MESSAGE = 96 * 1024


def validate_chat_envelope(value):
    if not isinstance(value, str) or len(value) > MAX_CHAT_ENVELOPE or not value.startswith(CHAT_PREFIX):
        raise ValueError('An encrypted SNAPCHAT01 message is required (maximum 65536 UTF-8 bytes)')
    encoded = value[len(CHAT_PREFIX):]
    if not re.fullmatch(r'[A-Za-z0-9_-]+', encoded):
        raise ValueError('Invalid encrypted chat encoding')
    try:
        decoded = base64.b64decode(encoded + '=' * (-len(encoded) % 4), altchars=b'-_', validate=True)
    except binascii.Error:
        raise ValueError('Invalid encrypted chat encoding')
    if not 41 <= len(decoded) <= MAX_CHAT_BYTES + 40 or base64.urlsafe_b64encode(decoded).decode().rstrip('=') != encoded:
        raise ValueError('Invalid encrypted chat length or encoding')
    return len(value)

def credentials_from(form):
    identity = form.get('identity', '')
    if not isinstance(identity, str) or not re.fullmatch(r'[0-9a-f]{64}', identity):
        raise web.HTTPBadRequest(text='Invalid authentication token')
    return identity


def get_client_display_name(request):
    if 'User-Agent' not in request.headers:
        return 'Unknown'
    user_agent = parse(request.headers['User-Agent'])
    return '{}/{}'.format(
        user_agent.os.family,
        user_agent.browser.family)


async def signup(request):
    form_data = await request.post()
    identity = credentials_from(form_data)
    await Folder.create(identity)
    identity = await auth.login(request.app['folders'], identity)
    resp = web.Response(status=201, text='Folder created!')
    await remember(request, resp, identity)
    return resp


async def login(request):
    assert request.method == 'POST'
    form_data = await request.post()
    identity = credentials_from(form_data)
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
    ws_current = web.WebSocketResponse(heartbeat=config.HEARTBEAT, max_msg_size=MAX_WS_MESSAGE)
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
                try:
                    ws_data = json.loads(ws_msg.data)
                    if not isinstance(ws_data, dict):
                        raise ValueError('Invalid WebSocket request')
                    a = ws_data.get('action')
                    if a == 'send':
                        size = validate_chat_envelope(ws_data.get('data'))
                        msg = Message(type=MsgType.TEXT, data=ws_data['data'], size=size, sender=name)
                        await folder.send(msg)
                    elif a == 'pull':
                        offset = ws_data.get('offset')
                        msgs = await folder.retrieve(offset)
                        await ws_current.send_json({
                            'action': 'send',
                            'msgs': [m.format_for_view() for m in msgs],
                            'next_offset': offset + len(msgs),
                            'more': len(msgs) == config.HISTORY_PAGE_SIZE
                        })
                    else:
                        raise ValueError('Unknown WebSocket action')
                except web.HTTPBadRequest as error:
                    log.warning('Rejected malformed WebSocket request')
                    await ws_current.send_json({'action': 'error', 'message': error.text})
                except ValueError as error:
                    log.warning('Rejected malformed WebSocket request')
                    await ws_current.send_json({'action': 'error', 'message': str(error)})
                except web.HTTPRequestHeaderFieldsTooLarge:
                    await ws_current.send_json({'action': 'error', 'message': 'Storage space not enough'})
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


async def download(request):
    folder = await check_authorized(request)
    file_id = request.query.get('id', '')
    if not re.fullmatch(r'[0-9]+', file_id):
        raise web.HTTPBadRequest(text='Invalid file id')
    relative_path = folder.get_file_path(file_id)
    path = os.path.join(config.UPLOAD_ROOT_DIRECTORY, relative_path)
    if not os.path.isfile(path):
        raise web.HTTPNotFound()
    headers = {
        'Content-Type': 'application/octet-stream',
        'Cache-Control': 'no-store',
        'Content-Disposition': 'attachment'
    }
    if config.USE_X_ACCEL_REDIRECT:
        # Folder paths contain only validated ASCII digits, hex and slashes.
        headers['X-Accel-Redirect'] = '/download/' + relative_path
        return web.Response(headers=headers)
    return web.FileResponse(path, headers=headers)
