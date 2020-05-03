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
from aiohttp_security import (
    remember, forget, authorized_userid,
    check_permission, check_authorized,
)
from user_agents import parse

import auth
import model
from model import Message, Folder

log = logging.getLogger(__name__)
WSCloseCode.Unauthorized = 4000 # Add a customized close code


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
        location = request.app.router['static'].url_for(filename='/index.html')
        resp = web.HTTPFound(location=location)
        await remember(request, resp, identity)
        raise resp

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

async def login_required(request, throw=True):
    """Check login and return the folder
    """
    identity = await authorized_userid(request)
    if identity is None:
        log.warning('Wrong identity')
        if throw:
            raise web.HTTPUnauthorized()
        else:
            return None
    folders = request.app['folders']
    folder = folders.get(identity)
    if folder is None:
        folder = Folder.fetch(identity)
        if folder is None:
            if throw:
                raise web.HTTPUnauthorized()
            else:
                return None
        folders[identity] = folder
    return folder

async def index(request):
    await login_required(request) # redirect to login if needed
    location = request.app.router['static'].url_for(filename='/index.html')
    raise web.HTTPFound(location)

async def ws(request):
    ws_current = web.WebSocketResponse()
    ws_ready = ws_current.can_prepare(request)
    if not ws_ready.ok:
        raise HTTPBadRequest
    await ws_current.prepare(request) # establish
    # When the client is unauthorized, it does not work by simply raising an HTTPException before or after the handshake
    # Instead, we call the `close` method after ws is established and the client is responsible for redirection
    folder = await login_required(request, throw=False)
    if folder is None:
        log.info('Close ws connection due to unauthorization')
        await ws_current.close(code=aiohttp.WSCloseCode.Unauthorized, message='you have logged out')
        return ws_current
    name = get_client_display_name(request)
    ws_current['name'] = name
    folder.connections.add(ws_current)

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
                folder.connections.remove(ws_current)
                log.info('%s disconnected.', name)
                break
            elif ws_msg.type == aiohttp.WSMsgType.TEXT:
                ws_data = json.loads(ws_msg.data)
                a = ws_data['action']
                if a == 'send':
                    msg = Message(
                        type=model.MsgType.TEXT,
                        date=datetime.now(),
                        data=ws_data['data'],
                        size=len(ws_data['data']),
                        sender=name
                    )
                    await folder.save(msg)
                    for ws in folder.connections:
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
                folder.connections.remove(ws_current)
                # this occurs when the user leaves this page
                log.info('CancelledError detected for %s.', name)
            raise # throw whatever captured here

    return ws_current


async def upload(request):
    folder = await login_required(request)
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
        with open(os.path.join(folder.path, filename), 'wb') as f:
            while True:
                chunk = await field.read_chunk(1024*1024)  # 8192 bytes by default.
                if not chunk:
                    # todo: What else could cause this besides reaching the end?
                    break
                size += len(chunk)
                # log.debug('writing %s ...' % filename)
                f.write(chunk) # block op
        log.debug('writing %s done' % filename)

        # should be in a function
        msg = Message(
            type=model.MsgType.FILE,
            date=datetime.now(),
            data=filename,
            size=size, # todo
            sender=name
        )
        await folder.save(msg)
        count += 1
        for ws in folder.connections:
            if ws.closed:
                log.warning('%s disconnected but not aware.', ws['name'])
            else:
                await ws.send_json({
                    'action': 'send',
                    'msgs': [msg.format_for_view()]
                })

    return web.Response(text='{} file(s) successfully uploaded'.format(count))


async def download(request):
    folder = await login_required(request)
    name = request.match_info['name']
    pretty_name = name # todo
    resp = web.Response(headers={
        'Content-Disposition': 'attachment; filename="{0}"'.format(pretty_name),
        'X-Accel-Redirect': '/download/{0}/{1}'.format(folder.path, name)
        })
    return resp


