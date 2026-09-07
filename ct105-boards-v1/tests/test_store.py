from __future__ import annotations

import sqlite3
import tempfile
import threading
import unittest
from pathlib import Path

from boards.store import BoardStore, InvalidTransition


class BoardStoreTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary_directory.cleanup)
        self.database = Path(self.temporary_directory.name) / "board.sqlite"
        self.store = BoardStore(self.database)
        self.store.initialize()

    def test_lifecycle_retains_terminal_task_and_returns_agent_to_idle(self) -> None:
        task_id = self.store.enqueue("test prompt", priority=7, payload={"kind": "test"})

        claim = self.store.claim_next("agent-a")
        self.assertIsNotNone(claim)
        assert claim is not None
        self.assertEqual(task_id, claim.task_id)
        self.store.mark_working(
            "agent-a", task_id, claim.attempt_id, phase="test", status_text="working"
        )
        self.store.heartbeat("agent-a", task_id, claim.attempt_id)
        self.store.finish("agent-a", task_id, claim.attempt_id, "DONE")

        task = self.store.tasks()[0]
        self.assertEqual("DONE", task["state"])
        self.assertEqual(claim.attempt_id, task["attempt_id"])
        self.assertIsNotNone(task["started_at"])
        self.assertIsNotNone(task["finished_at"])
        agent = self.store.agents()[0]
        self.assertEqual("IDLE", agent["state"])
        self.assertIsNone(agent["task_id"])
        self.assertIsNone(agent["attempt_id"])

    def test_priority_order_is_deterministic(self) -> None:
        self.store.enqueue("low", priority=1, task_id="low")
        self.store.enqueue("high", priority=10, task_id="high")
        claim = self.store.claim_next("agent-a")
        self.assertIsNotNone(claim)
        assert claim is not None
        self.assertEqual("high", claim.task_id)

    def test_only_one_competing_worker_claims_single_task(self) -> None:
        task_id = self.store.enqueue("only once")
        barrier = threading.Barrier(3)
        claims: list[object] = []
        errors: list[BaseException] = []

        def claim(agent_id: str) -> None:
            try:
                barrier.wait()
                claims.append(BoardStore(self.database).claim_next(agent_id))
            except BaseException as error:
                errors.append(error)

        workers = [
            threading.Thread(target=claim, args=("agent-a",)),
            threading.Thread(target=claim, args=("agent-b",)),
        ]
        for worker in workers:
            worker.start()
        barrier.wait()
        for worker in workers:
            worker.join(timeout=10)

        self.assertFalse(errors)
        self.assertTrue(all(not worker.is_alive() for worker in workers))
        successful = [claim for claim in claims if claim is not None]
        self.assertEqual(1, len(successful))
        self.assertEqual(task_id, successful[0].task_id)
        self.assertEqual("RUNNING", self.store.tasks()[0]["state"])
        agents = self.store.agents()
        self.assertEqual(["IDLE", "STARTING"], sorted(agent["state"] for agent in agents))
        idle = next(agent for agent in agents if agent["state"] == "IDLE")
        self.assertIsNone(idle["task_id"])
        self.assertIsNone(idle["attempt_id"])

    def test_working_requires_matching_task_and_attempt_binding(self) -> None:
        task_id = self.store.enqueue("bound work")
        claim = self.store.claim_next("agent-a")
        self.assertIsNotNone(claim)
        assert claim is not None

        with self.assertRaises(InvalidTransition):
            self.store.mark_working("agent-a", task_id, "wrong-attempt")
        with self.assertRaises(InvalidTransition):
            self.store.mark_working("agent-b", task_id, claim.attempt_id)

    def test_database_rejects_anonymous_working_state(self) -> None:
        with sqlite3.connect(self.database) as connection:
            with self.assertRaises(sqlite3.IntegrityError):
                connection.execute(
                    """
                    INSERT INTO agent_status (
                        agent_id, task_id, attempt_id, state, phase, status_text,
                        updated_at, heartbeat_at
                    ) VALUES ('anonymous', NULL, NULL, 'WORKING', 'test', 'bad', 'now', 'now')
                    """
                )

    def test_active_agent_cannot_claim_again_or_publish_idle(self) -> None:
        first_task = self.store.enqueue("first")
        second_task = self.store.enqueue("second")
        claim = self.store.claim_next("agent-a")
        self.assertIsNotNone(claim)
        assert claim is not None
        self.assertEqual(first_task, claim.task_id)

        with self.assertRaises(InvalidTransition):
            self.store.claim_next("agent-a")
        with self.assertRaises(InvalidTransition):
            self.store.set_idle("agent-a")

        states = {task["task_id"]: task["state"] for task in self.store.tasks()}
        self.assertEqual("RUNNING", states[first_task])
        self.assertEqual("QUEUED", states[second_task])

    def test_database_enforces_lifecycle_and_retains_terminal_rows(self) -> None:
        task_id = self.store.enqueue("strict lifecycle")
        with sqlite3.connect(self.database) as connection:
            with self.assertRaises(sqlite3.IntegrityError):
                connection.execute(
                    """
                    UPDATE tasks
                    SET state = 'DONE', started_at = 'now', finished_at = 'now',
                        attempt_id = 'made-up'
                    WHERE task_id = ?
                    """,
                    (task_id,),
                )

        claim = self.store.claim_next("agent-a")
        self.assertIsNotNone(claim)
        assert claim is not None
        self.store.finish("agent-a", task_id, claim.attempt_id, "DONE")
        with sqlite3.connect(self.database) as connection:
            with self.assertRaises(sqlite3.IntegrityError):
                connection.execute("DELETE FROM tasks WHERE task_id = ?", (task_id,))
        self.assertEqual("DONE", self.store.tasks()[0]["state"])

    def test_schema_has_exactly_two_user_tables_and_is_consistent(self) -> None:
        with sqlite3.connect(self.database) as connection:
            tables = connection.execute(
                """
                SELECT name FROM sqlite_schema
                WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
                ORDER BY name
                """
            ).fetchall()
            self.assertEqual([("agent_status",), ("tasks",)], tables)
            self.assertEqual("ok", connection.execute("PRAGMA integrity_check").fetchone()[0])
            self.assertEqual([], connection.execute("PRAGMA foreign_key_check").fetchall())

    def test_terminal_task_cannot_be_finished_again(self) -> None:
        task_id = self.store.enqueue("finish once")
        claim = self.store.claim_next("agent-a")
        self.assertIsNotNone(claim)
        assert claim is not None
        self.store.finish("agent-a", task_id, claim.attempt_id, "FAILED")

        with self.assertRaises(InvalidTransition):
            self.store.finish("agent-a", task_id, claim.attempt_id, "DONE")
        self.assertEqual("FAILED", self.store.tasks()[0]["state"])


if __name__ == "__main__":
    unittest.main()
