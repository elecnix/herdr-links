import json
import os
import re
import socket
import subprocess
import tempfile
import threading
import tomllib
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
PYTHON_REFERENCE = ROOT / "reference/python"
os.sys.path.insert(0, str(PYTHON_REFERENCE))

import herdr_links


SNAPSHOT = {
    "version": "0.9.0",
    "protocol": 22,
    "focused_workspace_id": "wA",
    "focused_tab_id": "wA:tB",
    "focused_pane_id": "wA:pC",
    "workspaces": [{"workspace_id": "wA"}, {"workspace_id": "wD"}],
    "tabs": [{"tab_id": "wA:tB", "workspace_id": "wA"}],
    "panes": [
        {
            "pane_id": "wA:pC",
            "workspace_id": "wA",
            "tab_id": "wA:tB",
            "agent": "pi",
        },
        {
            "pane_id": "wA:pD",
            "workspace_id": "wA",
            "tab_id": "wA:tB",
            "agent": None,
        },
    ],
    "agents": [
        {
            "pane_id": "wA:pC",
            "workspace_id": "wA",
            "tab_id": "wA:tB",
            "agent": "pi",
            "name": "builder",
        }
    ],
}


class FakeHerdrServer:
    def __init__(self, socket_path, responder, expected_requests):
        self.socket_path = str(socket_path)
        self.responder = responder
        self.expected_requests = expected_requests
        self.requests = []
        self.error = None
        self.server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.server.bind(self.socket_path)
        self.server.listen()
        self.server.settimeout(2)
        self.thread = threading.Thread(target=self._serve, daemon=True)
        self.thread.start()

    def _serve(self):
        try:
            for _ in range(self.expected_requests):
                connection, _ = self.server.accept()
                with connection:
                    with connection.makefile("rb") as reader:
                        request = json.loads(reader.readline())
                    self.requests.append(request)
                    response = self.responder(request)
                    data = response if isinstance(response, bytes) else json.dumps(response).encode() + b"\n"
                    connection.sendall(data)
        except Exception as error:
            self.error = error
        finally:
            self.server.close()

    def finish(self):
        self.thread.join(timeout=3)
        if self.thread.is_alive():
            self.server.close()
            self.thread.join(timeout=1)
            raise AssertionError("fake Herdr server did not finish")
        if self.error:
            raise self.error


def success_responder(request):
    if request["method"] == "session.snapshot":
        result = {"type": "session_snapshot", "snapshot": SNAPSHOT}
    else:
        result_type = {
            "agent.focus": "agent_info",
            "workspace.focus": "workspace_info",
            "tab.focus": "tab_info",
            "pane.focus": "pane_info",
        }[request["method"]]
        result = {"type": result_type}
    return {"id": request["id"], "result": result}


def invocation_environment(socket_path, url):
    context = {
        "invocation_source": "link_click",
        "clicked_url": url,
        "link_handler_id": herdr_links.LINK_HANDLER_ID,
        "workspace_id": "wA",
        "tab_id": "wA:tB",
        "focused_pane_id": "wA:pC",
    }
    return {
        "HERDR_ENV": "1",
        "HERDR_SOCKET_PATH": str(socket_path),
        "HERDR_PLUGIN_ID": herdr_links.PLUGIN_ID,
        "HERDR_PLUGIN_ACTION_ID": herdr_links.ACTION_ID,
        "HERDR_PLUGIN_LINK_HANDLER_ID": herdr_links.LINK_HANDLER_ID,
        "HERDR_PLUGIN_CLICKED_URL": url,
        "HERDR_PLUGIN_CONTEXT_JSON": json.dumps(context),
        "HERDR_WORKSPACE_ID": "wA",
        "HERDR_TAB_ID": "wA:tB",
        "HERDR_PANE_ID": "wA:pC",
    }


