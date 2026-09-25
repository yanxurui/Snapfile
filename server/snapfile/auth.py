import logging

from aiohttp import web
from aiohttp_security.abc import AbstractAuthorizationPolicy

from .model import Folder, InvalidFolderData


log = logging.getLogger(__name__)


class SimpleAuthorizationPolicy(AbstractAuthorizationPolicy):
    def __init__(self, cache):
        super().__init__()
        self.cache = cache

    async def authorized_userid(self, identity):
        """Retrieve authorized user id.
        Return the user_id of the user identified by the identity
        or 'None' if no user exists related to the identity.

        Actually, we return the folder directly here
        """
        if identity in self.cache:
            folder = self.cache[identity]
            if folder.expired:
                log.warning('folder expired')
            else:
                return folder
        else:
            log.warning('not logged in yet')
        return None

    async def permits(self, identity, permission, context=None):
        pass


async def login(cache, credential):
    """Authenticate using only the browser-derived token, never the passcode."""
    try:
        folder = await Folder.login(credential)
    except InvalidFolderData as error:
        cache.pop(Folder.identity_for(credential), None)
        log.warning('Login rejected: %s', error)
        raise web.HTTPConflict(text=str(error))
    if folder is None:
        log.warning('wrong identity')
        raise web.HTTPUnauthorized()
    if folder.expired:
        log.warning('folder expired')
        raise web.HTTPUnauthorized()
    identity = folder.identity
    if identity not in cache:
        # do not overwrite the cache because otherwise it will lose previous connections
        cache[identity] = folder
    return identity
