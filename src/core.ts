import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  accessSync,
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PLUGIN_ID = "herdr-links";
export const LEGACY_PLUGIN_ID = "dima.herdr-links";
export const ACTION_ID = "navigate";
export const LINK_HANDLER_ID = "navigation-v1";
export const VERSION = "0.4.0";
export const MANAGED_BLOCK_BEGIN = "<!-- BEGIN HERDR LINKS -->";
export const MANAGED_BLOCK_END = "<!-- END HERDR LINKS -->";
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

const ID_NUMBER = "[0-9A-HJKMNP-TV-Z]{1,13}";
const WORKSPACE_ID = `w${ID_NUMBER}`;
const PANE_ID = `${WORKSPACE_ID}:p${ID_NUMBER}`;
const TAB_ID = `${WORKSPACE_ID}:t${ID_NUMBER}`;

export type TargetKind = "agent" | "workspace" | "tab" | "pane";
export type Environment = Readonly<Record<string, string | undefined>>;
export type JsonObject = Record<string, unknown>;

const TARGET_PATTERNS: Readonly<Record<TargetKind, RegExp>> = {
  agent: new RegExp(`^${PANE_ID}$`),
  workspace: new RegExp(`^${WORKSPACE_ID}$`),
  tab: new RegExp(`^${TAB_ID}$`),
  pane: new RegExp(`^${PANE_ID}$`),
};

const LEGACY_URL_PATTERN = new RegExp(
  `^https://herdr\\.invalid/v1/(?:([0-9a-f]{64})/)?(agent|workspace|tab|pane)/(${WORKSPACE_ID}(?::[pt]${ID_NUMBER})?)$`,
);
const CUSTOM_URL_PATTERN = new RegExp(
  `^herdr://navigation/v1/(?:([0-9a-f]{64})/)?(agent|workspace|tab|pane)/(${WORKSPACE_ID}(?::[pt]${ID_NUMBER})?)$`,
);

// Runtime pairs verified against this plugin. A version may pair with more than
// one protocol across its lifetime, so the pair is matched exactly rather than
// by version alone. The whole 0.9 line is listed: a patch release does not change
// the focus methods or snapshot shape this plugin reads, and the upstream gate
// refusing 0.9.1 while the protocol is unchanged was the reason for this fork.
const SUPPORTED_RUNTIMES = new Set(["0.7.5/18", "0.9.0/22", "0.9.1/22", "0.9.2/22", "0.9.3/22"]);
const SUPPORTED_CLI_VERSIONS = new Set(["herdr 0.7.5", "herdr 0.9.0", "herdr 0.9.1", "herdr 0.9.2", "herdr 0.9.3"]);
// The scheme a 0.9.x runtime uses for a private OSC 8 target. The legacy 0.7.5
// line keeps the reserved HTTPS form because that release rejects custom schemes.
const CUSTOM_SCHEME_VERSIONS = new Set(["0.9.0", "0.9.1", "0.9.2", "0.9.3"]);
const FOCUS_METHODS: Readonly<Record<TargetKind, readonly [string, string, string]>> = {
  agent: ["pane.focus", "pane_id", "pane_info"],
  workspace: ["workspace.focus", "workspace_id", "workspace_info"],
  tab: ["tab.focus", "tab_id", "tab_info"],
  pane: ["pane.focus", "pane_id", "pane_info"],
};

