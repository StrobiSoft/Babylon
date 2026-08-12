"""Configuration loading and validation."""

from __future__ import annotations

import json
import re
from pathlib import Path
from urllib.parse import urlsplit


class ConfigError(ValueError):
    """Raised when the service configuration is invalid."""


SERVICE_ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")


def _number(value: object, name: str, minimum: float, maximum: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ConfigError(f"{name} must be a number")
    number = float(value)
    if not minimum <= number <= maximum:
        raise ConfigError(f"{name} must be between {minimum} and {maximum}")
    return number


def _port(value: object, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 65535:
        raise ConfigError(f"{name} must be an integer between 1 and 65535")
    return value


def _text(value: object, name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ConfigError(f"{name} must be a non-empty string")
    return value.strip()


def validate_config(raw: object, base_dir: Path) -> dict:
    if not isinstance(raw, dict):
        raise ConfigError("configuration root must be an object")

    interval = _number(raw.get("check_interval_seconds", 30), "check_interval_seconds", 1, 86400)
    timeout = _number(raw.get("timeout_seconds", 3), "timeout_seconds", 0.05, 60)
    listen_host = _text(raw.get("listen_host", "0.0.0.0"), "listen_host")
    listen_port = _port(raw.get("listen_port", 8090), "listen_port")
    database_path = Path(_text(raw.get("database_path", "data/zoolab-monitor.db"), "database_path"))
    if not database_path.is_absolute():
        database_path = (base_dir / database_path).resolve()

    raw_services = raw.get("services")
    if not isinstance(raw_services, list) or not raw_services:
        raise ConfigError("services must be a non-empty array")

    services: list[dict] = []
    identifiers: set[str] = set()
    for index, item in enumerate(raw_services):
        prefix = f"services[{index}]"
        if not isinstance(item, dict):
            raise ConfigError(f"{prefix} must be an object")
        service_id = _text(item.get("id"), f"{prefix}.id")
        if not SERVICE_ID_PATTERN.fullmatch(service_id):
            raise ConfigError(f"{prefix}.id must contain only lowercase letters, digits, and hyphens")
        if service_id in identifiers:
            raise ConfigError(f"duplicate service id: {service_id}")
        identifiers.add(service_id)
        name = _text(item.get("name"), f"{prefix}.name")
        check_type = _text(item.get("type"), f"{prefix}.type")
        service_timeout = _number(item.get("timeout_seconds", timeout), f"{prefix}.timeout_seconds", 0.05, 60)

        if check_type == "http":
            url = _text(item.get("url"), f"{prefix}.url")
            parsed = urlsplit(url)
            if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
                raise ConfigError(f"{prefix}.url must be an HTTP(S) URL without credentials")
            expected_status = item.get("expected_status", 200)
            if isinstance(expected_status, bool) or not isinstance(expected_status, int) or not 100 <= expected_status <= 599:
                raise ConfigError(f"{prefix}.expected_status must be an HTTP status code")
            services.append({
                "id": service_id,
                "name": name,
                "type": "http",
                "url": url,
                "expected_status": expected_status,
                "timeout_seconds": service_timeout,
            })
        elif check_type == "tcp":
            host = _text(item.get("host"), f"{prefix}.host")
            port = _port(item.get("port"), f"{prefix}.port")
            services.append({
                "id": service_id,
                "name": name,
                "type": "tcp",
                "host": host,
                "port": port,
                "timeout_seconds": service_timeout,
            })
        else:
            raise ConfigError(f"{prefix}.type must be 'http' or 'tcp'")

    return {
        "check_interval_seconds": interval,
        "timeout_seconds": timeout,
        "listen_host": listen_host,
        "listen_port": listen_port,
        "database_path": str(database_path),
        "services": services,
    }


def load_config(path: str | Path) -> dict:
    config_path = Path(path).resolve()
    try:
        with config_path.open(encoding="utf-8") as config_file:
            raw = json.load(config_file)
    except OSError as error:
        raise ConfigError(f"cannot read configuration: {error}") from error
    except json.JSONDecodeError as error:
        raise ConfigError(f"invalid JSON configuration: {error}") from error
    return validate_config(raw, config_path.parent)
