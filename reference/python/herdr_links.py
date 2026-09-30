from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import unicodedata
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Mapping


PLUGIN_ID = "herdr-links"
ACTION_ID = "navigate"
LINK_HANDLER_ID = "navigation-v1"
MANAGED_BLOCK_BEGIN = "<!-- BEGIN HERDR LINKS -->"
MANAGED_BLOCK_END = "<!-- END HERDR LINKS -->"
ID_NUMBER = r"[0-9A-HJKMNP-TV-Z]{1,13}"
WORKSPACE_ID = rf"w{ID_NUMBER}"
PANE_ID = rf"{WORKSPACE_ID}:p{ID_NUMBER}"
TAB_ID = rf"{WORKSPACE_ID}:t{ID_NUMBER}"
TARGET_PATTERNS = {"agent": PANE_ID, "pane": PANE_ID, "workspace": WORKSPACE_ID, "tab": TAB_ID}
SUPPORTED_RUNTIMES = {("0.7.5", 18), ("0.9.0", 22), ("0.9.1", 22), ("0.9.2", 22), ("0.9.3", 22)}
SUPPORTED_CLI_VERSIONS = {f"herdr {version}" for version, _ in SUPPORTED_RUNTIMES}
CUSTOM_SCHEME_VERSIONS = {"0.9.0", "0.9.1", "0.9.2", "0.9.3"}
LEGACY_URL_PATTERN = re.compile(
    rf"https://herdr\.invalid/v1/([0-9a-f]{{64}})/(agent|workspace|tab|pane)/({WORKSPACE_ID}(?::[pt]{ID_NUMBER})?)"
)
CUSTOM_URL_PATTERN = re.compile(
    rf"herdr://navigation/v1/([0-9a-f]{{64}})/(agent|workspace|tab|pane)/({WORKSPACE_ID}(?::[pt]{ID_NUMBER})?)"
)
FOCUS_METHODS = {
    "agent": ("pane.focus", "pane_id", "pane_info"),
    "workspace": ("workspace.focus", "workspace_id", "workspace_info"),
    "tab": ("tab.focus", "tab_id", "tab_info"),
    "pane": ("pane.focus", "pane_id", "pane_info"),
}
MAX_RESPONSE_BYTES = 4 * 1024 * 1024
ROOT = Path(__file__).resolve().parents[2]


class HerdrLinksError(Exception):
    pass


class HerdrApiError(HerdrLinksError):
    pass


@dataclass(frozen=True)
class InstructionChange:
    changed: bool
    backup: Path | None = None


@dataclass(frozen=True)
class InstallReceipt:
    instructions: InstructionChange
    plugin: dict


@dataclass(frozen=True)
class UninstallReceipt:
    instructions: InstructionChange
    plugin_was_linked: bool


def validate_target(kind: str, target: str) -> None:
    pattern = TARGET_PATTERNS.get(kind)
    if not pattern or not isinstance(target, str) or not re.fullmatch(pattern, target):
        raise HerdrLinksError("unsupported target kind or malformed public ID; use live pane/workspace/tab IDs")


def parse_navigation_url(url: str) -> tuple[str, str, str]:
    if not isinstance(url, str) or len(url) > 200:
        raise HerdrLinksError("malformed navigation URL")
    match = next(
        (match for pattern in (CUSTOM_URL_PATTERN, LEGACY_URL_PATTERN) if (match := pattern.fullmatch(url))),
        None,
    )
    if not match:
        raise HerdrLinksError("malformed navigation URL; only exact Herdr Links v1 targets are supported")
    session, kind, target = match.groups()
    validate_target(kind, target)
    return session, kind, target