function discoverRoot(start: string): string {
  let candidate = start;
  for (let depth = 0; depth < 5; depth += 1) {
    if (existsSync(join(candidate, "herdr-plugin.toml"))) return candidate;
    const parent = dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  return resolve(start, "..");
}

export const ROOT = discoverRoot(dirname(fileURLToPath(import.meta.url)));

export class HerdrLinksError extends Error {
  override readonly name: string = "HerdrLinksError";
}

export class HerdrApiError extends HerdrLinksError {
  override readonly name: string = "HerdrApiError";
}

export interface InstructionChange {
  changed: boolean;
  backup?: string;
}

export interface InstallReceipt {
  instructions: InstructionChange;
  plugin: JsonObject;
}

export interface UninstallReceipt {
  instructions: InstructionChange;
  pluginWasLinked: boolean;
}

export interface MigrationReceipt {
  changed: boolean;
  plugin: JsonObject;
}

export interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export type CliRunner = (binary: string, arguments_: readonly string[]) => CliResult;
export type StoredPluginReader = () => JsonObject[];

export interface InstallerRuntime {
  runner?: CliRunner;
  readStoredPlugins?: StoredPluginReader;
}

interface InstructionEdit {
  change: InstructionChange;
  original: string;
  updated: string;
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readUtf8(path: string): string {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(readFileSync(path));
}

function asciiJsonString(value: string): string {
  return JSON.stringify(value).replace(/[^\x00-\x7f]/gu, (character) => {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) throw new HerdrLinksError("cannot encode Herdr socket path");
    if (codePoint <= 0xffff) return `\\u${codePoint.toString(16).padStart(4, "0")}`;
    const adjusted = codePoint - 0x10000;
    const high = 0xd800 + (adjusted >> 10);
    const low = 0xdc00 + (adjusted & 0x3ff);
    return `\\u${high.toString(16)}\\u${low.toString(16)}`;
  });
}

function lstatOrUndefined(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if (isRecord(error) && error["code"] === "ENOENT") return undefined;
    throw error;
  }
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function countOccurrences(text: string, value: string): number {
  let count = 0;
  let offset = 0;
  while (true) {
    const index = text.indexOf(value, offset);
    if (index === -1) return count;
    count += 1;
    offset = index + value.length;
  }
}

function requiredString(value: unknown, message: string): string {
  if (typeof value !== "string") throw new HerdrLinksError(message);
  return value;
}

export function validateTarget(kind: string, target: unknown): asserts kind is TargetKind {
  const pattern = TARGET_PATTERNS[kind as TargetKind];
  if (!pattern || typeof target !== "string" || !pattern.test(target)) {
    throw new HerdrLinksError("unsupported target kind or malformed public ID; use live pane/workspace/tab IDs");
  }
}

// The session fingerprint is optional. A link with one is bound to the socket
// that minted it and is rejected after the socket is recreated. A link without
// one skips that check, which saves an agent the hash computation at the cost
// of letting a stale link resolve. Herdr never reuses a closed tab or pane ID,
// and the target ID carries its workspace, so an omitted fingerprint cannot
// focus the wrong location.
export function parseNavigationUrl(url: unknown): readonly [string | null, TargetKind, string] {
  if (typeof url !== "string" || url.length > 200) throw new HerdrLinksError("malformed navigation URL");
  const match = CUSTOM_URL_PATTERN.exec(url) ?? LEGACY_URL_PATTERN.exec(url);
  if (!match) {
    throw new HerdrLinksError("malformed navigation URL; only exact Herdr Links v1 targets are supported");
  }
  const session = match[1] === undefined ? null : requiredString(match[1], "malformed navigation URL");
  const kind = requiredString(match[2], "malformed navigation URL");
  const target = requiredString(match[3], "malformed navigation URL");
  validateTarget(kind, target);
  return [session, kind, target];
}

export function sessionFingerprint(socketPath: string): string {
  if (!isAbsolute(socketPath) || /[\x00-\x1f\x7f]/u.test(socketPath)) {
    throw new HerdrLinksError("HERDR_SOCKET_PATH must name an absolute local Unix socket");
  }
  let metadata: ReturnType<typeof statSync>;
  try {
    metadata = statSync(socketPath, { bigint: true });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new HerdrLinksError(`cannot inspect invoking Herdr socket: ${detail}`, { cause: error });
  }
  if (!metadata.isSocket() || metadata.uid !== BigInt(process.getuid?.() ?? -1)) {
    throw new HerdrLinksError("HERDR_SOCKET_PATH must name a user-owned Unix socket");
  }
  const identity = `[${asciiJsonString(realpathSync(socketPath))},${metadata.dev},${metadata.ino},${metadata.ctimeNs}]`;
  return createHash("sha256").update(identity).digest("hex");
}

export function formatNavigationUrl(kind: string, target: string, fingerprint: string, version: string): string {
  validateTarget(kind, target);
  if (!/^[0-9a-f]{64}$/u.test(fingerprint)) throw new HerdrLinksError("invalid session fingerprint");
  if (version === "0.7.5") return `https://herdr.invalid/v1/${fingerprint}/${kind}/${target}`;
  if (CUSTOM_SCHEME_VERSIONS.has(version)) return `herdr://navigation/v1/${fingerprint}/${kind}/${target}`;
  throw new HerdrLinksError(`unsupported Herdr ${version}; cannot choose a safe link scheme`);
}

export function navigationUrl(kind: string, target: string, socketPath: string, version = "0.9.0"): string {
  return formatNavigationUrl(kind, target, sessionFingerprint(socketPath), version);
}

export function socketFromEnvironment(environment: Environment): string {
  if (environment["HERDR_ENV"] !== "1" || !environment["HERDR_SOCKET_PATH"]) {
    throw new HerdrLinksError("requires HERDR_ENV=1 and explicit HERDR_SOCKET_PATH; no default-session fallback");
  }
  return environment["HERDR_SOCKET_PATH"];
}

function parseApiResponse(data: Buffer, requestId: string, expectedType: string): JsonObject {
  let response: unknown;
  try {
    response = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data));
  } catch (error) {
    throw new HerdrApiError(`Herdr request failed: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
  if (!isRecord(response) || response["id"] !== requestId) {
    throw new HerdrApiError("invalid Herdr response identity");
  }
  if ("error" in response) {
    const apiError = response["error"];
    if (!isRecord(apiError)) throw new HerdrApiError("invalid Herdr error response");
    const code = typeof apiError["code"] === "string" ? apiError["code"] : "unknown";
    const message = typeof apiError["message"] === "string" ? apiError["message"] : "request failed";
    throw new HerdrApiError(`${code}: ${message}`);
  }
  const result = response["result"];
  if (!isRecord(result) || result["type"] !== expectedType) {
    throw new HerdrApiError("unexpected Herdr response type");
  }
  return result;
}

export async function apiRequest(
  socketPath: string,
  method: string,
  params: JsonObject,
  expectedType: string,
  expectedSession?: string,
  maxResponseBytes = MAX_RESPONSE_BYTES,
): Promise<JsonObject> {
  const requestId = `herdr-links:${randomUUID().replaceAll("-", "")}`;
  const payload = `${JSON.stringify({ id: requestId, method, params })}\n`;
  return await new Promise<JsonObject>((resolvePromise, rejectPromise) => {
    let settled = false;
    let data = Buffer.alloc(0);
    const connection = createConnection(socketPath);

    const reject = (error: unknown): void => {
      if (settled) return;
      settled = true;
      connection.destroy();
      rejectPromise(error);
    };

    const rejectApi = (error: unknown): void => {
      if (error instanceof HerdrLinksError) reject(error);
      else reject(new HerdrApiError(`Herdr request failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error }));
    };

    connection.setTimeout(5_000);
    connection.once("timeout", () => rejectApi(new Error("timed out")));
    connection.once("error", rejectApi);
    connection.once("connect", () => {
      try {
        if (expectedSession !== undefined && sessionFingerprint(socketPath) !== expectedSession) {
          throw new HerdrLinksError("Herdr socket changed before request; regenerate the link");
        }
        connection.write(payload);
      } catch (error) {
        rejectApi(error);
      }
    });
    connection.on("data", (chunk: Buffer) => {
      if (settled) return;
      data = Buffer.concat([data, chunk]);
      const newline = data.indexOf(0x0a);
      if (newline === -1) {
        if (data.length > maxResponseBytes) reject(new HerdrApiError("truncated, empty, or oversized Herdr response"));
        return;
      }
      if (newline + 1 > maxResponseBytes) {
        reject(new HerdrApiError("truncated, empty, or oversized Herdr response"));
        return;
      }
      settled = true;
      connection.destroy();
      try {
        resolvePromise(parseApiResponse(data.subarray(0, newline), requestId, expectedType));
      } catch (error) {
        rejectPromise(error);
      }
    });
    connection.once("end", () => {
      if (!settled) reject(new HerdrApiError("truncated, empty, or oversized Herdr response"));
    });
  });
}

