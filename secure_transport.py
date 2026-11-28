"""Verified HTTPS transport with a packaged CA store.

Frozen builds must not depend on the Python build machine's OpenSSL CA paths.
System roots remain trusted; the pinned certifi bundle adds portable public roots.
Certificate and hostname verification are always enabled.
"""
from __future__ import annotations

from functools import lru_cache
import ssl
from urllib.request import BaseHandler, HTTPSHandler, OpenerDirector, build_opener

import certifi


@lru_cache(maxsize=1)
def verified_context() -> ssl.SSLContext:
    context = ssl.create_default_context()
    context.load_verify_locations(cafile=certifi.where())
    return context


def verified_opener(*handlers: BaseHandler | type[BaseHandler]) -> OpenerDirector:
    return build_opener(HTTPSHandler(context=verified_context()), *handlers)
