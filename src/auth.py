import logging

from aiohttp import web
from aiohttp_security.abc import AbstractAuthorizationPolicy

from model import Folder


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
            if not folder.expired:
                return folder
        log.warning('not logged in yet')
        return None

    async def permits(self, identity, permission, context=None):
        pass


async def login(cache, passcode):
    """Check login credentials & Login the user
    this function usually takes username & password and verifies this is a registered user
    then returns an identity string that survives in this session.
    Since there is no user concept in this app, the hash of the folder id (passcode) is
    treated as identity for simplicity.
    """
    identity = passcode
    folder = await Folder.open(identity)
    if folder is None:
        log.warning('wrong identity')
        raise web.HTTPUnauthorized()
    if folder.expired:
        log.warning('folder expired')
        raise web.HTTPUnauthorized()
    if identity not in cache:
        # do not overwrite the cache because otherwise it will lose previous connections
        cache[identity] = folder
    return identity

