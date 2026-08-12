"""Thread-safe SQLite persistence for monitoring results."""

from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class Database:
    def __init__(self, path: str):
        self.path = path
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.initialize()

    def connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=10)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA busy_timeout = 10000")
        connection.execute("PRAGMA foreign_keys = ON")
        return connection

    @contextmanager
    def connection(self) -> Iterator[sqlite3.Connection]:
        connection = self.connect()
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def initialize(self) -> None:
        with self.connection() as connection:
            connection.execute("PRAGMA journal_mode = WAL")
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS checks (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    service_id TEXT NOT NULL,
                    service_name TEXT NOT NULL,
                    checked_at TEXT NOT NULL,
                    online INTEGER NOT NULL CHECK (online IN (0, 1)),
                    response_time_ms INTEGER NOT NULL,
                    http_status INTEGER,
                    error TEXT NOT NULL,
                    consecutive_failures INTEGER NOT NULL,
                    last_success_at TEXT
                )
                """
            )
            connection.execute(
                "CREATE INDEX IF NOT EXISTS idx_checks_service_time ON checks(service_id, id DESC)"
            )

    def record_check(self, service: dict, outcome: dict, checked_at: str | None = None) -> dict:
        timestamp = checked_at or utc_now()
        with self.connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            previous = connection.execute(
                "SELECT consecutive_failures, last_success_at FROM checks WHERE service_id = ? ORDER BY id DESC LIMIT 1",
                (service["id"],),
            ).fetchone()
            if outcome["online"]:
                failures = 0
                last_success = timestamp
            else:
                failures = (previous["consecutive_failures"] if previous else 0) + 1
                last_success = previous["last_success_at"] if previous else None
            cursor = connection.execute(
                """
                INSERT INTO checks (
                    service_id, service_name, checked_at, online, response_time_ms,
                    http_status, error, consecutive_failures, last_success_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    service["id"], service["name"], timestamp, bool(outcome["online"]),
                    int(outcome["response_time_ms"]), outcome.get("http_status"),
                    outcome.get("error", "")[:240], failures, last_success,
                ),
            )
            row_id = cursor.lastrowid
        return self.get_by_id(row_id)

    def get_by_id(self, row_id: int) -> dict:
        with self.connection() as connection:
            row = connection.execute("SELECT * FROM checks WHERE id = ?", (row_id,)).fetchone()
        if row is None:
            raise LookupError(f"check row {row_id} not found")
        return self._serialize(row)

    def latest(self, service_id: str) -> dict | None:
        with self.connection() as connection:
            row = connection.execute(
                "SELECT * FROM checks WHERE service_id = ? ORDER BY id DESC LIMIT 1", (service_id,)
            ).fetchone()
        return self._serialize(row) if row else None

    def history(self, service_id: str, limit: int = 20) -> list[dict]:
        with self.connection() as connection:
            rows = connection.execute(
                "SELECT * FROM checks WHERE service_id = ? ORDER BY id DESC LIMIT ?",
                (service_id, limit),
            ).fetchall()
        return [self._serialize(row) for row in rows]

    @staticmethod
    def _serialize(row: sqlite3.Row) -> dict:
        result = dict(row)
        result["online"] = bool(result["online"])
        return result
