import logging
# This function does nothing if the root logger already has handlers configured.
logging.basicConfig(
        format='%(asctime)s %(levelname)s %(name)s %(filename)s:%(lineno)d {%(message)s}',
        level=logging.DEBUG)

from aiohttp import web
from aiohttp_session import SimpleCookieStorage, session_middleware
import aiohttp_security

import model
from auth import SimpleAuthorizationPolicy
from views import signup, login, logout, allow, index, ws, upload, download


log = logging.getLogger(__name__)


def init_app():
    middleware = session_middleware(SimpleCookieStorage())
    app = web.Application(middlewares=[middleware])

    # create a global dict of identity -> (folder object, active ws connections)
    app['folders'] = {}

    app.on_startup.append(model.startup)
    app.on_shutdown.append(shutdown)

    policy = aiohttp_security.SessionIdentityPolicy()
    aiohttp_security.setup(app, policy, SimpleAuthorizationPolicy())

    app.add_routes([
        web.get('/ws', ws),
        web.post('/signup', signup),
        web.post('/login', login, name='login'),
        web.post('/logout', logout),
        web.get('/auth', allow),
        web.post('/files', upload),
        web.get('/files/{file_id}', download),
        # below are static files that should be served by NGINX
        web.get('/', index), # static does not support redirect / to /index.html
        web.get('/index.html', index), # serve a single static file with auth
        web.static('/', './static', name='static')]) # handle static files such as html, js, css
    
    return app

async def shutdown(app):
    for folder, connections in app['folders'].values():
        for ws in list(connections):
            await ws.close()
    app['folders'].clear()


def main():
    try:
        app = init_app()
    except SystemExit as e:
        log.exception('Failed to start!!')
        # raise
    web.run_app(app)


if __name__ == '__main__':
    main()
