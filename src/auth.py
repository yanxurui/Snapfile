import logging

from aiohttp import web
from aiohttp_security.abc import AbstractAuthorizationPolicy

from model import Folder


log = logging.getLogger(__name__)


class SimpleAuthorizationPolicy(AbstractAuthorizationPolicy):
    async def authorized_userid(self, identity):
        """Retrieve authorized user id.
        Return the user_id of the user identified by the identity
        or 'None' if no user exists related to the identity.

        Actually, we do not perform any authorization here but in check_login
        """
        return identity

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
    connections = set()
    cache[identity] = (folder, connections)
    return identity


async def check_login(cache, identity):
    if identity in cache:
        folder, connections = cache[identity]
        if not folder.expired:
            return folder, connections
    log.warning('not logged in yet')
    raise web.HTTPUnauthorized()

