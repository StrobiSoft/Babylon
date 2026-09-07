"""Command-line demonstration for the CT105-local board."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from .store import BoardStore, TERMINAL_STATES


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="CT105 local SQLite board V1")
    parser.add_argument("--db", type=Path, required=True, help="SQLite database path")
    commands = parser.add_subparsers(dest="command", required=True)

    commands.add_parser("init", help="create or verify the schema")

    enqueue = commands.add_parser("enqueue", help="append a queued task")
    enqueue.add_argument("--prompt", required=True)
    enqueue.add_argument("--priority", type=int, default=0)
    enqueue.add_argument("--payload-json")
    enqueue.add_argument("--task-id")

    commands.add_parser("tasks", help="print retained task rows as JSON Lines")
    commands.add_parser("agents", help="print current agent rows as JSON Lines")

    idle = commands.add_parser("idle", help="publish an unbound IDLE state")
    idle.add_argument("--agent-id", required=True)
    idle.add_argument("--status-text", default="No queued work")

    work = commands.add_parser("work-once", help="demonstrate one lifecycle")
    work.add_argument("--agent-id", required=True)
    work.add_argument("--phase", default="demo")
    work.add_argument("--status-text", default="Lifecycle demonstration")
    work.add_argument("--outcome", choices=[value.lower() for value in TERMINAL_STATES], default="done")
    return parser


def _print_rows(rows: list[dict[str, object]]) -> None:
    for row in rows:
        print(json.dumps(row, ensure_ascii=False, sort_keys=True))


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    store = BoardStore(args.db)

    if args.command == "init":
        store.initialize()
        print(f"initialized {args.db}")
        return 0

    store.initialize()
    if args.command == "enqueue":
        payload = None
        if args.payload_json is not None:
            payload = json.loads(args.payload_json)
        task_id = store.enqueue(
            args.prompt,
            priority=args.priority,
            payload=payload,
            task_id=args.task_id,
        )
        print(task_id)
        return 0
    if args.command == "tasks":
        _print_rows(store.tasks())
        return 0
    if args.command == "agents":
        _print_rows(store.agents())
        return 0
    if args.command == "idle":
        store.set_idle(args.agent_id, status_text=args.status_text)
        return 0
    if args.command == "work-once":
        claim = store.claim_next(args.agent_id)
        if claim is None:
            print("idle: no queued work")
            return 0
        store.mark_working(
            args.agent_id,
            claim.task_id,
            claim.attempt_id,
            phase=args.phase,
            status_text=args.status_text,
        )
        store.finish(
            args.agent_id,
            claim.task_id,
            claim.attempt_id,
            args.outcome,
        )
        print(
            json.dumps(
                {
                    "agent_id": args.agent_id,
                    "attempt_id": claim.attempt_id,
                    "outcome": args.outcome.upper(),
                    "task_id": claim.task_id,
                },
                sort_keys=True,
            )
        )
        return 0
    raise AssertionError(f"unhandled command: {args.command}")


if __name__ == "__main__":
    raise SystemExit(main())
