"""Strict SQLite task lifecycle and agent-status storage."""

from __future__ import annotations

import json
import sqlite3
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator


TERMINAL_STATES = ("DONE", "FAILED", "BLOCKED")


class InvalidTransition(RuntimeError):
    """Raised when a requested state change does not match the current attempt."""


@dataclass(frozen=True)
class Claim:
    task_id: str
    attempt_id: str
    prompt: str
    payload: str | None
    priority: int
    started_at: str


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="microseconds")


class BoardStore:
    """Small synchronous store; each operation owns a short DB connection."""

    def __init__(self, database: str | Path):
        self.database = str(database)

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.database, timeout=5.0)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA busy_timeout = 5000")
        return connection

    @contextmanager
    def _transaction(self, *, immediate: bool = False) -> Iterator[sqlite3.Connection]:
        connection = self._connect()
        try:
            connection.execute("BEGIN IMMEDIATE" if immediate else "BEGIN")
            yield connection
            connection.commit()
        except BaseException:
            connection.rollback()
            raise
        finally:
            connection.close()

    def initialize(self) -> None:
        with self._connect() as connection:
            connection.executescript(
                """
                PRAGMA journal_mode = WAL;

                CREATE TABLE IF NOT EXISTS tasks (
                    task_id TEXT PRIMARY KEY,
                    created_at TEXT NOT NULL,
                    priority INTEGER NOT NULL DEFAULT 0,
                    state TEXT NOT NULL CHECK (
                        state IN ('QUEUED', 'RUNNING', 'DONE', 'FAILED', 'BLOCKED')
                    ),
                    prompt TEXT NOT NULL CHECK (length(trim(prompt)) > 0),
                    payload TEXT,
                    started_at TEXT,
                    finished_at TEXT,
                    attempt_id TEXT,
                    UNIQUE (task_id, attempt_id),
                    CHECK (
                        (state = 'QUEUED' AND started_at IS NULL
                            AND finished_at IS NULL AND attempt_id IS NULL)
                        OR
                        (state = 'RUNNING' AND started_at IS NOT NULL
                            AND finished_at IS NULL AND attempt_id IS NOT NULL)
                        OR
                        (state IN ('DONE', 'FAILED', 'BLOCKED')
                            AND started_at IS NOT NULL AND finished_at IS NOT NULL
                            AND attempt_id IS NOT NULL)
                    )
                );

                CREATE INDEX IF NOT EXISTS tasks_claim_order
                    ON tasks (state, priority DESC, created_at, task_id);

                CREATE TABLE IF NOT EXISTS agent_status (
                    agent_id TEXT PRIMARY KEY CHECK (length(trim(agent_id)) > 0),
                    task_id TEXT,
                    attempt_id TEXT,
                    state TEXT NOT NULL CHECK (state IN ('IDLE', 'STARTING', 'WORKING')),
                    phase TEXT NOT NULL,
                    status_text TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    heartbeat_at TEXT NOT NULL,
                    UNIQUE (task_id, attempt_id),
                    CHECK (
                        (state = 'IDLE' AND task_id IS NULL AND attempt_id IS NULL)
                        OR
                        (state IN ('STARTING', 'WORKING')
                            AND task_id IS NOT NULL AND attempt_id IS NOT NULL)
                    ),
                    FOREIGN KEY (task_id, attempt_id)
                        REFERENCES tasks (task_id, attempt_id)
                );

                CREATE TRIGGER IF NOT EXISTS tasks_insert_queued_only
                BEFORE INSERT ON tasks
                WHEN NEW.state <> 'QUEUED'
                BEGIN
                    SELECT RAISE(ABORT, 'new tasks must be QUEUED');
                END;

                CREATE TRIGGER IF NOT EXISTS tasks_strict_state_transition
                BEFORE UPDATE OF state ON tasks
                WHEN NEW.state <> OLD.state AND NOT (
                    (OLD.state = 'QUEUED' AND NEW.state = 'RUNNING')
                    OR
                    (OLD.state = 'RUNNING'
                        AND NEW.state IN ('DONE', 'FAILED', 'BLOCKED'))
                )
                BEGIN
                    SELECT RAISE(ABORT, 'invalid task state transition');
                END;

                CREATE TRIGGER IF NOT EXISTS tasks_retain_terminal
                BEFORE DELETE ON tasks
                WHEN OLD.state IN ('DONE', 'FAILED', 'BLOCKED')
                BEGIN
                    SELECT RAISE(ABORT, 'terminal tasks are retained');
                END;

                CREATE TRIGGER IF NOT EXISTS agent_active_insert_requires_running
                BEFORE INSERT ON agent_status
                WHEN NEW.state IN ('STARTING', 'WORKING') AND NOT EXISTS (
                    SELECT 1 FROM tasks
                    WHERE task_id = NEW.task_id AND attempt_id = NEW.attempt_id
                      AND state = 'RUNNING'
                )
                BEGIN
                    SELECT RAISE(ABORT, 'active agent requires a running task attempt');
                END;

                CREATE TRIGGER IF NOT EXISTS agent_active_update_requires_running
                BEFORE UPDATE ON agent_status
                WHEN NEW.state IN ('STARTING', 'WORKING') AND NOT EXISTS (
                    SELECT 1 FROM tasks
                    WHERE task_id = NEW.task_id AND attempt_id = NEW.attempt_id
                      AND state = 'RUNNING'
                )
                BEGIN
                    SELECT RAISE(ABORT, 'active agent requires a running task attempt');
                END;

                CREATE TRIGGER IF NOT EXISTS task_terminal_requires_agent_release
                BEFORE UPDATE OF state ON tasks
                WHEN NEW.state IN ('DONE', 'FAILED', 'BLOCKED') AND EXISTS (
                    SELECT 1 FROM agent_status
                    WHERE task_id = OLD.task_id AND attempt_id = OLD.attempt_id
                      AND state IN ('STARTING', 'WORKING')
                )
                BEGIN
                    SELECT RAISE(ABORT, 'release active agent before task completion');
                END;
                """
            )

    def enqueue(
        self,
        prompt: str,
        *,
        priority: int = 0,
        payload: object | None = None,
        task_id: str | None = None,
    ) -> str:
        if not prompt.strip():
            raise ValueError("prompt must not be blank")
        resolved_task_id = task_id or str(uuid.uuid4())
        self._require_identifier("task_id", resolved_task_id)
        encoded_payload = None
        if payload is not None:
            encoded_payload = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        with self._transaction() as connection:
            connection.execute(
                """
                INSERT INTO tasks (
                    task_id, created_at, priority, state, prompt, payload,
                    started_at, finished_at, attempt_id
                ) VALUES (?, ?, ?, 'QUEUED', ?, ?, NULL, NULL, NULL)
                """,
                (resolved_task_id, _utc_now(), priority, prompt, encoded_payload),
            )
        return resolved_task_id

    def set_idle(self, agent_id: str, *, status_text: str = "No queued work") -> None:
        self._require_identifier("agent_id", agent_id)
        now = _utc_now()
        with self._transaction(immediate=True) as connection:
            self._require_agent_available(connection, agent_id)
            self._upsert_agent(
                connection,
                agent_id=agent_id,
                state="IDLE",
                task_id=None,
                attempt_id=None,
                phase="idle",
                status_text=status_text,
                now=now,
            )

    def claim_next(self, agent_id: str) -> Claim | None:
        """Atomically claim the next queued task and bind the agent to its attempt."""
        self._require_identifier("agent_id", agent_id)
        with self._transaction(immediate=True) as connection:
            self._require_agent_available(connection, agent_id)
            task = connection.execute(
                """
                SELECT task_id, prompt, payload, priority
                FROM tasks
                WHERE state = 'QUEUED'
                ORDER BY priority DESC, created_at, task_id
                LIMIT 1
                """
            ).fetchone()
            if task is None:
                now = _utc_now()
                self._upsert_agent(
                    connection,
                    agent_id=agent_id,
                    state="IDLE",
                    task_id=None,
                    attempt_id=None,
                    phase="idle",
                    status_text="No queued work",
                    now=now,
                )
                return None

            attempt_id = str(uuid.uuid4())
            started_at = _utc_now()
            updated = connection.execute(
                """
                UPDATE tasks
                SET state = 'RUNNING', started_at = ?, attempt_id = ?
                WHERE task_id = ? AND state = 'QUEUED'
                """,
                (started_at, attempt_id, task["task_id"]),
            )
            if updated.rowcount != 1:
                raise InvalidTransition("queued task changed during claim")
            self._upsert_agent(
                connection,
                agent_id=agent_id,
                state="STARTING",
                task_id=task["task_id"],
                attempt_id=attempt_id,
                phase="start",
                status_text="Task claimed",
                now=started_at,
            )
            return Claim(
                task_id=task["task_id"],
                attempt_id=attempt_id,
                prompt=task["prompt"],
                payload=task["payload"],
                priority=task["priority"],
                started_at=started_at,
            )

    def mark_working(
        self,
        agent_id: str,
        task_id: str,
        attempt_id: str,
        *,
        phase: str = "working",
        status_text: str = "Working",
    ) -> None:
        self._require_identifier("agent_id", agent_id)
        now = _utc_now()
        with self._transaction(immediate=True) as connection:
            self._require_active_attempt(connection, task_id, attempt_id)
            current = connection.execute(
                """
                SELECT 1 FROM agent_status
                WHERE agent_id = ? AND task_id = ? AND attempt_id = ?
                  AND state IN ('STARTING', 'WORKING')
                """,
                (agent_id, task_id, attempt_id),
            ).fetchone()
            if current is None:
                raise InvalidTransition("agent is not bound to this active attempt")
            self._upsert_agent(
                connection,
                agent_id=agent_id,
                state="WORKING",
                task_id=task_id,
                attempt_id=attempt_id,
                phase=phase,
                status_text=status_text,
                now=now,
            )

    def heartbeat(
        self,
        agent_id: str,
        task_id: str,
        attempt_id: str,
        *,
        status_text: str | None = None,
    ) -> None:
        self._require_identifier("agent_id", agent_id)
        now = _utc_now()
        with self._transaction(immediate=True) as connection:
            self._require_active_attempt(connection, task_id, attempt_id)
            updated = connection.execute(
                """
                UPDATE agent_status
                SET status_text = COALESCE(?, status_text),
                    updated_at = ?, heartbeat_at = ?
                WHERE agent_id = ? AND task_id = ? AND attempt_id = ?
                  AND state IN ('STARTING', 'WORKING')
                """,
                (status_text, now, now, agent_id, task_id, attempt_id),
            )
            if updated.rowcount != 1:
                raise InvalidTransition("agent is not bound to this active attempt")

    def finish(
        self,
        agent_id: str,
        task_id: str,
        attempt_id: str,
        outcome: str,
        *,
        status_text: str | None = None,
    ) -> None:
        self._require_identifier("agent_id", agent_id)
        normalized_outcome = outcome.upper()
        if normalized_outcome not in TERMINAL_STATES:
            raise ValueError(f"outcome must be one of: {', '.join(TERMINAL_STATES)}")
        now = _utc_now()
        with self._transaction(immediate=True) as connection:
            agent = connection.execute(
                """
                SELECT 1 FROM agent_status
                WHERE agent_id = ? AND task_id = ? AND attempt_id = ?
                  AND state IN ('STARTING', 'WORKING')
                """,
                (agent_id, task_id, attempt_id),
            ).fetchone()
            if agent is None:
                raise InvalidTransition("agent is not bound to this active attempt")
            self._upsert_agent(
                connection,
                agent_id=agent_id,
                state="IDLE",
                task_id=None,
                attempt_id=None,
                phase="idle",
                status_text=status_text or f"Task {normalized_outcome.lower()}",
                now=now,
            )
            updated = connection.execute(
                """
                UPDATE tasks
                SET state = ?, finished_at = ?
                WHERE task_id = ? AND attempt_id = ? AND state = 'RUNNING'
                """,
                (normalized_outcome, now, task_id, attempt_id),
            )
            if updated.rowcount != 1:
                raise InvalidTransition("task attempt is not running")

    def tasks(self) -> list[dict[str, object]]:
        return self._rows("SELECT * FROM tasks ORDER BY created_at, task_id")

    def agents(self) -> list[dict[str, object]]:
        return self._rows("SELECT * FROM agent_status ORDER BY agent_id")

    def _rows(self, sql: str) -> list[dict[str, object]]:
        with self._connect() as connection:
            return [dict(row) for row in connection.execute(sql).fetchall()]

    @staticmethod
    def _require_active_attempt(
        connection: sqlite3.Connection, task_id: str, attempt_id: str
    ) -> None:
        row = connection.execute(
            """
            SELECT 1 FROM tasks
            WHERE task_id = ? AND attempt_id = ? AND state = 'RUNNING'
            """,
            (task_id, attempt_id),
        ).fetchone()
        if row is None:
            raise InvalidTransition("task attempt is not running")

    @staticmethod
    def _require_agent_available(connection: sqlite3.Connection, agent_id: str) -> None:
        row = connection.execute(
            """
            SELECT 1 FROM agent_status
            WHERE agent_id = ? AND state IN ('STARTING', 'WORKING')
            """,
            (agent_id,),
        ).fetchone()
        if row is not None:
            raise InvalidTransition("agent already has an active task attempt")

    @staticmethod
    def _require_identifier(name: str, value: str) -> None:
        if not value.strip():
            raise ValueError(f"{name} must not be blank")

    @staticmethod
    def _upsert_agent(
        connection: sqlite3.Connection,
        *,
        agent_id: str,
        state: str,
        task_id: str | None,
        attempt_id: str | None,
        phase: str,
        status_text: str,
        now: str,
    ) -> None:
        connection.execute(
            """
            INSERT INTO agent_status (
                agent_id, task_id, attempt_id, state, phase, status_text,
                updated_at, heartbeat_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(agent_id) DO UPDATE SET
                task_id = excluded.task_id,
                attempt_id = excluded.attempt_id,
                state = excluded.state,
                phase = excluded.phase,
                status_text = excluded.status_text,
                updated_at = excluded.updated_at,
                heartbeat_at = excluded.heartbeat_at
            """,
            (agent_id, task_id, attempt_id, state, phase, status_text, now, now),
        )
