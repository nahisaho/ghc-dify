"""Trusted stdlib preload for Dify's fixed code wrapper, before its syscall filter.

Only the sandbox-private Python installation imports this public immutable file.
No user-provided preload is accepted and no capability or syscall is added.
"""
import base64  # noqa: F401 -- load before the job syscall policy forbids module loading
import datetime  # noqa: F401 -- required by the fixed upstream wrapper
import json  # noqa: F401 -- required by the fixed upstream wrapper
import math  # noqa: F401 -- expose the standard numerical module before seccomp
import re  # noqa: F401 -- required by the fixed upstream wrapper