export async function getSnapshot(socketPath: string): Promise<JsonObject> {
  const result = await apiRequest(socketPath, "session.snapshot", {}, "session_snapshot");
  const snapshot = result["snapshot"];
  if (!isRecord(snapshot)) throw new HerdrApiError("missing Herdr session snapshot");
  const version = snapshot["version"];
  const protocol = snapshot["protocol"];
  if (typeof version !== "string" || typeof protocol !== "number" || !SUPPORTED_RUNTIMES.has(`${version}/${protocol}`)) {
    throw new HerdrLinksError(
      `unsupported Herdr ${String(version)} protocol ${String(protocol)}; verified runtimes: ${[...SUPPORTED_RUNTIMES].join(", ")}`,
    );
  }
  for (const key of ["panes", "workspaces", "tabs", "agents"] as const) {
    const rows = snapshot[key];
    if (!Array.isArray(rows) || !rows.every(isRecord)) throw new HerdrApiError(`invalid snapshot ${key}`);
  }
  return snapshot;
}

export function liveRow(snapshot: JsonObject, collection: string, key: string, target: string): JsonObject | undefined {
  const rows = snapshot[collection];
  if (!Array.isArray(rows) || !rows.every(isRecord)) throw new HerdrApiError(`invalid snapshot ${collection}`);
  const matches = rows.filter((row) => row[key] === target);
  if (matches.length > 1) throw new HerdrApiError("ambiguous live target");
  return matches[0];
}

export function validateLiveTarget(snapshot: JsonObject, kind: string, target: string): void {
  validateTarget(kind, target);
  const collection: Record<TargetKind, string> = {
    agent: "agents",
    pane: "panes",
    workspace: "workspaces",
    tab: "tabs",
  };
  const key = kind === "agent" ? "pane_id" : `${kind}_id`;
  if (!liveRow(snapshot, collection[kind], key, target)) {
    if (kind === "agent") {
      throw new HerdrLinksError("target is not a live detected agent; use pane links for ordinary shells");
    }
    throw new HerdrLinksError("target is not live in the invoking session; refresh closed or moved IDs");
  }
}

export function clickContext(environment: Environment, url: string): JsonObject {
  const expectedEnvironment: Readonly<Record<string, string>> = {
    HERDR_PLUGIN_ID: PLUGIN_ID,
    HERDR_PLUGIN_ACTION_ID: ACTION_ID,
    HERDR_PLUGIN_LINK_HANDLER_ID: LINK_HANDLER_ID,
  };
  for (const [key, value] of Object.entries(expectedEnvironment)) {
    if (environment[key] !== value) throw new HerdrLinksError(`missing or mismatched ${key}`);
  }
  const raw = environment["HERDR_PLUGIN_CONTEXT_JSON"];
  if (!raw || Buffer.byteLength(raw, "utf8") > 128 * 1024) {
    throw new HerdrLinksError("missing or oversized HERDR_PLUGIN_CONTEXT_JSON");
  }
  let context: unknown;
  try {
    context = JSON.parse(raw);
  } catch (error) {
    throw new HerdrLinksError("invalid HERDR_PLUGIN_CONTEXT_JSON", { cause: error });
  }
  if (!isRecord(context)) throw new HerdrLinksError("invalid HERDR_PLUGIN_CONTEXT_JSON object");
  const expectedContext: Readonly<Record<string, string>> = {
    invocation_source: "link_click",
    clicked_url: url,
    link_handler_id: LINK_HANDLER_ID,
  };
  for (const [key, value] of Object.entries(expectedContext)) {
    if (context[key] !== value) throw new HerdrLinksError(`missing or mismatched click context ${key}`);
  }
  const identifiers: ReadonlyArray<readonly [string, string, TargetKind]> = [
    ["workspace_id", "HERDR_WORKSPACE_ID", "workspace"],
    ["tab_id", "HERDR_TAB_ID", "tab"],
    ["focused_pane_id", "HERDR_PANE_ID", "pane"],
  ];
  for (const [key, environmentKey, kind] of identifiers) {
    const value = context[key];
    validateTarget(kind, value);
    if (environment[environmentKey] !== value) throw new HerdrLinksError(`inconsistent click context ${key}`);
  }
  return context;
}

export async function handleNavigation(environment: Environment): Promise<JsonObject> {
  const url = environment["HERDR_PLUGIN_CLICKED_URL"] ?? "";
  const [session, kind, target] = parseNavigationUrl(url);
  const context = clickContext(environment, url);
  const socketPath = socketFromEnvironment(environment);
  // A null session means the link omitted the fingerprint and asks to skip the
  // binding check. The socket-stability check below still runs when one is present.
  if (session !== null && sessionFingerprint(socketPath) !== session) {
    throw new HerdrLinksError("link belongs to a different Herdr session or socket lifetime; regenerate it");
  }
  const snapshot = await getSnapshot(socketPath);
  if (url.startsWith("herdr://") && !CUSTOM_SCHEME_VERSIONS.has(requiredString(snapshot["version"], "invalid snapshot version"))) {
    throw new HerdrLinksError("custom navigation targets require a Herdr 0.9 line runtime; regenerate this link");
  }
  const focusedPaneId = requiredString(context["focused_pane_id"], "invalid click context focused_pane_id");
  const origin = liveRow(snapshot, "panes", "pane_id", focusedPaneId);
  if (!origin || origin["workspace_id"] !== context["workspace_id"] || origin["tab_id"] !== context["tab_id"]) {
    throw new HerdrLinksError("clicked pane context is stale or belongs to another session");
  }
  validateLiveTarget(snapshot, kind, target);
  if (session !== null && sessionFingerprint(socketPath) !== session) {
    throw new HerdrLinksError("Herdr socket changed during navigation; regenerate the link");
  }
  const [method, parameter, expectedType] = FOCUS_METHODS[kind];
  return await apiRequest(socketPath, method, { [parameter]: target }, expectedType, session ?? undefined);
}