def session_fingerprint(socket_path: Path) -> str:
    path = str(socket_path)
    if not socket_path.is_absolute() or any(ord(char) < 32 or ord(char) == 127 for char in path):
        raise HerdrLinksError("HERDR_SOCKET_PATH must name an absolute local Unix socket")
    try:
        metadata = socket_path.stat()
    except OSError as error:
        raise HerdrLinksError(f"cannot inspect invoking Herdr socket: {error.strerror}") from error
    if not stat.S_ISSOCK(metadata.st_mode) or metadata.st_uid != os.getuid():
        raise HerdrLinksError("HERDR_SOCKET_PATH must name a user-owned Unix socket")
    identity = [str(socket_path.resolve()), metadata.st_dev, metadata.st_ino, metadata.st_ctime_ns]
    return hashlib.sha256(json.dumps(identity, separators=(",", ":")).encode()).hexdigest()


def format_navigation_url(kind: str, target: str, fingerprint: str, version: str) -> str:
    validate_target(kind, target)
    if not re.fullmatch(r"[0-9a-f]{64}", fingerprint):
        raise HerdrLinksError("invalid session fingerprint")
    if version == "0.7.5":
        return f"https://herdr.invalid/v1/{fingerprint}/{kind}/{target}"
    if version in CUSTOM_SCHEME_VERSIONS:
        return f"herdr://navigation/v1/{fingerprint}/{kind}/{target}"
    raise HerdrLinksError(f"unsupported Herdr {version}; cannot choose a safe link scheme")


def navigation_url(kind: str, target: str, socket_path: Path, version: str = "0.9.0") -> str:
    return format_navigation_url(kind, target, session_fingerprint(socket_path), version)


def socket_from_environment(environment: Mapping[str, str]) -> Path:
    if environment.get("HERDR_ENV") != "1" or not environment.get("HERDR_SOCKET_PATH"):
        raise HerdrLinksError("requires HERDR_ENV=1 and explicit HERDR_SOCKET_PATH; no default-session fallback")
    return Path(environment["HERDR_SOCKET_PATH"])


def api_request(
    socket_path: Path, method: str, params: dict, expected_type: str, expected_session: str | None = None
) -> dict:
    request_id = f"herdr-links:{uuid.uuid4().hex}"
    request = {"id": request_id, "method": method, "params": params}
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            connection.settimeout(5)
            connection.connect(str(socket_path))
            if expected_session is not None and session_fingerprint(socket_path) != expected_session:
                raise HerdrLinksError("Herdr socket changed before request; regenerate the link")
            connection.sendall(json.dumps(request, separators=(",", ":")).encode() + b"\n")
            with connection.makefile("rb") as reader:
                data = reader.readline(MAX_RESPONSE_BYTES + 1)
        if len(data) > MAX_RESPONSE_BYTES or not data.endswith(b"\n"):
            raise HerdrApiError("truncated, empty, or oversized Herdr response")
        response = json.loads(data)
    except (OSError, ValueError) as error:
        raise HerdrApiError(f"Herdr request failed: {error}") from error
    if not isinstance(response, dict) or response.get("id") != request_id:
        raise HerdrApiError("invalid Herdr response identity")
    if "error" in response:
        error = response["error"]
        if not isinstance(error, dict):
            raise HerdrApiError("invalid Herdr error response")
        raise HerdrApiError(f"{error.get('code', 'unknown')}: {error.get('message', 'request failed')}")
    result = response.get("result")
    if not isinstance(result, dict) or result.get("type") != expected_type:
        raise HerdrApiError("unexpected Herdr response type")
    return result


def get_snapshot(socket_path: Path) -> dict:
    result = api_request(socket_path, "session.snapshot", {}, "session_snapshot")
    snapshot = result.get("snapshot")
    if not isinstance(snapshot, dict):
        raise HerdrApiError("missing Herdr session snapshot")
    runtime = (snapshot.get("version"), snapshot.get("protocol"))
    if runtime not in SUPPORTED_RUNTIMES:
        supported = ", ".join(f"{version}/{protocol}" for version, protocol in sorted(SUPPORTED_RUNTIMES))
        raise HerdrLinksError(
            f"unsupported Herdr {snapshot.get('version')} protocol {snapshot.get('protocol')}; verified runtimes: {supported}"
        )
    for key in ("panes", "workspaces", "tabs", "agents"):
        rows = snapshot.get(key)
        if not isinstance(rows, list) or not all(isinstance(row, dict) for row in rows):
            raise HerdrApiError(f"invalid snapshot {key}")
    return snapshot


