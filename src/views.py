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

import auth
import model
from model import Folder

log = logging.getLogger(__name__)
WSCloseCode.Unauthorized = 4000 # Add a customized close code

count = 0

def get_client_display_name(request):
    """Address/OS/Browser
    """
    global count
    count += 1
    return str(count)

async def signup(request):
    form_data = await request.post()
    identity = form_data['identity']
    await Folder.signup(identity)
    return web.Response(text='Folder created!')

class LoginView(web.View):
    async def get(self):
        # redirect to html file
        raise web.HTTPFound('/login.html')

    async def post(self):
        request = self.request
        form_data = await request.post()
        identity = form_data['identity'] # usually this should be user name & password
        identity = await auth.authenticate(identity)
        if identity is None:
            raise web.HTTPUnauthorized()
        else:
            location = request.app.router['index'].url_for()
            resp = web.HTTPFound(location=location)
            await remember(request, resp, identity)
            raise resp

async def logout(request):
    await check_authorized(request)
    resp = web.HTTPFound('/login.html')
    await forget(request, resp)
    raise resp

async def login_required(request, throw=True):
    """Check login and return the folder
    """
    identity = await authorized_userid(request)
    if identity is None:
        if throw:
            raise web.HTTPUnauthorized()
        else:
            return None
    folders = request.app['folders']
    folder = folders.get(identity)
    if folder is None:
        folder = Folder(identity)
        folders[identity] = folder
    return folder

async def index(request):
    # folder = await login_required(request)
    raise web.HTTPFound('/index.html')

async def ws(request):
    ws_current = web.WebSocketResponse()
    ws_ready = ws_current.can_prepare(request)
    if not ws_ready.ok:
        raise HTTPBadRequest
    await ws_current.prepare(request) # establish
    # When the client is unauthorized, it does not work by simply raising an HTTPException before or after the handshake
    # Instead, we call the `close` method after ws is established
    folder = await login_required(request, throw=False)
    if folder is None:
        await ws_current.close(code=aiohttp.WSCloseCode.Unauthorized, message='you have logged out')
        return ws_current
    name = get_client_display_name(request)
    log.info('%s joined.', name)
    ws_current['name'] = name
    folder.connections.add(ws_current)

    await ws_current.send_json({'action': 'connect', 'name': name})
    while True:
        # if the client is closed, a special exception will be thrown and handled by the library
        try:
            msg = await ws_current.receive()
            if ws_current.closed:
                # client such as chrome will gracefully close the connection by calling ws.close()
                # but other browsers such as safari will not notify the server
                folder.connections.remove(ws_current)
                log.info('%s disconnected.', name)
                break
            elif msg.type == aiohttp.WSMsgType.TEXT:
                m = json.loads(msg.data)
                a = m['action']
                if a == 'send':
                    msg = {
                        'type': model.MsgType.TEXT,
                        'date': datetime.now().isoformat(),
                        'data': m['data'],
                        'size': len(msg.data), # todo
                        'sender': name # todo
                    }
                    await folder.save(msg)
                    for ws in folder.connections:
                        if ws.closed:
                            log.warning('%s disconnected but not aware.', ws['name'])
                        else:
                            await ws.send_json({
                                'action': 'send',
                                'msgs': [msg]
                            })
                elif a == 'sync':
                    msgs = await folder.retrieve(m['offset'])
                    await ws_current.send_json({
                        'action': 'send',
                        'msgs': msgs
                    })
                else:
                    log.warning('unknow action')
            else:
                log.warning('unknown message type')
        
        except Exception as e:
            if isinstance(e, asyncio.CancelledError):
                folder.connections.remove(ws_current)
                log.info('CancelledError detected for %s.', name)
            raise # throw whatever captured here

    return ws_current


async def upload(request):
    folder = await login_required(request)
    reader = await request.multipart()
    # reader.next() will `yield` the fields of your form
    field = await reader.next()
    assert field.name == 'file'
    filename = field.filename
    # You cannot rely on Content-Length if transfer is chunked.
    size = 0
    with open(os.path.join(folder.path, filename), 'wb') as f:
        while True:
            chunk = await field.read_chunk(1024*1024)  # 8192 bytes by default.
            if not chunk:
                # todo: What else could cause this besides reaching the end?
                break
            size += len(chunk)
            log.debug('writing %s ...' % filename)
            f.write(chunk) # block op
    log.debug('writing %s done' % filename)

    # should be in a function
    msg = {
        'type': model.MsgType.FILE,
        'date': datetime.now().isoformat(),
        'data': filename,
        'size': size, # todo
        'sender': get_client_display_name(request)
    }
    await folder.save(msg)
    for ws in folder.connections:
        if ws.closed:
            log.warning('%s disconnected but not aware.', ws['name'])
        else:
            await ws.send_json({
                'action': 'send',
                'msgs': [msg]
            })

    return web.Response(text='{} sized of {} successfully uploaded'.format(filename, size))


async def download(request):
    folder = await login_required(request)
    name = request.match_info['name']
    pretty_name = name # todo
    resp = web.Response(headers={
        'Content-Disposition': 'attachment; filename="{0}"'.format(pretty_name),
        'X-Accel-Redirect': '/protected/{0}/{1}'.format(folder.path, name)
        })
    return resp


