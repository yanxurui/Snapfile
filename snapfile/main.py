import os
import logging
from . import config
# This function does nothing if the root logger already has handlers configured.
logging.basicConfig(
    filename = config.LOG_FILE,
    level = config.LOG_LEVEL,
    format='%(asctime)s %(levelname)s %(name)s %(filename)s:%(lineno)d {%(message)s}')

from aiohttp import web
from aiohttp_session import SimpleCookieStorage, session_middleware
import aiohttp_security

from . import model
from .auth import SimpleAuthorizationPolicy
from .views import signup, login, logout, allow, index, ws, upload, download


log = logging.getLogger(__name__)
dir_path = os.path.dirname(os.path.realpath(__file__))
log.info('Starting from {}'.format(dir_path))

def init_app():
    middleware = session_middleware(SimpleCookieStorage())
    app = web.Application(middlewares=[middleware])

    # create a global dict of identity -> (folder object, active ws connections)
    cache = {}
    app['folders'] = cache

    app.on_startup.append(model.startup)
    app.on_shutdown.append(shutdown)

    policy = aiohttp_security.SessionIdentityPolicy()
    aiohttp_security.setup(app, policy, SimpleAuthorizationPolicy(cache))

    app.add_routes([
        web.get('/ws', ws),
        web.post('/signup', signup),
        web.post('/login', login),
        web.post('/logout', logout),
        web.get('/auth', allow),
        web.post('/files', upload),
        web.get('/files', download),
        # below are static files that should be served by NGINX
        web.get('/', index, name='index'), # static does not support redirect / to /index.html
        web.get('/index.html', index), # serve a single static file with auth
        web.static('/', os.path.join(dir_path, 'static'), name='static')]) # handle static files such as html, js, css
    
    return app


async def shutdown(app):
    for folder in app['folders'].values():
        await folder.close_all()
    app['folders'].clear()


def main():
    try:
        app = init_app()
    except SystemExit as e:
        log.exception('Failed to start!!')
        # raise
    web.run_app(app, port=config.PORT)


if __name__ == '__main__':
    main()
