"""Compatible AES-GCM and Argon2id implementations for desktop and Android."""
from __future__ import annotations

import os

if os.environ.get("MEMORY_MAP_ANDROID") != "1":
    from cryptography.exceptions import InvalidTag
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.hazmat.primitives.kdf.argon2 import Argon2id
else:
    from java import jarray, jbyte, jclass

    native = jclass("com.memorymap.app.VaultCrypto")

    class InvalidTag(Exception):
        pass

    def java_bytes(data: bytes):
        return jarray(jbyte)([value if value < 128 else value - 256 for value in data])

    def python_bytes(data):
        return bytes(value & 255 for value in data)

    class AESGCM:
        def __init__(self, key: bytes):
            if len(key) not in (16, 24, 32):
                raise ValueError("Invalid AES key length")
            self.key = key

        def encrypt(self, nonce, data, associated_data):
            return python_bytes(native.encrypt(java_bytes(self.key), java_bytes(nonce),
                                java_bytes(data), java_bytes(associated_data or b"")))

        def decrypt(self, nonce, data, associated_data):
            value = native.decrypt(java_bytes(self.key), java_bytes(nonce),
                                   java_bytes(data), java_bytes(associated_data or b""))
            if value is None:
                raise InvalidTag()
            return python_bytes(value)

    class Argon2id:
        def __init__(self, *, salt: bytes, length: int, iterations: int, lanes: int, memory_cost: int):
            self.salt, self.length = salt, length
            self.iterations, self.lanes, self.memory_cost = iterations, lanes, memory_cost

        def derive(self, key_material: bytes) -> bytes:
            return python_bytes(native.derive(java_bytes(key_material), java_bytes(self.salt),
                                self.length, self.iterations, self.lanes, self.memory_cost))