def live_row(snapshot: dict, collection: str, key: str, target: str) -> dict | None:
    matches = [row for row in snapshot[collection] if row.get(key) == target]
    if len(matches) > 1:
        raise HerdrApiError("ambiguous live target")
    return matches[0] if matches else None


def validate_live_target(snapshot: dict, kind: str, target: str) -> None:
    validate_target(kind, target)
    collection = {"agent": "agents", "pane": "panes", "workspace": "workspaces", "tab": "tabs"}[kind]
    key = "pane_id" if kind == "agent" else f"{kind}_id"
    if live_row(snapshot, collection, key, target) is None:
        if kind == "agent":
            raise HerdrLinksError("target is not a live detected agent; use pane links for ordinary shells")
        raise HerdrLinksError("target is not live in the invoking session; refresh closed or moved IDs")


def click_context(environment: Mapping[str, str], url: str) -> dict:
    expected_environment = {
        "HERDR_PLUGIN_ID": PLUGIN_ID,
        "HERDR_PLUGIN_ACTION_ID": ACTION_ID,
        "HERDR_PLUGIN_LINK_HANDLER_ID": LINK_HANDLER_ID,
    }
    for key, value in expected_environment.items():
        if environment.get(key) != value:
            raise HerdrLinksError(f"missing or mismatched {key}")
    raw = environment.get("HERDR_PLUGIN_CONTEXT_JSON")
    if not raw or len(raw) > 128 * 1024:
        raise HerdrLinksError("missing or oversized HERDR_PLUGIN_CONTEXT_JSON")
    try:
        context = json.loads(raw)
    except ValueError as error:
        raise HerdrLinksError("invalid HERDR_PLUGIN_CONTEXT_JSON") from error
    if not isinstance(context, dict):
        raise HerdrLinksError("invalid HERDR_PLUGIN_CONTEXT_JSON object")
    for key, value in {
        "invocation_source": "link_click",
        "clicked_url": url,
        "link_handler_id": LINK_HANDLER_ID,
    }.items():
        if context.get(key) != value:
            raise HerdrLinksError(f"missing or mismatched click context {key}")
    for key, env_key, kind in (
        ("workspace_id", "HERDR_WORKSPACE_ID", "workspace"),
        ("tab_id", "HERDR_TAB_ID", "tab"),
        ("focused_pane_id", "HERDR_PANE_ID", "pane"),
    ):
        validate_target(kind, context.get(key))
        if environment.get(env_key) != context[key]:
            raise HerdrLinksError(f"inconsistent click context {key}")
    return context


def handle_navigation(environment: Mapping[str, str]) -> dict:
    url = environment.get("HERDR_PLUGIN_CLICKED_URL", "")
    session, kind, target = parse_navigation_url(url)
    context = click_context(environment, url)
    socket_path = socket_from_environment(environment)
    if session_fingerprint(socket_path) != session:
        raise HerdrLinksError("link belongs to a different Herdr session or socket lifetime; regenerate it")
    snapshot = get_snapshot(socket_path)
    if url.startswith("herdr://") and snapshot.get("version") not in CUSTOM_SCHEME_VERSIONS:
        raise HerdrLinksError("custom navigation targets require a Herdr 0.9 line runtime; regenerate this link")
    origin = live_row(snapshot, "panes", "pane_id", context["focused_pane_id"])
    if not origin or any(origin.get(key) != context[key] for key in ("workspace_id", "tab_id")):
        raise HerdrLinksError("clicked pane context is stale or belongs to another session")
    validate_live_target(snapshot, kind, target)
    if session_fingerprint(socket_path) != session:
        raise HerdrLinksError("Herdr socket changed during navigation; regenerate the link")
    method, parameter, expected_type = FOCUS_METHODS[kind]
    return api_request(socket_path, method, {parameter: target}, expected_type, expected_session=session)


