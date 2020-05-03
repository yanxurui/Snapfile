from aiohttp_security.abc import AbstractAuthorizationPolicy

from model import Folder


class SimpleAuthorizationPolicy(AbstractAuthorizationPolicy):
    async def authorized_userid(self, identity):
        """Retrieve authorized user id.
        Return the user_id of the user identified by the identity
        or 'None' if no user exists related to the identity.
        """
        if await Folder.exists(identity):
            return identity
        return None

    async def permits(self, identity, permission, context=None):
        pass

async def authenticate(passcode):
    """Login the user
    this function usually takes username & password and verifies this is a registered user
    then returns an identity string that survives in this session.
    Since there is no user concept in this app, the hash of the folder id (passcode) is
    treated as identity for simplicity.
    """
    if await Folder.exists(passcode):
        identity = passcode
        return identity
    else:
        return None

    