export async function navigationMarkdown(
  kind: string,
  target: string,
  label: string | undefined,
  socketPath: string,
  compatibilityScheme = false,
): Promise<string> {
  validateTarget(kind, target);
  const visibleLabel = label ?? target;
  if (!visibleLabel || visibleLabel.length > 200 || /\p{C}/u.test(visibleLabel)) {
    throw new HerdrLinksError("label must be visible text without control characters, at most 200 characters");
  }
  const fingerprint = sessionFingerprint(socketPath);
  const snapshot = await getSnapshot(socketPath);
  validateLiveTarget(snapshot, kind, target);
  const version = compatibilityScheme
    ? "0.7.5"
    : requiredString(snapshot["version"], "invalid snapshot version");
  const url = formatNavigationUrl(kind, target, fingerprint, version);
  if (sessionFingerprint(socketPath) !== fingerprint) {
    throw new HerdrLinksError("Herdr socket changed while generating the link; retry");
  }
  const escapedLabel = visibleLabel.replace(/([\\`*_{}\[\]<>!|])/gu, "\\$1");
  return `[${escapedLabel}](${url})`;
}

export function managedSpan(text: string): readonly [number, number] | undefined {
  const beginCount = countOccurrences(text, MANAGED_BLOCK_BEGIN);
  const endCount = countOccurrences(text, MANAGED_BLOCK_END);
  if (beginCount === 0 && endCount === 0) return undefined;
  if (beginCount !== 1 || endCount !== 1) {
    throw new HerdrLinksError("partial or duplicate Herdr Links instruction markers; refusing to edit");
  }
  const start = text.indexOf(MANAGED_BLOCK_BEGIN);
  let end = text.indexOf(MANAGED_BLOCK_END) + MANAGED_BLOCK_END.length;
  if (end <= start || (start > 0 && text[start - 1] !== "\n")) {
    throw new HerdrLinksError("invalid Herdr Links instruction marker boundaries");
  }
  if (end < text.length && text[end] !== "\n") {
    throw new HerdrLinksError("invalid Herdr Links instruction end boundary");
  }
  if (end < text.length) end += 1;
  return [start, end];
}

export function instructionContent(path: string): string {
  const metadata = lstatOrUndefined(path);
  if (metadata?.isSymbolicLink()) throw new HerdrLinksError("refusing to replace a symlinked AGENTS.md");
  return metadata ? readUtf8(path) : "";
}

export function writeInstructions(path: string, original: string, updated: string): InstructionChange {
  if (original === updated) return { changed: false };
  mkdirSync(dirname(path), { recursive: true });
  const metadata = lstatOrUndefined(path);
  let backup: string | undefined;
  const originalBytes = Buffer.from(original, "utf8");
  const mode = metadata ? statSync(path).mode & 0o7777 : 0o644;

  if (metadata) {
    backup = `${path}.herdr-links.bak`;
    const initialBackup = lstatOrUndefined(backup);
    if (initialBackup?.isSymbolicLink()) throw new HerdrLinksError("refusing a symlinked instruction backup");
    if (initialBackup && !readFileSync(backup).equals(originalBytes)) {
      const digest = createHash("sha256").update(originalBytes).digest("hex").slice(0, 16);
      backup = `${backup}.${digest}`;
    }
    const selectedBackup = lstatOrUndefined(backup);
    if (selectedBackup?.isSymbolicLink()) throw new HerdrLinksError("refusing a symlinked instruction backup");
    if (!selectedBackup) {
      writeFileSync(backup, originalBytes, { flag: "wx", mode });
      chmodSync(backup, mode);
    } else if (!readFileSync(backup).equals(originalBytes)) {
      throw new HerdrLinksError("instruction backup differs from expected contents");
    }
  }

  const temporary = join(dirname(path), `.herdr-links-${process.pid}-${randomUUID()}`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", mode);
    writeFileSync(descriptor, updated, "utf8");
    fsyncSync(descriptor);
    fchmodSync(descriptor, mode);
    closeSync(descriptor);
    descriptor = undefined;
    if (instructionContent(path) !== original) {
      throw new HerdrLinksError("AGENTS.md changed concurrently; refusing to overwrite it");
    }
    renameSync(temporary, path);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  return backup ? { changed: true, backup } : { changed: true };
}

function installInstructionEdit(path: string, snippet: string, pluginRoot: string): InstructionEdit {
  const original = instructionContent(path);
  const span = managedSpan(original);
  const content = readUtf8(snippet).replaceAll("@PLUGIN_ROOT@", pluginRoot).trim();
  const block = `${MANAGED_BLOCK_BEGIN}\n\n${content}\n\n${MANAGED_BLOCK_END}\n`;
  let updated: string;
  if (span) updated = original.slice(0, span[0]) + block + original.slice(span[1]);
  else if (original && !original.endsWith("\n")) updated = block + original;
  else updated = original + block;
  return { change: writeInstructions(path, original, updated), original, updated };
}

function uninstallInstructionEdit(path: string): InstructionEdit {
  const original = instructionContent(path);
  const span = managedSpan(original);
  const updated = span ? original.slice(0, span[0]) + original.slice(span[1]) : original;
  return { change: writeInstructions(path, original, updated), original, updated };
}

export function installInstructions(path: string, snippet: string, pluginRoot: string): InstructionChange {
  return installInstructionEdit(path, snippet, pluginRoot).change;
}

export function uninstallInstructions(path: string): InstructionChange {
  return uninstallInstructionEdit(path).change;
}

const PI_CONTEXT_FILENAMES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"] as const;

function piAgentDirectory(environment: Environment): string {
  const home = environment["HOME"] || homedir();
  const configured = environment["PI_CODING_AGENT_DIR"];
  if (!configured) return join(home, ".pi", "agent");
  if (configured === "~") return home;
  if (configured.startsWith("~/")) return join(home, configured.slice(2));
  if (!isAbsolute(configured)) throw new HerdrLinksError("PI_CODING_AGENT_DIR must be absolute or start with ~/");
  return configured;
}

function instructionCandidates(environment: Environment): readonly string[] {
  const directory = piAgentDirectory(environment);
  return PI_CONTEXT_FILENAMES.map((filename) => join(directory, filename));
}

// Claude Code loads one user-level memory file into every session, so the block
// goes there and applies to every project. The config directory is relocatable.
export function claudeCodeMemoryFile(environment: Environment): string {
  const home = environment["HOME"] || homedir();
  const configured = environment["CLAUDE_CONFIG_DIR"];
  const directory = configured && isAbsolute(configured) ? configured : join(home, ".claude");
  return join(directory, "CLAUDE.md");
}

export const INSTRUCTION_AGENTS = ["claude-code", "pi"] as const;
export type InstructionAgent = (typeof INSTRUCTION_AGENTS)[number];

export function instructionFileFor(agent: string, environment: Environment): string {
  if (agent === "claude-code") return claudeCodeMemoryFile(environment);
  if (agent === "pi") return activeInstructionFile(environment, existingInstructionCandidates(environment));
  throw new HerdrLinksError(`unsupported agent ${JSON.stringify(agent)}; use one of: ${INSTRUCTION_AGENTS.join(", ")}`);
}

function existingInstructionCandidates(environment: Environment): readonly string[] {
  const seen = new Set<string>();
  return instructionCandidates(environment).filter((path) => {
    let metadata: ReturnType<typeof statSync>;
    try {
      metadata = statSync(path);
    } catch {
      return false;
    }
    if (!metadata.isFile()) return false;
    const identity = `${metadata.dev}:${metadata.ino}`;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

function managedInstructionCandidates(paths: readonly string[]): readonly string[] {
  return paths.filter((path) => {
    if (lstatOrUndefined(path)?.isSymbolicLink()) return false;
    return managedSpan(instructionContent(path)) !== undefined;
  });
}

function activeInstructionFile(environment: Environment, existing: readonly string[]): string {
  const candidates = instructionCandidates(environment);
  return existing[0] ?? requiredString(candidates[1], "missing AGENTS.md path");
}

export function setupInstructionFile(environment: Environment): string {
  const existing = existingInstructionCandidates(environment);
  const active = activeInstructionFile(environment, existing);
  const managed = managedInstructionCandidates(existing);
  if (managed.length > 1) throw new HerdrLinksError("Herdr Links instructions exist in multiple Pi context files");
  if (managed[0] !== undefined && managed[0] !== active) {
    throw new HerdrLinksError(`Herdr Links instructions are shadowed by ${active}; run cleanup before setup`);
  }
  return active;
}

export function cleanupInstructionFile(environment: Environment): string {
  const existing = existingInstructionCandidates(environment);
  const managed = managedInstructionCandidates(existing);
  if (managed.length > 1) throw new HerdrLinksError("Herdr Links instructions exist in multiple Pi context files");
  return managed[0] ?? activeInstructionFile(environment, existing);
}

export function cleanup(agentFile: string): InstructionChange {
  return uninstallInstructions(agentFile);
}

export const defaultCliRunner: CliRunner = (binary, arguments_) => {
  const result = spawnSync(binary, arguments_, {
    shell: false,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const cliResult: CliResult = {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
  if (result.error) cliResult.error = result.error;
  return cliResult;
};

export function pluginRegistryPath(environment: Environment): string {
  const xdgConfigHome = environment["XDG_CONFIG_HOME"];
  if (xdgConfigHome) {
    if (!isAbsolute(xdgConfigHome)) throw new HerdrLinksError("XDG_CONFIG_HOME must be absolute");
    return join(xdgConfigHome, "herdr", "plugins.json");
  }
  const home = environment["HOME"];
  if (!home || !isAbsolute(home)) throw new HerdrLinksError("cannot locate the Herdr plugin registry from HOME");
  return join(home, ".config", "herdr", "plugins.json");
}

export function readStoredPlugins(environment: Environment): JsonObject[] {
  const path = pluginRegistryPath(environment);
  const metadata = lstatOrUndefined(path);
  if (!metadata) return [];
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new HerdrLinksError("Herdr plugin registry must be a regular file, not a symlink");
  }
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new HerdrLinksError("Herdr plugin registry is not owned by the current user");
  }
  if (metadata.size > MAX_RESPONSE_BYTES) throw new HerdrLinksError("Herdr plugin registry is too large");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readUtf8(path));
  } catch (error) {
    throw new HerdrLinksError("invalid Herdr plugin registry", { cause: error });
  }
  if (!Array.isArray(parsed) || !parsed.every(isRecord)) {
    throw new HerdrLinksError("invalid Herdr plugin registry");
  }
  return parsed;
}

function resolveInstallerRuntime(options: InstallerRuntime): Required<InstallerRuntime> {
  return {
    runner: options.runner ?? defaultCliRunner,
    readStoredPlugins: options.readStoredPlugins ?? (() => readStoredPlugins(process.env)),
  };
}

export function runCli(binary: string, arguments_: readonly string[], runner: CliRunner = defaultCliRunner): string {
  let completed: CliResult;
  try {
    completed = runner(binary, arguments_);
  } catch (error) {
    throw new HerdrLinksError(`Herdr CLI failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  if (completed.error) {
    throw new HerdrLinksError(`Herdr CLI failed: ${completed.error.message}`, { cause: completed.error });
  }
  if (completed.status !== 0) {
    throw new HerdrLinksError(`Herdr CLI exited ${String(completed.status)}: ${completed.stderr.trim().slice(0, 500)}`);
  }
  return completed.stdout;
}

export function installedPlugins(binary: string, runner: CliRunner = defaultCliRunner): JsonObject[] {
  const output = runCli(binary, ["plugin", "list", "--json"], runner);
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch (error) {
    throw new HerdrLinksError("invalid Herdr plugin list response", { cause: error });
  }
  if (!isRecord(parsed) || !isRecord(parsed["result"]) || !Array.isArray(parsed["result"]["plugins"])) {
    throw new HerdrLinksError("invalid Herdr plugin list response");
  }
  const plugins = parsed["result"]["plugins"];
  if (!plugins.every(isRecord)) throw new HerdrLinksError("invalid Herdr plugin list response");
  return plugins;
}

function pluginFromList(plugins: readonly JsonObject[], pluginId: string): JsonObject | undefined {
  const matches = plugins.filter((plugin) => plugin["plugin_id"] === pluginId);
  if (matches.length > 1) throw new HerdrLinksError("invalid Herdr plugin list response");
  return matches[0];
}

export function installedPlugin(
  binary: string,
  runner: CliRunner = defaultCliRunner,
  pluginId = PLUGIN_ID,
): JsonObject | undefined {
  return pluginFromList(installedPlugins(binary, runner), pluginId);
}

function pluginRootMatches(plugin: JsonObject, pluginRoot: string): boolean {
  return typeof plugin["plugin_root"] === "string" && canonicalPath(plugin["plugin_root"]) === canonicalPath(pluginRoot);
}

function pluginSourceKind(plugin: JsonObject): "local" | "github" {
  const source = plugin["source"];
  if (!isRecord(source) || (source["kind"] !== "local" && source["kind"] !== "github")) {
    throw new HerdrLinksError("invalid Herdr plugin source");
  }
  return source["kind"];
}

interface RegistrationState {
  legacy: JsonObject | undefined;
  current: JsonObject | undefined;
}

function registrationState(plugins: readonly JsonObject[]): RegistrationState {
  return {
    legacy: pluginFromList(plugins, LEGACY_PLUGIN_ID),
    current: pluginFromList(plugins, PLUGIN_ID),
  };
}

function assertNoStoredLegacy(state: RegistrationState): void {
  if (state.legacy) {
    throw new HerdrLinksError(
      `legacy stored plugin ${LEGACY_PLUGIN_ID} is still registered; run \`herdr-links migrate\` before continuing`,
    );
  }
}

function verifyStoredAndProjectedPlugin(
  stored: JsonObject | undefined,
  projected: JsonObject | undefined,
  pluginRoot: string,
  requireHealthy: boolean,
  allowManifestRename = false,
): JsonObject {
  if (!stored || !projected) throw new HerdrLinksError("stored and live Herdr plugin registrations disagree");
  if (!pluginRootMatches(stored, pluginRoot) || !pluginRootMatches(projected, pluginRoot)) {
    throw new HerdrLinksError("plugin ID belongs to another checkout");
  }
  const renamed = stored["plugin_id"] === LEGACY_PLUGIN_ID && projected["plugin_id"] === PLUGIN_ID;
  if ((!allowManifestRename || !renamed) && stored["plugin_id"] !== projected["plugin_id"]) {
    throw new HerdrLinksError("stored and live Herdr plugin registrations disagree");
  }
  if (pluginSourceKind(stored) !== pluginSourceKind(projected) || stored["enabled"] !== projected["enabled"]) {
    throw new HerdrLinksError("stored and live Herdr plugin registrations disagree");
  }
  return requireHealthy ? verifyPlugin(projected, pluginRoot) : projected;
}

function sameStoredRegistration(left: JsonObject | undefined, right: JsonObject | undefined): boolean {
  if (!left || !right) return left === right;
  return (
    left["plugin_id"] === right["plugin_id"] &&
    left["enabled"] === right["enabled"] &&
    pluginRootMatches(left, requiredString(right["plugin_root"], "invalid stored plugin root")) &&
    pluginSourceKind(left) === pluginSourceKind(right)
  );
}

function validateHerdrCli(binary: string, runner: CliRunner): void {
  const version = runCli(binary, ["--version"], runner).trim();
  if (!SUPPORTED_CLI_VERSIONS.has(version)) {
    throw new HerdrLinksError(`unsupported CLI ${version}; verified CLIs: ${[...SUPPORTED_CLI_VERSIONS].join(", ")}`);
  }
}

function assertNoLegacyPlugin(plugins: readonly JsonObject[]): void {
  if (pluginFromList(plugins, LEGACY_PLUGIN_ID)) {
    throw new HerdrLinksError(
      `legacy plugin ${LEGACY_PLUGIN_ID} is still registered; uninstall it before installing or setting up ${PLUGIN_ID}`,
    );
  }
}

function verifyPlugin(plugin: JsonObject | undefined, pluginRoot: string): JsonObject {
  if (!plugin || plugin["enabled"] !== true || !pluginRootMatches(plugin, pluginRoot) || hasWarnings(plugin)) {
    throw new HerdrLinksError("installation verification failed");
  }
  pluginSourceKind(plugin);
  return plugin;
}

export function restoreRegistration(
  previous: JsonObject | undefined,
  pluginRoot: string,
  binary: string,
  runner: CliRunner,
): void {
  const current = installedPlugin(binary, runner);
  if (current && !pluginRootMatches(current, pluginRoot)) {
    throw new HerdrLinksError("unexpected plugin root; refusing to touch another checkout during rollback");
  }
  if (!previous) {
    if (current) {
      runCli(binary, ["plugin", "unlink", PLUGIN_ID], runner);
      if (installedPlugin(binary, runner)) throw new HerdrLinksError("new plugin registration remains after rollback");
    }
    return;
  }
  const enabled = previous["enabled"] !== false;
  if (!current) {
    runCli(binary, ["plugin", "link", pluginRoot, enabled ? "--enabled" : "--disabled"], runner);
  } else if (current["enabled"] === enabled) {
    return;
  } else {
    runCli(binary, ["plugin", enabled ? "enable" : "disable", PLUGIN_ID], runner);
  }
  const restored = installedPlugin(binary, runner);
  if (!restored || restored["enabled"] !== enabled || !pluginRootMatches(restored, pluginRoot)) {
    throw new HerdrLinksError("previous plugin registration could not be restored");
  }
}

export function rollbackChanges(
  previous: JsonObject | undefined,
  pluginRoot: string,
  binary: string,
  runner: CliRunner,
  agentFile: string,
  edited: string,
  original: string,
): string {
  const failures: string[] = [];
  try {
    restoreRegistration(previous, pluginRoot, binary, runner);
  } catch (error) {
    failures.push(`plugin rollback: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    if (edited !== original) writeInstructions(agentFile, edited, original);
  } catch (error) {
    failures.push(`instruction rollback: ${error instanceof Error ? error.message : String(error)}`);
  }
  return failures.length > 0
    ? `; rollback incomplete: ${failures.join("; ")}`
    : "; registration/instruction rollback completed";
}

function hasWarnings(plugin: JsonObject): boolean {
  const warnings = plugin["warnings"];
  return Array.isArray(warnings) ? warnings.length > 0 : Boolean(warnings);
}

export function migrateLegacyRegistration(
  pluginRoot: string,
  binary: string,
  options: InstallerRuntime = {},
): MigrationReceipt {
  const runtime = resolveInstallerRuntime(options);
  validateHerdrCli(binary, runtime.runner);
  const storedBefore = registrationState(runtime.readStoredPlugins());
  if (storedBefore.legacy && storedBefore.current) {
    throw new HerdrLinksError("legacy and current stored plugin registrations both exist; refusing an ambiguous migration");
  }
  const storedCandidate = storedBefore.current ?? storedBefore.legacy;
  if (!storedCandidate) throw new HerdrLinksError(`no ${LEGACY_PLUGIN_ID} or ${PLUGIN_ID} registration is installed`);
  if (!pluginRootMatches(storedCandidate, pluginRoot)) {
    throw new HerdrLinksError("plugin ID belongs to another checkout; refusing to migrate it");
  }
  if (pluginSourceKind(storedCandidate) === "github") {
    throw new HerdrLinksError("GitHub-managed plugin registrations must not be migrated as local registrations");
  }

  const projectedBefore = registrationState(installedPlugins(binary, runtime.runner));
  if (projectedBefore.legacy && projectedBefore.current) {
    throw new HerdrLinksError("legacy and current live plugin registrations both exist; refusing an ambiguous migration");
  }
  const projectedCandidate = projectedBefore.current ?? projectedBefore.legacy;
  verifyStoredAndProjectedPlugin(
    storedCandidate,
    projectedCandidate,
    pluginRoot,
    false,
    storedBefore.legacy !== undefined,
  );

  if (storedBefore.current) {
    if (storedBefore.current["enabled"] === true) {
      return { changed: false, plugin: verifyPlugin(projectedCandidate, pluginRoot) };
    }
    runCli(binary, ["plugin", "enable", PLUGIN_ID], runtime.runner);
    const storedAfterEnable = registrationState(runtime.readStoredPlugins());
    assertNoStoredLegacy(storedAfterEnable);
    const projectedAfterEnablePlugins = installedPlugins(binary, runtime.runner);
    assertNoLegacyPlugin(projectedAfterEnablePlugins);
    const projectedAfterEnable = registrationState(projectedAfterEnablePlugins);
    return {
      changed: true,
      plugin: verifyStoredAndProjectedPlugin(
        storedAfterEnable.current,
        projectedAfterEnable.current,
        pluginRoot,
        true,
      ),
    };
  }

  const storedBeforeMutation = registrationState(runtime.readStoredPlugins());
  if (
    storedBeforeMutation.current ||
    !sameStoredRegistration(storedBefore.legacy, storedBeforeMutation.legacy)
  ) {
    throw new HerdrLinksError("Herdr plugin registry changed during migration; refusing to unlink");
  }
  runCli(binary, ["plugin", "unlink", LEGACY_PLUGIN_ID], runtime.runner);
  const storedAfterUnlink = registrationState(runtime.readStoredPlugins());
  if (storedAfterUnlink.legacy || storedAfterUnlink.current) {
    throw new HerdrLinksError("unexpected stored plugin registration after legacy unlink");
  }
  const projectedAfterUnlink = registrationState(installedPlugins(binary, runtime.runner));
  if (projectedAfterUnlink.legacy || projectedAfterUnlink.current) {
    throw new HerdrLinksError("legacy plugin registration remains live after unlink");
  }

  try {
    runCli(binary, ["plugin", "link", pluginRoot, "--enabled"], runtime.runner);
  } catch (error) {
    if (!(error instanceof HerdrLinksError)) throw error;
    throw new HerdrLinksError(
      `${error.message}; legacy registration was removed but ${PLUGIN_ID} was not linked—run \`herdr plugin link ${pluginRoot} --enabled\``,
      { cause: error },
    );
  }
  const storedAfterLink = registrationState(runtime.readStoredPlugins());
  assertNoStoredLegacy(storedAfterLink);
  if (!storedAfterLink.current || pluginSourceKind(storedAfterLink.current) !== "local") {
    throw new HerdrLinksError("migration created an unexpected plugin source");
  }
  const projectedAfterLinkPlugins = installedPlugins(binary, runtime.runner);
  assertNoLegacyPlugin(projectedAfterLinkPlugins);
  const projectedAfterLink = registrationState(projectedAfterLinkPlugins);
  return {
    changed: true,
    plugin: verifyStoredAndProjectedPlugin(storedAfterLink.current, projectedAfterLink.current, pluginRoot, true),
  };
}

export function setup(
  pluginRoot: string,
  agentFile: string,
  snippetFile: string,
  binary: string,
  options: InstallerRuntime = {},
): InstallReceipt {
  const runtime = resolveInstallerRuntime(options);
  validateHerdrCli(binary, runtime.runner);
  const storedBefore = registrationState(runtime.readStoredPlugins());
  assertNoStoredLegacy(storedBefore);
  const projectedBeforePlugins = installedPlugins(binary, runtime.runner);
  assertNoLegacyPlugin(projectedBeforePlugins);
  const projectedBefore = registrationState(projectedBeforePlugins);
  verifyStoredAndProjectedPlugin(storedBefore.current, projectedBefore.current, pluginRoot, true);
  const edit = installInstructionEdit(agentFile, snippetFile, pluginRoot);
  try {
    const storedAfter = registrationState(runtime.readStoredPlugins());
    assertNoStoredLegacy(storedAfter);
    const projectedAfterPlugins = installedPlugins(binary, runtime.runner);
    assertNoLegacyPlugin(projectedAfterPlugins);
    const projectedAfter = registrationState(projectedAfterPlugins);
    return {
      instructions: edit.change,
      plugin: verifyStoredAndProjectedPlugin(storedAfter.current, projectedAfter.current, pluginRoot, true),
    };
  } catch (error) {
    if (!(error instanceof HerdrLinksError)) throw error;
    let rollback = "";
    try {
      if (edit.updated !== edit.original) writeInstructions(agentFile, edit.updated, edit.original);
      rollback = "; instruction rollback completed";
    } catch (rollbackError) {
      rollback = `; rollback incomplete: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`;
    }
    throw new HerdrLinksError(error.message + rollback, { cause: error });
  }
}

export function install(
  pluginRoot: string,
  agentFile: string,
  snippetFile: string,
  binary: string,
  options: InstallerRuntime = {},
): InstallReceipt {
  const runtime = resolveInstallerRuntime(options);
  validateHerdrCli(binary, runtime.runner);
  const storedBefore = registrationState(runtime.readStoredPlugins());
  assertNoStoredLegacy(storedBefore);
  const projectedBeforePlugins = installedPlugins(binary, runtime.runner);
  assertNoLegacyPlugin(projectedBeforePlugins);
  const projectedBefore = registrationState(projectedBeforePlugins);
  let previousPlugin: JsonObject | undefined;
  if (storedBefore.current) {
    previousPlugin = verifyStoredAndProjectedPlugin(
      storedBefore.current,
      projectedBefore.current,
      pluginRoot,
      false,
    );
  } else if (projectedBefore.current) {
    throw new HerdrLinksError("stored and live Herdr plugin registrations disagree");
  }
  if (storedBefore.current && pluginSourceKind(storedBefore.current) === "github") {
    return setup(pluginRoot, agentFile, snippetFile, binary, options);
  }

  const edit = installInstructionEdit(agentFile, snippetFile, pluginRoot);
  try {
    runCli(binary, ["plugin", "link", pluginRoot, "--enabled"], runtime.runner);
    const storedAfter = registrationState(runtime.readStoredPlugins());
    assertNoStoredLegacy(storedAfter);
    if (!storedAfter.current || pluginSourceKind(storedAfter.current) !== "local") {
      throw new HerdrLinksError("local installation created an unexpected plugin source");
    }
    const projectedAfterPlugins = installedPlugins(binary, runtime.runner);
    assertNoLegacyPlugin(projectedAfterPlugins);
    const projectedAfter = registrationState(projectedAfterPlugins);
    const plugin = verifyStoredAndProjectedPlugin(storedAfter.current, projectedAfter.current, pluginRoot, true);
    return { instructions: edit.change, plugin };
  } catch (error) {
    if (!(error instanceof HerdrLinksError)) throw error;
    const rollback = rollbackChanges(
      previousPlugin,
      pluginRoot,
      binary,
      runtime.runner,
      agentFile,
      edit.updated,
      edit.original,
    );
    throw new HerdrLinksError(error.message + rollback, { cause: error });
  }
}

export function uninstall(
  agentFile: string,
  binary: string,
  options: InstallerRuntime = {},
  pluginRoot = ROOT,
): UninstallReceipt {
  const runtime = resolveInstallerRuntime(options);
  validateHerdrCli(binary, runtime.runner);
  const storedBefore = registrationState(runtime.readStoredPlugins());
  assertNoStoredLegacy(storedBefore);
  const projectedBeforePlugins = installedPlugins(binary, runtime.runner);
  assertNoLegacyPlugin(projectedBeforePlugins);
  const projectedBefore = registrationState(projectedBeforePlugins);
  let plugin: JsonObject | undefined;
  if (storedBefore.current) {
    plugin = verifyStoredAndProjectedPlugin(storedBefore.current, projectedBefore.current, pluginRoot, false);
    if (pluginSourceKind(storedBefore.current) === "github") {
      throw new HerdrLinksError(
        "GitHub-managed plugin registration must be removed with `herdr plugin uninstall`; run cleanup first",
      );
    }
  } else if (projectedBefore.current) {
    throw new HerdrLinksError("stored and live Herdr plugin registrations disagree");
  }

  const edit = uninstallInstructionEdit(agentFile);
  if (plugin) {
    try {
      runCli(binary, ["plugin", "unlink", PLUGIN_ID], runtime.runner);
      const storedAfter = registrationState(runtime.readStoredPlugins());
      if (storedAfter.legacy || storedAfter.current) {
        throw new HerdrLinksError("plugin unlink did not remove stored registration");
      }
      const projectedAfter = registrationState(installedPlugins(binary, runtime.runner));
      if (projectedAfter.legacy || projectedAfter.current) {
        throw new HerdrLinksError("plugin unlink did not remove live registration");
      }
    } catch (error) {
      if (!(error instanceof HerdrLinksError)) throw error;
      const rollback = rollbackChanges(
        plugin,
        pluginRoot,
        binary,
        runtime.runner,
        agentFile,
        edit.updated,
        edit.original,
      );
      throw new HerdrLinksError(error.message + rollback, { cause: error });
    }
  }
  return { instructions: edit.change, pluginWasLinked: plugin !== undefined };
}

export function findExecutable(name: string, environment: Environment): string | undefined {
  const pathValue = environment["PATH"];
  if (!pathValue) return undefined;
  for (const directory of pathValue.split(":").filter(Boolean)) {
    const candidate = join(directory, name);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return realpathSync(candidate);
    } catch {
      continue;
    }
  }
  return undefined;
}