def navigation_markdown(kind: str, target: str, label: str | None, socket_path: Path) -> str:
    validate_target(kind, target)
    label = target if label is None else label
    if not label or len(label) > 200 or any(unicodedata.category(char).startswith("C") for char in label):
        raise HerdrLinksError("label must be visible text without control characters, at most 200 characters")
    fingerprint = session_fingerprint(socket_path)
    snapshot = get_snapshot(socket_path)
    validate_live_target(snapshot, kind, target)
    url = format_navigation_url(kind, target, fingerprint, snapshot["version"])
    if session_fingerprint(socket_path) != fingerprint:
        raise HerdrLinksError("Herdr socket changed while generating the link; retry")
    escaped_label = re.sub(r"([\\`*_{}\[\]<>!|])", r"\\\1", label)
    return f"[{escaped_label}]({url})"


def managed_span(text: str) -> tuple[int, int] | None:
    begin_count = text.count(MANAGED_BLOCK_BEGIN)
    end_count = text.count(MANAGED_BLOCK_END)
    if begin_count == end_count == 0:
        return None
    if begin_count != 1 or end_count != 1:
        raise HerdrLinksError("partial or duplicate Herdr Links instruction markers; refusing to edit")
    start = text.index(MANAGED_BLOCK_BEGIN)
    end = text.index(MANAGED_BLOCK_END) + len(MANAGED_BLOCK_END)
    if end <= start or (start and text[start - 1] != "\n"):
        raise HerdrLinksError("invalid Herdr Links instruction marker boundaries")
    if end < len(text) and text[end] != "\n":
        raise HerdrLinksError("invalid Herdr Links instruction end boundary")
    if end < len(text):
        end += 1
    return start, end


def instruction_content(path: Path) -> str:
    if path.is_symlink():
        raise HerdrLinksError("refusing to replace a symlinked AGENTS.md")
    if path.exists():
        return path.read_bytes().decode("utf-8")
    return ""


