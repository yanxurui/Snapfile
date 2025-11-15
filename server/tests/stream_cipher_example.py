import os
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
import base64
import struct
from cryptography.fernet import Fernet
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
password = b"yxr"
salt = os.urandom(16)
kdf = PBKDF2HMAC(
    algorithm=hashes.SHA256(),
    length=32,
    salt=salt,
    iterations=480000,
)
key = kdf.derive(password)
# key = base64.urlsafe_b64encode(kdf.derive(password))
assert(len(key) == 32)

# key = os.urandom(32)
nonce = os.urandom(16)
algorithm = algorithms.ChaCha20(key, nonce)
cipher = Cipher(algorithm, mode=None)
encryptor = cipher.encryptor()

file_path = '<your large file>'
l = 100200
with open(file_path, 'rb') as input_file:
    with open(file_path+'_encrypted', 'wb') as output_file:
        output_file.write(struct.pack('>q', l)) # 8 bytes
        output_file.write(nonce)
        while True:
            chunk = input_file.read(2**20)
            if not chunk:
                break
            cipher_chunk = encryptor.update(chunk)
            output_file.write(cipher_chunk)

decryptor = cipher.decryptor()
with open(file_path+'_encrypted', 'rb') as input_file:
    (l2,) = struct.unpack('>q', input_file.read(8))
    assert l2 == l, l2
    nonce2 = input_file.read(16)
    assert nonce2 == nonce
    with open(file_path+'_decrypted', 'wb') as output_file:
        while True:
            chunk = input_file.read(555)
            if not chunk:
                break 
            plain_chunk = decryptor.update(chunk)
            output_file.write(plain_chunk)

