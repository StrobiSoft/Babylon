from __future__ import annotations

import json
import socket
import socketserver
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from zoolab_monitor.checks import check_http, check_tcp
from zoolab_monitor.config import ConfigError, load_config, validate_config
from zoolab_monitor.database import Database
from zoolab_monitor.monitor import Monitor
from zoolab_monitor.web import create_server


class QuietHTTPHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/ok":
            self.send_response(200)
            body = b"ok"
        elif self.path == "/slow":
            time.sleep(0.2)
            self.send_response(200)
            body = b"slow"
        else:
            self.send_response(503)
            body = b"unavailable"
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except BrokenPipeError:
            pass

    def log_message(self, format_string: str, *args: object) -> None:
        return


class TCPHandler(socketserver.BaseRequestHandler):
    def handle(self) -> None:
        self.request.sendall(b"ready")


class LocalServersMixin:
    @classmethod
    def setUpClass(cls) -> None:
        cls.http_server = ThreadingHTTPServer(("127.0.0.1", 0), QuietHTTPHandler)
        cls.http_thread = threading.Thread(target=cls.http_server.serve_forever, daemon=True)
        cls.http_thread.start()
        cls.tcp_server = socketserver.ThreadingTCPServer(("127.0.0.1", 0), TCPHandler)
        cls.tcp_thread = threading.Thread(target=cls.tcp_server.serve_forever, daemon=True)
        cls.tcp_thread.start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.http_server.shutdown()
        cls.http_server.server_close()
        cls.tcp_server.shutdown()
        cls.tcp_server.server_close()
        cls.http_thread.join(timeout=2)
        cls.tcp_thread.join(timeout=2)

    def http_service(self, path: str, timeout: float = 1) -> dict:
        return {
            "id": "local-http",
            "name": "Local HTTP",
            "type": "http",
            "url": f"http://127.0.0.1:{self.http_server.server_port}{path}",
            "expected_status": 200,
            "timeout_seconds": timeout,
        }