def write_instructions(path: Path, original: str, updated: str) -> InstructionChange:
    if original == updated:
        return InstructionChange(False)
    path.parent.mkdir(parents=True, exist_ok=True)
    backup = None
    if path.exists():
        backup = path.with_name(f"{path.name}.herdr-links.bak")
        if backup.is_symlink():
            raise HerdrLinksError("refusing a symlinked instruction backup")
        if backup.exists() and backup.read_bytes() != original.encode("utf-8"):
            digest = hashlib.sha256(original.encode("utf-8")).hexdigest()[:16]
            backup = backup.with_name(f"{backup.name}.{digest}")
        if backup.is_symlink():
            raise HerdrLinksError("refusing a symlinked instruction backup")
        if not backup.exists():
            with backup.open("x", encoding="utf-8", newline="") as file:
                file.write(original)
            shutil.copymode(path, backup)
        elif backup.read_bytes() != original.encode("utf-8"):
            raise HerdrLinksError("instruction backup differs from expected contents")
    mode = stat.S_IMODE(path.stat().st_mode) if path.exists() else 0o644
    descriptor, temporary = tempfile.mkstemp(prefix=".herdr-links-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="") as file:
            file.write(updated)
            file.flush()
            os.fsync(file.fileno())
        os.chmod(temporary, mode)
        if instruction_content(path) != original:
            raise HerdrLinksError("AGENTS.md changed concurrently; refusing to overwrite it")
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return InstructionChange(True, backup)


def install_instructions(path: Path, snippet: Path, plugin_root: Path) -> InstructionChange:
    original = instruction_content(path)
    span = managed_span(original)
    content = snippet.read_text(encoding="utf-8").replace("@PLUGIN_ROOT@", str(plugin_root)).strip()
    block = f"{MANAGED_BLOCK_BEGIN}\n\n{content}\n\n{MANAGED_BLOCK_END}\n"
    if span:
        updated = original[:span[0]] + block + original[span[1]:]
    elif original and not original.endswith("\n"):
        updated = block + original
    else:
        updated = original + block
    return write_instructions(path, original, updated)


def uninstall_instructions(path: Path) -> InstructionChange:
    original = instruction_content(path)
    span = managed_span(original)
    if span is None:
        return InstructionChange(False)
    return write_instructions(path, original, original[:span[0]] + original[span[1]:])


def run_cli(binary: Path, arguments: list[str], runner: Callable = subprocess.run) -> str:
    try:
        completed = runner(
            [str(binary), *arguments], shell=False, capture_output=True, text=True, timeout=30
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise HerdrLinksError(f"Herdr CLI failed: {error}") from error
    if completed.returncode != 0:
        raise HerdrLinksError(f"Herdr CLI exited {completed.returncode}: {completed.stderr.strip()[:500]}")
    return completed.stdout


def installed_plugin(binary: Path, runner: Callable = subprocess.run) -> dict | None:
    output = run_cli(binary, ["plugin", "list", "--plugin", PLUGIN_ID, "--json"], runner)
    try:
        plugins = json.loads(output)["result"]["plugins"]
        if not isinstance(plugins, list):
            raise ValueError("invalid plugin list")
        matches = [plugin for plugin in plugins if plugin["plugin_id"] == PLUGIN_ID]
        if len(matches) > 1:
            raise ValueError("duplicate plugin ID")
        return matches[0] if matches else None
    except (ValueError, KeyError, TypeError) as error:
        raise HerdrLinksError("invalid Herdr plugin list response") from error


def restore_registration(previous: dict | None, plugin_root: Path, binary: Path, runner: Callable) -> None:
    current = installed_plugin(binary, runner)
    if current and Path(current.get("plugin_root", "")).resolve() != plugin_root.resolve():
        raise HerdrLinksError("unexpected plugin root; refusing to touch another checkout during rollback")
    if previous is None:
        if current:
            run_cli(binary, ["plugin", "unlink", PLUGIN_ID], runner)
            if installed_plugin(binary, runner):
                raise HerdrLinksError("new plugin registration remains after rollback")
        return
    enabled = previous.get("enabled", True)
    if current is None:
        run_cli(binary, ["plugin", "link", str(plugin_root), "--enabled" if enabled else "--disabled"], runner)
    elif current.get("enabled", True) == enabled:
        return
    else:
        run_cli(binary, ["plugin", "enable" if enabled else "disable", PLUGIN_ID], runner)
    restored = installed_plugin(binary, runner)
    if not restored or restored.get("enabled") != enabled or Path(restored.get("plugin_root", "")).resolve() != plugin_root.resolve():
        raise HerdrLinksError("previous plugin registration could not be restored")


def rollback_changes(
    previous: dict | None, plugin_root: Path, binary: Path, runner: Callable,
    agent_file: Path, edited: str, original: str,
) -> str:
    failures = []
    try:
        restore_registration(previous, plugin_root, binary, runner)
    except (HerdrLinksError, OSError) as error:
        failures.append(f"plugin rollback: {error}")
    try:
        if edited != original:
            write_instructions(agent_file, edited, original)
    except (HerdrLinksError, OSError, UnicodeError) as error:
        failures.append(f"instruction rollback: {error}")
    return "; rollback incomplete: " + "; ".join(failures) if failures else "; registration/instruction rollback completed"


def install(
    plugin_root: Path,
    agent_file: Path,
    snippet_file: Path,
    binary: Path,
    runner: Callable = subprocess.run,
) -> InstallReceipt:
    version = run_cli(binary, ["--version"], runner).strip()
    if version not in SUPPORTED_CLI_VERSIONS:
        supported = ", ".join(sorted(SUPPORTED_CLI_VERSIONS))
        raise HerdrLinksError(f"unsupported CLI {version}; verified CLIs: {supported}")
    previous_plugin = installed_plugin(binary, runner)
    if previous_plugin and Path(previous_plugin.get("plugin_root", "")).resolve() != plugin_root.resolve():
        raise HerdrLinksError("plugin ID belongs to another checkout; refusing to replace it")
    original = instruction_content(agent_file)
    instructions = install_instructions(agent_file, snippet_file, plugin_root)
    installed_content = instruction_content(agent_file)
    try:
        run_cli(binary, ["plugin", "link", str(plugin_root), "--enabled"], runner)
        plugin = installed_plugin(binary, runner)
        if (
            not plugin
            or plugin.get("enabled") is not True
            or Path(plugin.get("plugin_root", "")).resolve() != plugin_root.resolve()
            or plugin.get("warnings")
        ):
            raise HerdrLinksError("installation verification failed")
    except HerdrLinksError as error:
        rollback = rollback_changes(previous_plugin, plugin_root, binary, runner, agent_file, installed_content, original)
        raise HerdrLinksError(str(error) + rollback) from error
    return InstallReceipt(instructions, plugin)


def uninstall(agent_file: Path, binary: Path, runner: Callable = subprocess.run) -> UninstallReceipt:
    original = instruction_content(agent_file)
    managed_span(original)
    plugin = installed_plugin(binary, runner)
    if plugin and Path(plugin.get("plugin_root", "")).resolve() != ROOT:
        raise HerdrLinksError("plugin ID belongs to another checkout; refusing to unlink")
    instructions = uninstall_instructions(agent_file)
    removed_content = instruction_content(agent_file)
    if plugin:
        try:
            run_cli(binary, ["plugin", "unlink", PLUGIN_ID], runner)
            if installed_plugin(binary, runner):
                raise HerdrLinksError("plugin unlink did not remove registration")
        except HerdrLinksError as error:
            rollback = rollback_changes(plugin, ROOT, binary, runner, agent_file, removed_content, original)
            raise HerdrLinksError(str(error) + rollback) from error
    return UninstallReceipt(instructions, plugin is not None)


def main() -> int:
    parser = argparse.ArgumentParser(description="Local-only, session-bound Herdr navigation links")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("handle", help="handle a Herdr-provided link-click invocation")
    link = commands.add_parser("link", help="print a Markdown link after checking the live target; never focuses")
    link.add_argument("kind", choices=list(TARGET_PATTERNS))
    link.add_argument("target")
    link.add_argument("--label")
    commands.add_parser("install", help="link this plugin and install the managed global Pi instruction block")
    commands.add_parser("uninstall", help="unlink this plugin and remove only its managed Pi instruction block")
    args = parser.parse_args()
    try:
        if args.command == "handle":
            result = handle_navigation(os.environ)
            print(json.dumps({"ok": True, "type": result["type"]}))
        elif args.command == "link":
            print(navigation_markdown(args.kind, args.target, args.label, socket_from_environment(os.environ)))
        else:
            binary_path = os.environ.get("HERDR_BIN_PATH") or shutil.which("herdr")
            if not binary_path or not Path(binary_path).is_absolute():
                raise HerdrLinksError("cannot locate an absolute Herdr CLI executable")
            binary = Path(binary_path)
            agent_file = Path.home() / ".pi/agent/AGENTS.md"
            if args.command == "install":
                receipt = install(ROOT, agent_file, ROOT / "agent-instructions.md", binary)
                print(f"Installed {PLUGIN_ID} from {ROOT}")
            else:
                receipt = uninstall(agent_file, binary)
                print(f"Uninstalled {PLUGIN_ID}; unrelated plugins and instructions preserved")
            print(f"Pi instructions: {'updated' if receipt.instructions.changed else 'unchanged'} ({agent_file})")
            if receipt.instructions.backup:
                print(f"Pre-edit backup: {receipt.instructions.backup}")
        return 0
    except (HerdrLinksError, OSError, UnicodeError) as error:
        message = str(error).encode("unicode_escape").decode("ascii")
        print(f"herdr-links: {message}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
