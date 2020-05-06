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
from aiohttp_security import (
    remember, forget, authorized_userid,
    check_permission, check_authorized,
)
from user_agents import parse

import config
import auth
from model import Message, MsgType, Folder

log = logging.getLogger(__name__)


def get_client_display_name(request):
    user_agent = parse(request.headers['User-Agent'])
    return '{}/{}'.format(
        user_agent.os.family,
        user_agent.browser.family)

async def signup(request):
    form_data = await request.post()
    identity = form_data['identity']
    await Folder.signup(identity)
    resp = web.Response(text='Folder created!')
    await remember(request, resp, identity)
    return resp

async def login(request):
    form_data = await request.post()
    identity = form_data['identity']
    # usually this should be user name & password
    identity = await auth.authenticate(identity)
    if identity is None:
        raise web.HTTPUnauthorized()
    else:
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

async def login_required(request):
    """Check login and return the folder
    """
    identity = await authorized_userid(request)
    if identity is None:
        log.warning('Wrong identity')
        raise web.HTTPUnauthorized()
    folders = request.app['folders']
    if identity in folders:
        return folders[identity]
    else:
        folder = await Folder.fetch(identity)
        if folder is None:
            log.error('Why do we get here?')
            raise web.HTTPUnauthorized()
        connections = set()
        folders[identity] = (folder, connections)
        return folder, connections

async def index(request):
    try:
        await check_authorized(request)
    except web.HTTPUnauthorized:
        location = request.app.router['static'].url_for(filename='/login.html')
        raise web.HTTPFound(location)
    directory = request.app.router['static'].get_info()['directory']
    log.info('directory: %s' % directory)
    location = os.path.join(directory, 'index.html')
    return web.FileResponse(path=location)

async def ws(request):
    ws_current = web.WebSocketResponse()
    ws_ready = ws_current.can_prepare(request)
    if not ws_ready.ok:
        raise web.HTTPBadRequest
    await ws_current.prepare(request) # establish
    # When the client is unauthorized, it does not work by simply raising an HTTPException before or after the handshake
    # Instead, we call the `close` method after ws is established and the client is responsible for redirection
    try:
        folder, connections = await login_required(request)
    except web.HTTPUnauthorized:
        log.info('Close ws connection due to unauthorization')
        await ws_current.close(code=aiohttp.WSCloseCode.Unauthorized, message='You may have logged out')
        return ws_current
    connections.add(ws_current)

    name = get_client_display_name(request)
    info = folder.format_for_view()
    info['name'] = name
    await ws_current.send_json({
        'action': 'connect',
        'info': info})

    # loop for message
    while True:
        # if the client is closed, a special exception will be thrown and handled by the library
        try:
            ws_msg = await ws_current.receive()
            if ws_current.closed:
                # client such as chrome will gracefully close the connection by calling ws.close()
                # but other browsers such as safari will not notify the server
                connections.remove(ws_current)
                log.info('%s disconnected.', name)
                break
            elif ws_msg.type == aiohttp.WSMsgType.TEXT:
                ws_data = json.loads(ws_msg.data)
                a = ws_data['action']
                if a == 'send':
                    msg = Message(
                        type=MsgType.TEXT,
                        data=ws_data['data'],
                        size=len(ws_data['data']),
                        sender=name
                    )
                    await folder.save(msg)
                    for ws in connections:
                        if ws.closed:
                            log.warning('%s disconnected but not aware.', ws['name'])
                        else:
                            await ws.send_json({
                                'action': 'send',
                                'msgs': [msg.format_for_view()]
                            })
                elif a == 'pull':
                    msgs = await folder.retrieve(ws_data['offset'])
                    await ws_current.send_json({
                        'action': 'send',
                        'msgs': [m.format_for_view() for m in msgs]
                    })
                else:
                    log.warning('unknow action')
            else:
                log.warning('unknown message type')
        
        except Exception as e:
            if isinstance(e, asyncio.CancelledError):
                connections.remove(ws_current)
                # this occurs when the user leaves this page
                log.info('CancelledError detected for %s.', name)
            raise # throw whatever captured here

    return ws_current


async def upload(request):
    folder, connections = await login_required(request)
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
        size = 0 # You cannot rely on Content-Length if transfer is chunked.
        file_id = await folder.gen_file_id()

        log.debug('start uploading %s' % filename)
        with open(os.path.join(config.UPLOAD_ROOT_DIRECTORY, folder.get_file_path(file_id)), 'wb') as f:
            while True:
                chunk = await field.read_chunk(1024*1024)  # 8192 bytes by default.
                if not chunk:
                    # todo: What else could cause this besides reaching the end?
                    break
                size += len(chunk)
                log.debug('writing {} for {} ...'.format(len(chunk), filename))
                f.write(chunk) # block op

        # should be in a function
        msg = Message(
            type=MsgType.FILE,
            data=filename,
            size=size, # todo
            sender=name,
            file_id=file_id,
        )
        await folder.save(msg)
        log.debug('uploading %s done' % filename)

        count += 1
        for ws in connections:
            if ws.closed:
                log.warning('%s disconnected but not aware.', ws['name'])
            else:
                await ws.send_json({
                    'action': 'send',
                    'msgs': [msg.format_for_view()]
                })

    return web.Response(text='{} file(s) successfully uploaded'.format(count))


async def download(request):
    folder, _ = await login_required(request)
    file_id = request.match_info['file_id']
    pretty_name = request.query['name'] # we can not query the filename by file id in server side
    log.info(folder.get_file_path(file_id))
    resp = web.Response(headers={
        'Content-Disposition': 'attachment; filename="{0}"'.format(pretty_name),
        'X-Accel-Redirect': '/download/{}'.format(folder.get_file_path(file_id))
        })
    return resp


