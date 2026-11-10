"""A real beat-scheduled worker heartbeat, without modifying Dify's tasks."""
import os
from collections.abc import Callable
from importlib import import_module
from typing import Protocol, cast

import redis


class SchedulerConfig(Protocol):
    """Only the upstream scheduler interface consumed by this integration."""
    beat_schedule: dict[str, object]


class TaskApp(Protocol):
    """Typed boundary to the module supplied by the pinned Dify API image."""
    conf: SchedulerConfig

    def task(self, *, name: str) -> Callable[[Callable[[], None]], Callable[[], None]]:
        """Register a no-argument heartbeat."""
        ...


celery = cast(TaskApp, import_module("celery_entrypoint").celery)


@celery.task(name="dify_image_heartbeat")
def heartbeat():
    """Prove both beat scheduling and worker execution through authenticated Redis."""
    redis.Redis.from_url(os.environ["CELERY_BROKER_URL"]).set("dify-image:beat", "ok", ex=20)


celery.conf.beat_schedule["dify-image-heartbeat"] = {
    "task": "dify_image_heartbeat", "schedule": 5.0, "options": {"queue": "celery"}}
