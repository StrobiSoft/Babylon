# CT105 local boards V1

This directory is an isolated discovery/design/skeleton artifact for issue #40.
It is not part of the Babylon application and does not replace the Babylon
Bridge/API communication or control plane.

The implementation deliberately uses only the Python standard library and one
local SQLite file. It has no web server, broker, Redis dependency, scheduler,
notification layer, or prompt executor.

## Protocol

`tasks` is the durable queue and audit trail. Its lifecycle is:

```text
QUEUED -> RUNNING -> DONE
                  -> FAILED
                  -> BLOCKED
```

Terminal rows are retained. There is intentionally no delete command. A claim
creates a UUID `attempt_id`, records `started_at`, and changes the task to
`RUNNING` inside a `BEGIN IMMEDIATE` SQLite transaction. Selection order is
highest numeric priority first, then oldest creation time and `task_id`.

`agent_status` contains the latest status for each agent. `IDLE` is the only
state allowed without a task binding. `STARTING` and `WORKING` require both
`task_id` and `attempt_id`, and that pair must reference the corresponding
claimed task. Claiming a task and publishing `STARTING` are one transaction.
Completing it and returning the same agent to `IDLE` are also one transaction.

SQLite is configured with foreign keys, WAL journal mode, and a five-second
busy timeout. `BEGIN IMMEDIATE` serializes competing claim writers, so a single
queued task cannot be claimed by two workers.

## Run the demo

Run commands from this directory; the database path is explicit and may live
outside the Git checkout in real CT105 use.

```sh
python3 -m boards.cli --db /tmp/ct105-boards-demo.sqlite init
python3 -m boards.cli --db /tmp/ct105-boards-demo.sqlite enqueue \
  --priority 10 --prompt "Inspect the next local work item"
python3 -m boards.cli --db /tmp/ct105-boards-demo.sqlite work-once \
  --agent-id ct105-demo-agent --status-text "Skeleton demonstration"
python3 -m boards.cli --db /tmp/ct105-boards-demo.sqlite tasks
python3 -m boards.cli --db /tmp/ct105-boards-demo.sqlite agents
```

`work-once` is a lifecycle demonstration only: it claims one task, marks it
working, and records the selected terminal outcome. It never interprets or
executes task content.

Run the tests without installing dependencies:

```sh
python3 -m unittest discover -s tests -v
```

## V1 boundaries

- One current attempt is recorded per task; retries/requeueing are outside V1.
- One process-local worker action is demonstrated; there is no resident daemon.
- Heartbeats are explicit writes, not an external liveness or lease mechanism.
- There is no stale-worker recovery policy because timeout/retry semantics need
  an explicit operational decision.
- The database has no authentication or encryption layer. Its containing path
  and OS permissions remain a CT105 deployment responsibility.
