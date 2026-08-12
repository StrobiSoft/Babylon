"""Background monitoring scheduler."""

from __future__ import annotations

import logging
import threading

from .checks import check_service
from .database import Database


LOGGER = logging.getLogger(__name__)


class Monitor:
    def __init__(self, services: list[dict], database: Database, interval_seconds: float):
        self.services = services
        self.database = database
        self.interval_seconds = interval_seconds
        self.shutdown_timeout = sum(service["timeout_seconds"] for service in services) + 2
        self._stop_event = threading.Event()
        self._check_lock = threading.Lock()
        self._thread: threading.Thread | None = None

    def check_all(self) -> list[dict]:
        results: list[dict] = []
        with self._check_lock:
            for service in self.services:
                try:
                    outcome = check_service(service)
                except Exception as error:  # Keep one faulty check from stopping monitoring.
                    LOGGER.exception("Unexpected check failure for %s", service["id"])
                    outcome = {
                        "online": False,
                        "response_time_ms": 0,
                        "http_status": None,
                        "error": f"Internal check error: {str(error)[:200]}",
                    }
                results.append(self.database.record_check(service, outcome))
        return results

    def _run(self) -> None:
        while not self._stop_event.is_set():
            self.check_all()
            self._stop_event.wait(self.interval_seconds)

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop_event.clear()
        self._thread = threading.Thread(target=self._run, name="service-monitor", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop_event.set()
        if self._thread:
            self._thread.join(timeout=self.shutdown_timeout)
