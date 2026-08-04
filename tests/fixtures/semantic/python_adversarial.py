"""Fake declarations must be ignored:
def ghost():
    fake_call()
"""

from ..pkg.tools import helper
import os, json as jsonlib

@registry.register("job")
async def outer(value: int) -> int:
    text = "string_call()"
    # comment_call()
    def inner(offset: int) -> int:
        return real_call(value + offset)
    return inner(2)

class Worker(Base):
    @classmethod
    def run(cls) -> int:
        return outer(3)