class ConfigTests(unittest.TestCase):
    def valid_raw(self) -> dict:
        return {
            "check_interval_seconds": 30,
            "timeout_seconds": 2,
            "listen_host": "127.0.0.1",
            "listen_port": 8090,
            "database_path": "data/test.db",
            "services": [
                {
                    "id": "web-one",
                    "name": "Web One",
                    "type": "http",
                    "url": "https://example.test/health",
                },
                {"id": "tcp-one", "name": "TCP One", "type": "tcp", "host": "127.0.0.1", "port": 22},
            ],
        }

    def test_valid_configuration_is_loaded_and_normalized(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "services.json"
            path.write_text(json.dumps(self.valid_raw()), encoding="utf-8")
            config = load_config(path)
        self.assertEqual(config["check_interval_seconds"], 30.0)
        self.assertEqual(config["services"][0]["expected_status"], 200)
        self.assertTrue(Path(config["database_path"]).is_absolute())

    def test_invalid_json_configuration_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "bad.json"
            path.write_text("{broken", encoding="utf-8")
            with self.assertRaisesRegex(ConfigError, "invalid JSON"):
                load_config(path)

    def test_invalid_service_configurations_are_rejected(self) -> None:
        invalid_changes = [
            ("duplicate id", lambda raw: raw["services"].append(dict(raw["services"][0]))),
            ("bad url", lambda raw: raw["services"][0].update(url="file:///etc/passwd")),
            ("bad type", lambda raw: raw["services"][0].update(type="command")),
            ("bad port", lambda raw: raw["services"][1].update(port=70000)),
            ("bad interval", lambda raw: raw.update(check_interval_seconds=0)),
        ]
        for label, mutate in invalid_changes:
            with self.subTest(label=label):
                raw = self.valid_raw()
                mutate(raw)
                with self.assertRaises(ConfigError):
                    validate_config(raw, Path("/tmp"))


class CheckTests(LocalServersMixin, unittest.TestCase):
    def test_successful_http_check(self) -> None:
        result = check_http(self.http_service("/ok"))
        self.assertTrue(result["online"])
        self.assertEqual(result["http_status"], 200)
        self.assertGreaterEqual(result["response_time_ms"], 0)

    def test_non_200_http_check(self) -> None:
        result = check_http(self.http_service("/bad"))
        self.assertFalse(result["online"])
        self.assertEqual(result["http_status"], 503)
        self.assertIn("503", result["error"])

    def test_http_timeout_is_offline(self) -> None:
        result = check_http(self.http_service("/slow", timeout=0.03))
        self.assertFalse(result["online"])
        self.assertIsNone(result["http_status"])
        self.assertTrue(result["error"])

    def test_reachable_tcp_port(self) -> None:
        service = {
            "type": "tcp", "host": "127.0.0.1", "port": self.tcp_server.server_address[1],
            "timeout_seconds": 1,
        }
        result = check_tcp(service)
        self.assertTrue(result["online"])
        self.assertIsNone(result["http_status"])

    def test_unreachable_tcp_port(self) -> None:
        probe = socket.socket()
        probe.bind(("127.0.0.1", 0))
        unavailable_port = probe.getsockname()[1]
        probe.close()
        result = check_tcp({
            "type": "tcp", "host": "127.0.0.1", "port": unavailable_port, "timeout_seconds": 0.2,
        })
        self.assertFalse(result["online"])
        self.assertTrue(result["error"])


class DatabaseTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.database_path = str(Path(self.temporary_directory.name) / "history.db")
        self.database = Database(self.database_path)
        self.service = {"id": "service-one", "name": "Service One"}

    def tearDown(self) -> None:
        self.temporary_directory.cleanup()

    @staticmethod
    def outcome(online: bool) -> dict:
        return {
            "online": online,
            "response_time_ms": 12,
            "http_status": 200 if online else None,
            "error": "" if online else "connection refused",
        }

    def test_history_is_saved_and_read_back(self) -> None:
        saved = self.database.record_check(self.service, self.outcome(True), "2026-01-01T00:00:00.000Z")
        history = self.database.history("service-one", 10)
        self.assertEqual(len(history), 1)
        self.assertEqual(history[0], saved)
        self.assertTrue(history[0]["online"])

    def test_consecutive_failures_and_recovery(self) -> None:
        success = self.database.record_check(self.service, self.outcome(True), "2026-01-01T00:00:00.000Z")
        first_failure = self.database.record_check(self.service, self.outcome(False), "2026-01-01T00:01:00.000Z")
        second_failure = self.database.record_check(self.service, self.outcome(False), "2026-01-01T00:02:00.000Z")
        recovered = self.database.record_check(self.service, self.outcome(True), "2026-01-01T00:03:00.000Z")
        self.assertEqual(first_failure["consecutive_failures"], 1)
        self.assertEqual(second_failure["consecutive_failures"], 2)
        self.assertEqual(second_failure["last_success_at"], success["checked_at"])
        self.assertEqual(recovered["consecutive_failures"], 0)
        self.assertEqual(recovered["last_success_at"], recovered["checked_at"])

    def test_database_history_survives_reopening(self) -> None:
        self.database.record_check(self.service, self.outcome(True))
        reopened = Database(self.database_path)
        self.assertEqual(len(reopened.history("service-one")), 1)

    def test_parallel_database_writes(self) -> None:
        errors: list[BaseException] = []

        def write_result() -> None:
            try:
                self.database.record_check(self.service, self.outcome(True))
            except BaseException as error:
                errors.append(error)

        threads = [threading.Thread(target=write_result) for _ in range(8)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=3)
        self.assertFalse(errors)
        self.assertTrue(all(not thread.is_alive() for thread in threads))
        self.assertEqual(len(self.database.history("service-one", 20)), 8)


class APITests(LocalServersMixin, unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.database = Database(str(Path(self.temporary_directory.name) / "api.db"))
        self.service = self.http_service("/ok")
        self.config = {
            "listen_host": "127.0.0.1",
            "listen_port": 0,
            "services": [self.service],
        }
        self.monitor = Monitor([self.service], self.database, 3600)
        self.api_server = create_server(self.config, self.database, self.monitor)
        self.api_thread = threading.Thread(target=self.api_server.serve_forever, daemon=True)
        self.api_thread.start()
        self.base_url = f"http://127.0.0.1:{self.api_server.server_port}"

    def tearDown(self) -> None:
        self.api_server.shutdown()
        self.api_server.server_close()
        self.api_thread.join(timeout=2)
        self.temporary_directory.cleanup()

    def request_json(self, path: str, method: str = "GET", data: bytes | None = None) -> tuple[int, dict]:
        request = urllib.request.Request(self.base_url + path, method=method, data=data)
        with urllib.request.urlopen(request, timeout=2) as response:
            return response.status, json.load(response)

    def test_health_returns_http_200(self) -> None:
        status, body = self.request_json("/health")
        self.assertEqual(status, 200)
        self.assertEqual(body["status"], "ok")

    def test_services_response_structure(self) -> None:
        self.monitor.check_all()
        status, body = self.request_json("/api/services")
        self.assertEqual(status, 200)
        self.assertEqual(body["summary"], {"total": 1, "online": 1, "offline": 0})
        self.assertEqual(body["services"][0]["id"], "local-http")
        self.assertIn("current", body["services"][0])
        self.assertIsInstance(body["services"][0]["history"], list)

    def test_history_endpoint_honors_service_and_limit(self) -> None:
        self.monitor.check_all()
        self.monitor.check_all()
        status, body = self.request_json("/api/history?service=local-http&limit=1")
        self.assertEqual(status, 200)
        self.assertEqual(body["service"], "local-http")
        self.assertEqual(len(body["history"]), 1)

    def test_check_now_checks_only_configured_services(self) -> None:
        status, body = self.request_json("/api/check-now", method="POST")
        self.assertEqual(status, 200)
        self.assertEqual(body["checked"], 1)
        self.assertEqual(body["results"][0]["service_id"], "local-http")

    def test_check_now_rejects_request_body(self) -> None:
        request = urllib.request.Request(
            self.base_url + "/api/check-now", method="POST", data=b'{"url":"http://attacker.test"}'
        )
        with self.assertRaises(urllib.error.HTTPError) as context:
            urllib.request.urlopen(request, timeout=2)
        self.assertEqual(context.exception.code, 400)


if __name__ == "__main__":
    unittest.main()