class NavigationTest(unittest.TestCase):
    def test_routes_each_supported_live_target_to_the_exact_api_method(self):
        cases = [
            ("agent", "wA:pC", "pane.focus", {"pane_id": "wA:pC"}),
            ("workspace", "wD", "workspace.focus", {"workspace_id": "wD"}),
            ("tab", "wA:tB", "tab.focus", {"tab_id": "wA:tB"}),
            ("pane", "wA:pD", "pane.focus", {"pane_id": "wA:pD"}),
        ]
        for kind, target, method, params in cases:
            with self.subTest(kind=kind, target=target), tempfile.TemporaryDirectory() as directory:
                socket_path = Path(directory) / "herdr.sock"
                server = FakeHerdrServer(socket_path, success_responder, 2)
                url = herdr_links.navigation_url(kind, target, socket_path)
                result = herdr_links.handle_navigation(invocation_environment(socket_path, url))
                server.finish()
                self.assertEqual(result["type"], method.replace(".focus", "_info"))
                self.assertEqual(server.requests[0]["method"], "session.snapshot")
                self.assertEqual(server.requests[1]["method"], method)
                self.assertEqual(server.requests[1]["params"], params)

    def test_plain_shell_is_rejected_as_agent_but_supported_as_pane(self):
        herdr_links.validate_live_target(SNAPSHOT, "pane", "wA:pD")
        with self.assertRaisesRegex(herdr_links.HerdrLinksError, "detected agent"):
            herdr_links.validate_live_target(SNAPSHOT, "agent", "wA:pD")

    def test_modern_links_use_a_non_web_scheme_and_legacy_links_still_parse(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "herdr.sock"
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as server:
                server.bind(str(path))
                modern = herdr_links.navigation_url("pane", "wA:pD", path)
                legacy = herdr_links.navigation_url("pane", "wA:pD", path, version="0.7.5")
                self.assertTrue(modern.startswith("herdr://navigation/v1/"))
                self.assertTrue(legacy.startswith("https://herdr.invalid/v1/"))
                self.assertEqual(herdr_links.parse_navigation_url(modern)[1:], ("pane", "wA:pD"))
                self.assertEqual(herdr_links.parse_navigation_url(legacy)[1:], ("pane", "wA:pD"))
                with self.assertRaisesRegex(herdr_links.HerdrLinksError, "fingerprint"):
                    herdr_links.format_navigation_url("pane", "wA:pD", "not-a-fingerprint", "0.9.0")

    def test_custom_target_is_rejected_by_the_legacy_runtime_before_focus(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "herdr.sock"
            legacy_snapshot = {**SNAPSHOT, "version": "0.7.5", "protocol": 18}

            def responder(request):
                return {
                    "id": request["id"],
                    "result": {"type": "session_snapshot", "snapshot": legacy_snapshot},
                }

            server = FakeHerdrServer(path, responder, 1)
            url = herdr_links.navigation_url("pane", "wA:pD", path)
            with self.assertRaisesRegex(herdr_links.HerdrLinksError, "require a Herdr 0.9 line runtime"):
                herdr_links.handle_navigation(invocation_environment(path, url))
            server.finish()
            self.assertEqual([request["method"] for request in server.requests], ["session.snapshot"])

    def test_legacy_agent_target_validates_membership_then_uses_pane_focus(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "herdr.sock"
            legacy_snapshot = {**SNAPSHOT, "version": "0.7.5", "protocol": 18}

            def responder(request):
                result = (
                    {"type": "session_snapshot", "snapshot": legacy_snapshot}
                    if request["method"] == "session.snapshot"
                    else {"type": "pane_info"}
                )
                return {"id": request["id"], "result": result}

            server = FakeHerdrServer(path, responder, 2)
            url = herdr_links.navigation_url("agent", "wA:pC", path, version="0.7.5")
            result = herdr_links.handle_navigation(invocation_environment(path, url))
            server.finish()
            self.assertEqual(result["type"], "pane_info")
            self.assertEqual([request["method"] for request in server.requests], ["session.snapshot", "pane.focus"])
            self.assertEqual(server.requests[1]["params"], {"pane_id": "wA:pC"})

    def test_rejects_malformed_and_injection_urls(self):
        malformed = [
            "herdr://agent/wA:pC",
            "http://herdr.invalid/v1/" + "0" * 64 + "/agent/wA:pC",
            "https://user@herdr.invalid/v1/" + "0" * 64 + "/agent/wA:pC",
            "https://herdr.invalid:443/v1/" + "0" * 64 + "/agent/wA:pC",
            "https://herdr.invalid/v1/" + "0" * 64 + "/agent/wA:pC?x=1",
            "https://herdr.invalid/v1/" + "0" * 64 + "/agent/wA:pC#x",
            "https://herdr.invalid/v1/" + "0" * 64 + "/pane/wA:pD%2Fetc",
            "https://herdr.invalid/v1/" + "0" * 64 + "/pane/wA:pD;touch",
            "https://herdr.invalid/v1/" + "0" * 64 + "/unknown/wA:pC",
            "https://example.com/v1/" + "0" * 64 + "/agent/wA:pC",
            "https://herdr.invalid/v1/" + "0" * 64 + "/agent/wA:pC\n",
            "herdr://navigation/v1/" + "0" * 64 + "/pane/wA:pD?x=1",
            "herdr://navigation:443/v1/" + "0" * 64 + "/pane/wA:pD",
            "herdr://user@navigation/v1/" + "0" * 64 + "/pane/wA:pD",
            "HERDR://navigation/v1/" + "0" * 64 + "/pane/wA:pD",
            *[
                "https://herdr.invalid/v1/" + "0" * 64 + suffix
                for suffix in (
                    "/pane/wA:pC/", "/pane/../wA:pC", "/pane/wA:pC\x1b[2J",
                    "/pane/term_65acd2aeca6ab13a", "/pane/wA:pI", "/pane/wA:pD\\x",
                    "/pane/wA:tB", "/tab/wA:pC", "/workspace/wA:pC", "/agent/builder",
                    "/pane/wA:pC$(id)", "/pane/wA:pC%00", "/pane/wA:pC\x00",
                )
            ],
        ]
        for url in malformed:
            with self.subTest(url=url), self.assertRaises(herdr_links.HerdrLinksError):
                herdr_links.parse_navigation_url(url)

    def test_rejects_wrong_session_before_api_request(self):
        with tempfile.TemporaryDirectory() as directory:
            socket_path = Path(directory) / "herdr.sock"
            server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            server.bind(str(socket_path))
            try:
                url = f"https://herdr.invalid/v1/{'0' * 64}/pane/wA:pD"
                with self.assertRaisesRegex(herdr_links.HerdrLinksError, "different Herdr session"):
                    herdr_links.handle_navigation(invocation_environment(socket_path, url))
            finally:
                server.close()

    def test_rejects_missing_or_inconsistent_click_context(self):
        with tempfile.TemporaryDirectory() as directory:
            socket_path = Path(directory) / "herdr.sock"
            server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            server.bind(str(socket_path))
            try:
                url = herdr_links.navigation_url("pane", "wA:pD", socket_path)
                environment = invocation_environment(socket_path, url)
                del environment["HERDR_PLUGIN_CONTEXT_JSON"]
                with self.assertRaisesRegex(herdr_links.HerdrLinksError, "HERDR_PLUGIN_CONTEXT_JSON"):
                    herdr_links.handle_navigation(environment)

                environment = invocation_environment(socket_path, url)
                environment["HERDR_PLUGIN_CONTEXT_JSON"] = "{}"
                with self.assertRaisesRegex(herdr_links.HerdrLinksError, "invocation_source"):
                    herdr_links.handle_navigation(environment)
            finally:
                server.close()

    def test_context_and_environment_checks_fail_before_any_socket_connection(self):
        url = f"https://herdr.invalid/v1/{'0' * 64}/pane/wA:pD"
        valid = invocation_environment(Path("/missing/herdr.sock"), url)
        cases = []
        for key in valid:
            changed = dict(valid)
            del changed[key]
            cases.append(changed)
        for key, value in (
            ("HERDR_PLUGIN_ID", "other-plugin"), ("HERDR_PLUGIN_ACTION_ID", "exec"),
            ("HERDR_WORKSPACE_ID", "wD"), ("HERDR_PLUGIN_CONTEXT_JSON", "[]"),
            ("HERDR_PLUGIN_CONTEXT_JSON", "not json"), ("HERDR_PLUGIN_LINK_HANDLER_ID", "other"),
        ):
            cases.append({**valid, key: value})
        for key, value in (("invocation_source", "api"), ("clicked_url", url + "?x")):
            context = json.loads(valid["HERDR_PLUGIN_CONTEXT_JSON"])
            context[key] = value
            cases.append({**valid, "HERDR_PLUGIN_CONTEXT_JSON": json.dumps(context)})
        with patch.object(herdr_links, "api_request") as request:
            for environment in cases:
                with self.subTest(environment=environment), self.assertRaises(herdr_links.HerdrLinksError):
                    herdr_links.handle_navigation(environment)
            request.assert_not_called()

    def test_socket_replacement_invalidates_previously_generated_link(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "herdr.sock"
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as first:
                first.bind(str(path))
                url = herdr_links.navigation_url("pane", "wA:pD", path)
                path.unlink()
                with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as second:
                    second.bind(str(path))
                    with self.assertRaisesRegex(herdr_links.HerdrLinksError, "different Herdr session"):
                        herdr_links.handle_navigation(invocation_environment(path, url))

    def test_post_connect_session_check_prevents_restart_race_before_sending_focus(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "herdr.sock"
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as server:
                server.bind(str(path))
                server.listen()
                server.settimeout(1)
                with self.assertRaisesRegex(herdr_links.HerdrLinksError, "socket changed before request"):
                    herdr_links.api_request(path, "pane.focus", {"pane_id": "wA:pD"}, "pane_info", expected_session="0" * 64)
                connection, _ = server.accept()
                with connection:
                    self.assertEqual(connection.recv(1000), b"")

    def test_stale_click_origin_does_not_focus(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "herdr.sock"
            server = FakeHerdrServer(path, success_responder, 1)
            url = herdr_links.navigation_url("pane", "wA:pD", path)
            environment = invocation_environment(path, url)
            context = json.loads(environment["HERDR_PLUGIN_CONTEXT_JSON"])
            context["workspace_id"] = "wD"
            environment["HERDR_WORKSPACE_ID"] = "wD"
            environment["HERDR_PLUGIN_CONTEXT_JSON"] = json.dumps(context)
            with self.assertRaisesRegex(herdr_links.HerdrLinksError, "clicked pane context"):
                herdr_links.handle_navigation(environment)
            server.finish()
            self.assertEqual(len(server.requests), 1)

    def test_response_identity_type_and_data_are_validated(self):
        def wrong_id(request):
            return {**success_responder(request), "id": "wrong"}

        def wrong_type(request):
            return {"id": request["id"], "result": {"type": "workspace_info"}}

        def missing_snapshot(request):
            return {"id": request["id"], "result": {"type": "session_snapshot"}}

        def invalid_rows(request):
            response = success_responder(request)
            response["result"]["snapshot"] = {**SNAPSHOT, "panes": [None]}
            return response

        for responder in (wrong_id, wrong_type, missing_snapshot, invalid_rows):
            with self.subTest(responder=responder), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "herdr.sock"
                server = FakeHerdrServer(path, responder, 1)
                with self.assertRaises(herdr_links.HerdrApiError):
                    herdr_links.get_snapshot(path)
                server.finish()

    def test_empty_truncated_invalid_and_oversized_responses_fail_closed(self):
        for data in (b"", b"{}", b"not json\n", b"x" * 101 + b"\n"):
            with self.subTest(data=data), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "herdr.sock"
                server = FakeHerdrServer(path, lambda request: data, 1)
                with patch.object(herdr_links, "MAX_RESPONSE_BYTES", 100):
                    with self.assertRaises(herdr_links.HerdrApiError):
                        herdr_links.get_snapshot(path)
                server.finish()

    def test_socket_timeout_is_an_api_error(self):
        with patch.object(herdr_links.socket, "socket") as connection:
            connection.return_value.__enter__.return_value.connect.side_effect = TimeoutError("timed out")
            with self.assertRaisesRegex(herdr_links.HerdrApiError, "timed out"):
                herdr_links.get_snapshot(Path("/fake/socket"))

    def test_labels_reject_terminal_control_sequences(self):
        for label in ("", "hello\nworld", "\x1b[2J", "\x9b31m", "\u202etext"):
            with (
                self.subTest(label=label),
                patch.object(herdr_links, "navigation_url", return_value="url"),
                patch.object(herdr_links, "get_snapshot", return_value=SNAPSHOT) as snapshot,
            ):
                with self.assertRaisesRegex(herdr_links.HerdrLinksError, "label must be"):
                    herdr_links.navigation_markdown("pane", "wA:pD", label, Path("/missing"))
                snapshot.assert_not_called()

    def test_rejects_stale_target_without_sending_focus(self):
        with tempfile.TemporaryDirectory() as directory:
            socket_path = Path(directory) / "herdr.sock"
            server = FakeHerdrServer(socket_path, success_responder, 1)
            url = herdr_links.navigation_url("pane", "wA:pE", socket_path)
            with self.assertRaisesRegex(herdr_links.HerdrLinksError, "not live"):
                herdr_links.handle_navigation(invocation_environment(socket_path, url))
            server.finish()
            self.assertEqual([request["method"] for request in server.requests], ["session.snapshot"])

    def test_surfaces_failed_focus_api_call(self):
        def responder(request):
            if request["method"] == "session.snapshot":
                return {"id": request["id"], "result": {"type": "session_snapshot", "snapshot": SNAPSHOT}}
            return {
                "id": request["id"],
                "error": {"code": "pane_not_found", "message": "pane disappeared"},
            }

        with tempfile.TemporaryDirectory() as directory:
            socket_path = Path(directory) / "herdr.sock"
            server = FakeHerdrServer(socket_path, responder, 2)
            url = herdr_links.navigation_url("pane", "wA:pD", socket_path)
            with self.assertRaisesRegex(herdr_links.HerdrApiError, "pane_not_found.*pane disappeared"):
                herdr_links.handle_navigation(invocation_environment(socket_path, url))
            server.finish()

    def test_markdown_generation_uses_verified_live_target_and_escapes_label(self):
        with tempfile.TemporaryDirectory() as directory:
            socket_path = Path(directory) / "herdr.sock"
            server = FakeHerdrServer(socket_path, success_responder, 1)
            markdown = herdr_links.navigation_markdown(
                "agent", "wA:pC", "wA:pC — build [ready]", socket_path
            )
            server.finish()
            url = herdr_links.navigation_url("agent", "wA:pC", socket_path)
            self.assertEqual(markdown, f"[wA:pC — build \\[ready\\]]({url})")

    def test_rejects_non_socket_and_unsupported_protocol(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "not-a-socket"
            path.write_text("x")
            with self.assertRaisesRegex(herdr_links.HerdrLinksError, "Unix socket"):
                herdr_links.navigation_url("pane", "wA:pD", path)

            socket_path = Path(directory) / "herdr.sock"
            bad_snapshot = {**SNAPSHOT, "protocol": 23}

            def responder(request):
                return {
                    "id": request["id"],
                    "result": {"type": "session_snapshot", "snapshot": bad_snapshot},
                }

            server = FakeHerdrServer(socket_path, responder, 1)
            with self.assertRaisesRegex(herdr_links.HerdrLinksError, "protocol 23"):
                herdr_links.navigation_markdown("pane", "wA:pD", None, socket_path)
            server.finish()


class InstructionFileTest(unittest.TestCase):
    def test_supported_runtime_lines_are_accepted_but_mixed_pairs_are_not(self):
        for version, protocol in (("0.7.5", 18), ("0.9.0", 22), ("0.9.1", 22), ("0.9.3", 22)):
            with self.subTest(version=version), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "herdr.sock"
                snapshot = {**SNAPSHOT, "version": version, "protocol": protocol}
                server = FakeHerdrServer(
                    path,
                    lambda request, snapshot=snapshot: {
                        "id": request["id"],
                        "result": {"type": "session_snapshot", "snapshot": snapshot},
                    },
                    1,
                )
                self.assertEqual(herdr_links.get_snapshot(path)["version"], version)
                server.finish()
        for version, protocol in (("0.7.5", 22), ("0.9.0", 18), ("0.8.2", 21), ("0.9.0", 23), ("0.10.0", 22)):
            with self.subTest(version=version, protocol=protocol), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "herdr.sock"
                snapshot = {**SNAPSHOT, "version": version, "protocol": protocol}
                server = FakeHerdrServer(
                    path,
                    lambda request, snapshot=snapshot: {
                        "id": request["id"],
                        "result": {"type": "session_snapshot", "snapshot": snapshot},
                    },
                    1,
                )
                with self.assertRaises(herdr_links.HerdrLinksError):
                    herdr_links.get_snapshot(path)
                server.finish()

    def test_install_and_uninstall_are_idempotent_and_preserve_unrelated_content(self):
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            agent_file = directory / "AGENTS.md"
            snippet_file = directory / "agent-instructions.md"
            original = "# Existing\n\nKeep this exactly.\n"
            agent_file.write_text(original)
            snippet_file.write_text("## Herdr links\n\nRun `@PLUGIN_ROOT@/bin/herdr-links`.\n")

            first = herdr_links.install_instructions(agent_file, snippet_file, Path("/tmp/plugin"))
            installed = agent_file.read_text()
            second = herdr_links.install_instructions(agent_file, snippet_file, Path("/tmp/plugin"))

            self.assertTrue(first.changed)
            self.assertFalse(second.changed)
            self.assertEqual(installed, agent_file.read_text())
            self.assertEqual(installed.count(herdr_links.MANAGED_BLOCK_BEGIN), 1)
            self.assertIn("/tmp/plugin/bin/herdr-links", installed)
            self.assertEqual((directory / "AGENTS.md.herdr-links.bak").read_text(), original)

            removed = herdr_links.uninstall_instructions(agent_file)
            removed_again = herdr_links.uninstall_instructions(agent_file)
            self.assertTrue(removed.changed)
            self.assertFalse(removed_again.changed)
            self.assertEqual(agent_file.read_text(), original)
            self.assertEqual(removed.backup.read_text(), installed)

    def test_round_trip_handles_missing_final_newline_and_crlf(self):
        for original in ["no final newline", "# Existing\r\nKeep CRLF\r\n", ""]:
            with self.subTest(original=original), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "AGENTS.md"
                snippet = Path(directory) / "snippet.md"
                path.write_bytes(original.encode())
                snippet.write_text("instructions")
                herdr_links.install_instructions(path, snippet, ROOT)
                herdr_links.uninstall_instructions(path)
                self.assertEqual(path.read_bytes(), original.encode())

    def test_update_preserves_unrelated_content_added_after_install(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "AGENTS.md"
            snippet = Path(directory) / "snippet.md"
            path.write_text("before\n")
            snippet.write_text("version one")
            herdr_links.install_instructions(path, snippet, ROOT)
            with path.open("a") as file:
                file.write("after\n")
            before_update = path.read_text()
            snippet.write_text("version two")
            result = herdr_links.install_instructions(path, snippet, ROOT)
            self.assertEqual(result.backup.read_text(), before_update)
            self.assertIn("version two", path.read_text())
            herdr_links.uninstall_instructions(path)
            self.assertEqual(path.read_text(), "before\nafter\n")

    def test_symlinked_instruction_file_is_not_replaced(self):
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            real = directory / "actual.md"
            real.write_text("keep me\n")
            path = directory / "AGENTS.md"
            path.symlink_to(real)
            with self.assertRaisesRegex(herdr_links.HerdrLinksError, "symlink"):
                herdr_links.uninstall_instructions(path)
            self.assertTrue(path.is_symlink())
            self.assertEqual(real.read_text(), "keep me\n")

    def test_partial_or_duplicate_managed_markers_fail_closed(self):
        cases = [
            f"text\n{herdr_links.MANAGED_BLOCK_BEGIN}\n",
            f"{herdr_links.MANAGED_BLOCK_END}\ntext",
            (
                f"{herdr_links.MANAGED_BLOCK_BEGIN}\na\n{herdr_links.MANAGED_BLOCK_END}\n"
                f"{herdr_links.MANAGED_BLOCK_BEGIN}\nb\n{herdr_links.MANAGED_BLOCK_END}\n"
            ),
        ]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "AGENTS.md"
            snippet = Path(directory) / "snippet.md"
            snippet.write_text("content")
            for content in cases:
                with self.subTest(content=content):
                    path.write_text(content)
                    with self.assertRaises(herdr_links.HerdrLinksError):
                        herdr_links.install_instructions(path, snippet, ROOT)
                    self.assertEqual(path.read_text(), content)


class InstallerTest(unittest.TestCase):
    def test_failed_plugin_link_rolls_back_agent_instructions(self):
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            agent_file = directory / "AGENTS.md"
            snippet_file = directory / "instructions.md"
            original = "unrelated\n"
            agent_file.write_text(original)
            snippet_file.write_text("use @PLUGIN_ROOT@")
            calls = []

            def runner(argv, **kwargs):
                calls.append((argv, kwargs))
                if argv[1:] == ["--version"]:
                    return subprocess.CompletedProcess(argv, 0, "herdr 0.7.5\n", "")
                if argv[1:3] == ["plugin", "list"]:
                    return subprocess.CompletedProcess(argv, 0, json.dumps({"result": {"plugins": []}}), "")
                return subprocess.CompletedProcess(argv, 1, "", "link failed")

            with self.assertRaisesRegex(herdr_links.HerdrLinksError, "link failed"):
                herdr_links.install(
                    ROOT,
                    agent_file,
                    snippet_file,
                    Path("/fake/herdr"),
                    runner=runner,
                )

            self.assertEqual(agent_file.read_text(), original)
            self.assertEqual(calls[2][0], ["/fake/herdr", "plugin", "link", str(ROOT), "--enabled"])
            self.assertTrue(all(kwargs["shell"] is False for _, kwargs in calls))

    def test_successful_install_verifies_exact_enabled_local_plugin(self):
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            agent_file = directory / "AGENTS.md"
            snippet_file = directory / "instructions.md"
            agent_file.write_text("unrelated\n")
            snippet_file.write_text("use @PLUGIN_ROOT@")
            responses = [
                subprocess.CompletedProcess([], 0, "herdr 0.9.0\n", ""),
                subprocess.CompletedProcess([], 0, json.dumps({"result": {"plugins": []}}), ""),
                subprocess.CompletedProcess([], 0, "linked\n", ""),
                subprocess.CompletedProcess(
                    [],
                    0,
                    json.dumps(
                        {
                            "result": {
                                "plugins": [
                                    {
                                        "plugin_id": herdr_links.PLUGIN_ID,
                                        "plugin_root": str(ROOT),
                                        "enabled": True,
                                        "warnings": [],
                                    }
                                ]
                            }
                        }
                    ),
                    "",
                ),
            ]

            def runner(argv, **kwargs):
                return responses.pop(0)

            receipt = herdr_links.install(
                ROOT,
                agent_file,
                snippet_file,
                Path("/fake/herdr"),
                runner=runner,
            )
            self.assertTrue(receipt.instructions.changed)
            self.assertEqual(receipt.plugin["plugin_id"], herdr_links.PLUGIN_ID)
            self.assertFalse(responses)

    def test_other_checkout_registration_is_never_overwritten_or_unlinked(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "AGENTS.md"
            path.write_text("preserve\n")
            plugin = {"plugin_id": herdr_links.PLUGIN_ID, "plugin_root": "/different/checkout"}
            calls = []

            def runner(argv, **kwargs):
                calls.append(argv)
                stdout = "herdr 0.7.5" if argv[1:] == ["--version"] else json.dumps({"result": {"plugins": [plugin]}})
                return subprocess.CompletedProcess(argv, 0, stdout, "")

            with self.assertRaisesRegex(herdr_links.HerdrLinksError, "another checkout"):
                herdr_links.install(ROOT, path, ROOT / "agent-instructions.md", Path("/fake/herdr"), runner)
            with self.assertRaisesRegex(herdr_links.HerdrLinksError, "another checkout"):
                herdr_links.uninstall(path, Path("/fake/herdr"), runner)
            self.assertEqual(path.read_text(), "preserve\n")
            self.assertFalse(any("link" in argv or "unlink" in argv for argv in calls))

    def test_uninstall_failure_keeps_the_managed_instruction_block(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "AGENTS.md"
            path.write_text("preserve\n")
            herdr_links.install_instructions(path, ROOT / "agent-instructions.md", ROOT)
            installed = path.read_text()
            plugin = {"plugin_id": herdr_links.PLUGIN_ID, "plugin_root": str(ROOT)}

            def runner(argv, **kwargs):
                if argv[1:3] == ["plugin", "list"]:
                    return subprocess.CompletedProcess(argv, 0, json.dumps({"result": {"plugins": [plugin]}}), "")
                return subprocess.CompletedProcess(argv, 1, "", "unlink failed")

            with self.assertRaisesRegex(herdr_links.HerdrLinksError, "unlink failed"):
                herdr_links.uninstall(path, Path("/fake/herdr"), runner)
            self.assertEqual(path.read_text(), installed)

    def test_post_link_verification_failure_restores_instructions_and_registration(self):
        for preexisting in (False, True):
            with self.subTest(preexisting=preexisting), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "AGENTS.md"
                path.write_text("keep\n")
                good_plugin = {"plugin_id": herdr_links.PLUGIN_ID, "plugin_root": str(ROOT), "enabled": True, "warnings": []}
                plugin = good_plugin.copy() if preexisting else None
                actions = []

                def runner(argv, **kwargs):
                    nonlocal plugin
                    actions.append(argv)
                    if argv[1:] == ["--version"]:
                        stdout = "herdr 0.7.5"
                    elif argv[1:3] == ["plugin", "list"]:
                        stdout = json.dumps({"result": {"plugins": [plugin] if plugin else []}})
                    else:
                        if argv[1:3] == ["plugin", "link"]:
                            plugin = {**good_plugin, "warnings": ["bad manifest"]}
                        elif argv[1:3] == ["plugin", "unlink"]:
                            plugin = None
                        stdout = "ok"
                    return subprocess.CompletedProcess(argv, 0, stdout, "")

                with self.assertRaisesRegex(herdr_links.HerdrLinksError, "verification failed"):
                    herdr_links.install(ROOT, path, ROOT / "agent-instructions.md", Path("/fake/herdr"), runner)
                self.assertEqual(path.read_text(), "keep\n")
                self.assertEqual(plugin is not None, preexisting)
                if preexisting:
                    self.assertFalse(any("unlink" in argv for argv in actions))

    def test_rollback_failure_is_explicit_and_does_not_prevent_instruction_restore(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "AGENTS.md"
            path.write_text("keep\n")
            plugin = None

            def runner(argv, **kwargs):
                nonlocal plugin
                if argv[1:] == ["--version"]:
                    stdout = "herdr 0.7.5"
                elif argv[1:3] == ["plugin", "list"]:
                    stdout = json.dumps({"result": {"plugins": [plugin] if plugin else []}})
                elif argv[1:3] == ["plugin", "link"]:
                    plugin = {"plugin_id": herdr_links.PLUGIN_ID, "plugin_root": str(ROOT), "enabled": False}
                    stdout = "ok"
                else:
                    return subprocess.CompletedProcess(argv, 1, "", "unlink failed")
                return subprocess.CompletedProcess(argv, 0, stdout, "")

            with self.assertRaisesRegex(herdr_links.HerdrLinksError, "rollback incomplete.*plugin rollback.*unlink failed"):
                herdr_links.install(ROOT, path, ROOT / "agent-instructions.md", Path("/fake/herdr"), runner)
            self.assertEqual(path.read_text(), "keep\n")

    def test_instruction_removal_failure_never_unlinks_plugin(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "AGENTS.md"
            path.write_text("keep\n")
            plugin = {"plugin_id": herdr_links.PLUGIN_ID, "plugin_root": str(ROOT), "enabled": True}
            calls = []

            def runner(argv, **kwargs):
                calls.append(argv)
                plugins = [plugin] if len(calls) == 1 else []
                return subprocess.CompletedProcess(argv, 0, json.dumps({"result": {"plugins": plugins}}), "")

            with patch.object(herdr_links, "uninstall_instructions", side_effect=OSError("disk failed")):
                with self.assertRaisesRegex(OSError, "disk failed"):
                    herdr_links.uninstall(path, Path("/fake/herdr"), runner)
            self.assertEqual(len(calls), 1)
            self.assertNotIn("unlink", calls[0])

    def test_cli_timeout_surfaces_as_plugin_error(self):
        def runner(argv, **kwargs):
            raise subprocess.TimeoutExpired(argv, 30)

        with self.assertRaisesRegex(herdr_links.HerdrLinksError, "CLI failed"):
            herdr_links.run_cli(Path("/fake/herdr"), ["--version"], runner)

    def test_uninstall_skips_unlink_when_plugin_is_already_absent(self):
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            agent_file = directory / "AGENTS.md"
            snippet_file = directory / "instructions.md"
            agent_file.write_text("unrelated\n")
            snippet_file.write_text("use @PLUGIN_ROOT@")
            herdr_links.install_instructions(agent_file, snippet_file, ROOT)
            calls = []

            def runner(argv, **kwargs):
                calls.append(argv)
                return subprocess.CompletedProcess(argv, 0, json.dumps({"result": {"plugins": []}}), "")

            receipt = herdr_links.uninstall(agent_file, Path("/fake/herdr"), runner=runner)
            self.assertTrue(receipt.instructions.changed)
            self.assertFalse(receipt.plugin_was_linked)
            self.assertEqual(calls, [["/fake/herdr", "plugin", "list", "--plugin", herdr_links.PLUGIN_ID, "--json"]])


class ManifestTest(unittest.TestCase):
    def test_manifest_handler_is_narrow_and_reaches_node_through_a_login_shell(self):
        with (ROOT / "herdr-plugin.toml").open("rb") as file:
            manifest = tomllib.load(file)
        self.assertEqual(manifest["id"], herdr_links.PLUGIN_ID)
        self.assertEqual(manifest["version"], "0.4.0")
        self.assertEqual(manifest["min_herdr_version"], "0.7.5")
        self.assertEqual(manifest["platforms"], ["macos"])
        self.assertEqual(
            [entry["command"] for entry in manifest["build"]],
            [
                ["/bin/sh", "-lc", "npm ci --include=dev --ignore-scripts --no-audit --no-fund"],
                ["/bin/sh", "-lc", "npm run build"],
            ],
        )
        actions = {action["id"]: action["command"] for action in manifest["actions"]}
        self.assertEqual(actions["setup"], ["/bin/sh", "-lc", "node ./dist/cli.js setup"])
        self.assertEqual(actions["cleanup"], ["/bin/sh", "-lc", "node ./dist/cli.js cleanup"])
        self.assertEqual(actions["navigate"], ["/bin/sh", "-lc", "node ./dist/cli.js handle"])
        # Every command must go through a login shell. Herdr spawns plugin
        # commands with PATH=/usr/bin:/bin:/usr/sbin:/sbin, which cannot resolve
        # node, so a bare "node" argv entry fails with ENOENT on every click.
        for entry in [*manifest["build"], *manifest["actions"]]:
            command = entry["command"]
            self.assertNotIn(command[0], ("node", "npm"), f"{entry} bypasses the login shell")
            self.assertIn("l", command[1].lstrip("-"), f"{entry} does not start a login shell")
        self.assertEqual(manifest["link_handlers"][0]["action"], herdr_links.ACTION_ID)
        self.assertTrue(manifest["link_handlers"][0]["pattern"].endswith("$"))
        pattern = re.compile(manifest["link_handlers"][0]["pattern"])
        schemes = ("https://herdr.invalid/v1", "herdr://navigation/v1")
        valid_targets = (("agent", "wA:pD"), ("pane", "wA:pD"), ("workspace", "wA"), ("tab", "wA:tE"))
        invalid_targets = (("agent", "wA"), ("pane", "wA:tE"), ("workspace", "wA:pD"), ("tab", "wA:pD"))
        for scheme in schemes:
            for kind, target in valid_targets:
                with self.subTest(scheme=scheme, kind=kind, target=target):
                    url = f"{scheme}/{'a' * 64}/{kind}/{target}"
                    self.assertIsNotNone(pattern.fullmatch(url))
                    self.assertEqual(herdr_links.parse_navigation_url(url)[1:], (kind, target))
            for kind, target in invalid_targets:
                with self.subTest(scheme=scheme, kind=kind, target=target):
                    url = f"{scheme}/{'a' * 64}/{kind}/{target}"
                    self.assertIsNone(pattern.fullmatch(url))
                    with self.assertRaises(herdr_links.HerdrLinksError):
                        herdr_links.parse_navigation_url(url)
        for unrelated in ("https://github.com/a/b", "https://herdr.invalid.evil/v1/a", "herdr://pane/wA:pD"):
            self.assertIsNone(pattern.fullmatch(unrelated))


if __name__ == "__main__":
    unittest.main()
