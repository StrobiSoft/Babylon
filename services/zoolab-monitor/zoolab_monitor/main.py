"""Application lifecycle management."""

from __future__ import annotations

import argparse
import logging
import os
import signal
import threading

from .config import ConfigError, load_config
from .database import Database
from .monitor import Monitor
from .web import create_server


def run(config_path: str) -> None:
    config = load_config(config_path)
    database = Database(config["database_path"])
    monitor = Monitor(config["services"], database, config["check_interval_seconds"])
    server = create_server(config, database, monitor)
    stopping = threading.Event()

    def stop(_signum: int, _frame: object) -> None:
        if not stopping.is_set():
            stopping.set()
            threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    logging.info("ZooLab Monitor listening on http://%s:%s", *server.server_address)
    monitor.start()
    try:
        server.serve_forever()
    finally:
        monitor.stop()
        server.server_close()


def main() -> None:
    parser = argparse.ArgumentParser(description="ZooLab service monitor")
    parser.add_argument(
        "--config",
        default=os.environ.get("ZOOLAB_CONFIG", "config/services.json"),
        help="path to the JSON configuration file",
    )
    args = parser.parse_args()
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(message)s")
    try:
        run(args.config)
    except ConfigError as error:
        parser.error(str(error))
