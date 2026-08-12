"""HTTP and TCP availability checks."""

from __future__ import annotations

import socket
import time
import urllib.error
import urllib.request


MAX_ERROR_LENGTH = 240


def _elapsed_ms(started: float) -> int:
    return max(0, round((time.monotonic() - started) * 1000))


def _error_message(error: BaseException) -> str:
    message = str(error).replace("\n", " ").strip() or error.__class__.__name__
    return message[:MAX_ERROR_LENGTH]


def check_http(service: dict) -> dict:
    started = time.monotonic()
    request = urllib.request.Request(
        service["url"],
        headers={"User-Agent": "ZooLab-Monitor/1.0", "Accept": "*/*"},
        method="GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=service["timeout_seconds"]) as response:
            status = response.status
            response.read(1024)
        online = status == service["expected_status"]
        return {
            "online": online,
            "response_time_ms": _elapsed_ms(started),
            "http_status": status,
            "error": "" if online else f"Unexpected HTTP status: {status}",
        }
    except urllib.error.HTTPError as error:
        return {
            "online": False,
            "response_time_ms": _elapsed_ms(started),
            "http_status": error.code,
            "error": f"HTTP error: {error.code}",
        }
    except (OSError, TimeoutError, urllib.error.URLError) as error:
        reason = error.reason if isinstance(error, urllib.error.URLError) else error
        return {
            "online": False,
            "response_time_ms": _elapsed_ms(started),
            "http_status": None,
            "error": _error_message(reason),
        }


def check_tcp(service: dict) -> dict:
    started = time.monotonic()
    try:
        with socket.create_connection(
            (service["host"], service["port"]), timeout=service["timeout_seconds"]
        ):
            pass
        return {
            "online": True,
            "response_time_ms": _elapsed_ms(started),
            "http_status": None,
            "error": "",
        }
    except (OSError, TimeoutError) as error:
        return {
            "online": False,
            "response_time_ms": _elapsed_ms(started),
            "http_status": None,
            "error": _error_message(error),
        }


def check_service(service: dict) -> dict:
    if service["type"] == "http":
        return check_http(service)
    if service["type"] == "tcp":
        return check_tcp(service)
    raise ValueError(f"unsupported check type: {service['type']}")
