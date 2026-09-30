import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ACTION_ID,
  HerdrApiError,
  HerdrLinksError,
  JsonObject,
  LINK_HANDLER_ID,
  PLUGIN_ID,
  ROOT,
  apiRequest,
  formatNavigationUrl,
  getSnapshot,
  handleNavigation,
  navigationMarkdown,
  navigationUrl,
  parseNavigationUrl,
  sessionFingerprint,
  validateLiveTarget,
} from "../src/core.js";

const SNAPSHOT: JsonObject = {
  version: "0.9.0",
  protocol: 22,
  focused_workspace_id: "wA",
  focused_tab_id: "wA:tB",
  focused_pane_id: "wA:pC",
  workspaces: [{ workspace_id: "wA" }, { workspace_id: "wD" }],
  tabs: [{ tab_id: "wA:tB", workspace_id: "wA" }],
  panes: [
    { pane_id: "wA:pC", workspace_id: "wA", tab_id: "wA:tB", agent: "pi" },
    { pane_id: "wA:pD", workspace_id: "wA", tab_id: "wA:tB", agent: null },
  ],
  agents: [{ pane_id: "wA:pC", workspace_id: "wA", tab_id: "wA:tB", agent: "pi", name: "builder" }],
};

type Responder = (request: JsonObject) => JsonObject | Buffer;

class FakeHerdrServer {
  readonly requests: JsonObject[] = [];
  readonly socketPath: string;
  private readonly server: Server;
  private readonly expectedRequests: number;
  private readonly responder: Responder;
  private readonly reachedExpected: Promise<void>;
  private readonly closed: Promise<void>;
  private resolveReachedExpected!: () => void;
  private rejectReachedExpected!: (error: Error) => void;
  private resolveClosed!: () => void;
  private rejectClosed!: (error: Error) => void;

  private constructor(socketPath: string, responder: Responder, expectedRequests: number) {
    this.socketPath = socketPath;
    this.responder = responder;
    this.expectedRequests = expectedRequests;
    this.reachedExpected = new Promise<void>((resolve, reject) => {
      this.resolveReachedExpected = resolve;
      this.rejectReachedExpected = reject;
    });
    this.closed = new Promise<void>((resolve, reject) => {
      this.resolveClosed = resolve;
      this.rejectClosed = reject;
    });
    this.server = createServer((connection) => {
      let input = Buffer.alloc(0);
      connection.on("data", (chunk: Buffer) => {
        input = Buffer.concat([input, chunk]);
        const newline = input.indexOf(0x0a);
        if (newline === -1) return;
        try {
          const request = JSON.parse(input.subarray(0, newline).toString("utf8")) as JsonObject;
          this.requests.push(request);
          const response = this.responder(request);
          connection.end(Buffer.isBuffer(response) ? response : Buffer.from(`${JSON.stringify(response)}\n`));
          if (this.requests.length === this.expectedRequests) this.resolveReachedExpected();
        } catch (error) {
          connection.destroy();
          this.server.close();
          this.rejectReachedExpected(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
    if (expectedRequests === 0) this.resolveReachedExpected();
    this.server.once("close", () => this.resolveClosed());
    this.server.once("error", (error) => {
      this.rejectReachedExpected(error);
      this.rejectClosed(error);
    });
  }

  static async start(socketPath: string, responder: Responder, expectedRequests: number): Promise<FakeHerdrServer> {
    const fake = new FakeHerdrServer(socketPath, responder, expectedRequests);
    await new Promise<void>((resolve, reject) => {
      fake.server.once("listening", resolve);
      fake.server.once("error", reject);
      fake.server.listen(socketPath);
    });
    return fake;
  }

  async finish(): Promise<void> {
    const timeout = (): Promise<never> =>
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error("fake Herdr server did not finish")), 3_000).unref();
      });
    await Promise.race([this.reachedExpected, timeout()]);
    assert.equal(this.requests.length, this.expectedRequests);
    this.server.close();
    await Promise.race([this.closed, timeout()]);
  }

  async stop(): Promise<void> {
    await this.finish();
  }
}

function successResponder(request: JsonObject): JsonObject {
  const method = request["method"];
  const type =
    method === "session.snapshot"
      ? "session_snapshot"
      : ({
          "workspace.focus": "workspace_info",
          "tab.focus": "tab_info",
          "pane.focus": "pane_info",
        } as Record<string, string>)[String(method)];
  const result: JsonObject = { type };
  if (method === "session.snapshot") result["snapshot"] = SNAPSHOT;
  return { id: request["id"], result };
}

function invocationEnvironment(socketPath: string, url: string): Record<string, string> {
  const context = {
    invocation_source: "link_click",
    clicked_url: url,
    link_handler_id: LINK_HANDLER_ID,
    workspace_id: "wA",
    tab_id: "wA:tB",
    focused_pane_id: "wA:pC",
  };
  return {
    HERDR_ENV: "1",
    HERDR_SOCKET_PATH: socketPath,
    HERDR_PLUGIN_ID: PLUGIN_ID,
    HERDR_PLUGIN_ACTION_ID: ACTION_ID,
    HERDR_PLUGIN_LINK_HANDLER_ID: LINK_HANDLER_ID,
    HERDR_PLUGIN_CLICKED_URL: url,
    HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify(context),
    HERDR_WORKSPACE_ID: "wA",
    HERDR_TAB_ID: "wA:tB",
    HERDR_PANE_ID: "wA:pC",
  };
}

function temporaryDirectory(): string {
  return mkdtempSync(join(tmpdir(), "herdr-links-test-"));
}

test("routes every supported live target to the exact API method", async () => {
  const cases: ReadonlyArray<readonly [string, string, string, JsonObject]> = [
    ["agent", "wA:pC", "pane.focus", { pane_id: "wA:pC" }],
    ["workspace", "wD", "workspace.focus", { workspace_id: "wD" }],
    ["tab", "wA:tB", "tab.focus", { tab_id: "wA:tB" }],
    ["pane", "wA:pD", "pane.focus", { pane_id: "wA:pD" }],
  ];
  for (const [kind, target, method, params] of cases) {
    const directory = temporaryDirectory();
    try {
      const path = join(directory, "herdr.sock");
      const server = await FakeHerdrServer.start(path, successResponder, 2);
      const url = navigationUrl(kind, target, path);
      const result = await handleNavigation(invocationEnvironment(path, url));
      await server.finish();
      assert.equal(result["type"], method.replace(".focus", "_info"));
      assert.equal(server.requests[0]?.["method"], "session.snapshot");
      assert.equal(server.requests[1]?.["method"], method);
      assert.deepEqual(server.requests[1]?.["params"], params);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("plain shells are rejected as agents and accepted as panes", () => {
  validateLiveTarget(SNAPSHOT, "pane", "wA:pD");
  assert.throws(() => validateLiveTarget(SNAPSHOT, "agent", "wA:pD"), /detected agent/u);
});

test("modern and legacy URL schemes parse and reject malformed fingerprints", async () => {
  const directory = temporaryDirectory();
  const path = join(directory, "herdr.sock");
  const server = await FakeHerdrServer.start(path, successResponder, 0);
  try {
    const modern = navigationUrl("pane", "wA:pD", path);
    const legacy = navigationUrl("pane", "wA:pD", path, "0.7.5");
    const patchRelease = formatNavigationUrl("pane", "wA:pD", "0".repeat(64), "0.9.1");
    assert.match(modern, /^herdr:\/\/navigation\/v1\//u);
    assert.match(legacy, /^https:\/\/herdr\.invalid\/v1\//u);
    assert.match(patchRelease, /^herdr:\/\/navigation\/v1\//u);
    assert.deepEqual(parseNavigationUrl(modern).slice(1), ["pane", "wA:pD"]);
    assert.deepEqual(parseNavigationUrl(legacy).slice(1), ["pane", "wA:pD"]);
    assert.throws(() => formatNavigationUrl("pane", "wA:pD", "bad", "0.9.0"), /fingerprint/u);
  } finally {
    await server.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("TypeScript and Python derive identical socket fingerprints for Unicode paths", async () => {
  const directory = temporaryDirectory();
  const unicodeDirectory = join(directory, "tést-😀");
  mkdirSync(unicodeDirectory);
  const path = join(unicodeDirectory, "herdr.sock");
  const server = await FakeHerdrServer.start(path, successResponder, 0);
  try {
    const python = execFileSync(
      "python3",
      [
        "-c",
        "import pathlib,sys;sys.path.insert(0,sys.argv[1]);import herdr_links;print(herdr_links.session_fingerprint(pathlib.Path(sys.argv[2])))",
        join(ROOT, "reference", "python"),
        path,
      ],
      { encoding: "utf8" },
    ).trim();
    assert.equal(sessionFingerprint(path), python);
  } finally {
    await server.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("custom links are rejected on the legacy runtime before focus", async () => {
  const directory = temporaryDirectory();
  try {
    const path = join(directory, "herdr.sock");
    const legacy = { ...SNAPSHOT, version: "0.7.5", protocol: 18 };
    const server = await FakeHerdrServer.start(
      path,
      (request) => ({ id: request["id"], result: { type: "session_snapshot", snapshot: legacy } }),
      1,
    );
    const url = navigationUrl("pane", "wA:pD", path);
    await assert.rejects(handleNavigation(invocationEnvironment(path, url)), /require a Herdr 0\.9 line runtime/u);
    await server.finish();
    assert.deepEqual(server.requests.map((request) => request["method"]), ["session.snapshot"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("legacy agent links validate membership then use pane focus", async () => {
  const directory = temporaryDirectory();
  try {
    const path = join(directory, "herdr.sock");
    const legacy = { ...SNAPSHOT, version: "0.7.5", protocol: 18 };
    const server = await FakeHerdrServer.start(
      path,
      (request) => ({
        id: request["id"],
        result:
          request["method"] === "session.snapshot"
            ? { type: "session_snapshot", snapshot: legacy }
            : { type: "pane_info" },
      }),
      2,
    );
    const url = navigationUrl("agent", "wA:pC", path, "0.7.5");
    assert.equal((await handleNavigation(invocationEnvironment(path, url)))["type"], "pane_info");
    await server.finish();
    assert.deepEqual(server.requests.map((request) => request["method"]), ["session.snapshot", "pane.focus"]);
    assert.deepEqual(server.requests[1]?.["params"], { pane_id: "wA:pC" });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("malformed and injection URLs fail closed", () => {
  const fingerprint = "0".repeat(64);
  const malformed = [
    "herdr://agent/wA:pC",
    `http://herdr.invalid/v1/${fingerprint}/agent/wA:pC`,
    `https://user@herdr.invalid/v1/${fingerprint}/agent/wA:pC`,
    `https://herdr.invalid:443/v1/${fingerprint}/agent/wA:pC`,
    `https://herdr.invalid/v1/${fingerprint}/agent/wA:pC?x=1`,
    `https://herdr.invalid/v1/${fingerprint}/agent/wA:pC#x`,
    `https://herdr.invalid/v1/${fingerprint}/pane/wA:pD%2Fetc`,
    `https://herdr.invalid/v1/${fingerprint}/pane/wA:pD;touch`,
    `https://example.com/v1/${fingerprint}/agent/wA:pC`,
    `https://herdr.invalid/v1/${fingerprint}/agent/wA:pC\n`,
    `herdr://navigation/v1/${fingerprint}/pane/wA:pD?x=1`,
    `HERDR://navigation/v1/${fingerprint}/pane/wA:pD`,
    ...[
      "/pane/wA:pC/",
      "/pane/../wA:pC",
      "/pane/wA:pC\u001b[2J",
      "/pane/term_65acd2aeca6ab13a",
      "/pane/wA:pI",
      "/pane/wA:tB",
      "/tab/wA:pC",
      "/workspace/wA:pC",
      "/agent/builder",
      "/pane/wA:pC$(id)",
      "/pane/wA:pC%00",
      "/pane/wA:pC\u0000",
    ].map((suffix) => `https://herdr.invalid/v1/${fingerprint}${suffix}`),
  ];
  for (const url of malformed) assert.throws(() => parseNavigationUrl(url), HerdrLinksError, url);
});

test("wrong sessions fail before API requests", async () => {
  const directory = temporaryDirectory();
  const path = join(directory, "herdr.sock");
  const server = await FakeHerdrServer.start(path, successResponder, 0);
  try {
    const url = `https://herdr.invalid/v1/${"0".repeat(64)}/pane/wA:pD`;
    await assert.rejects(handleNavigation(invocationEnvironment(path, url)), /different Herdr session/u);
  } finally {
    await server.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("missing and inconsistent click context fail before socket access", async () => {
  const directory = temporaryDirectory();
  const path = join(directory, "herdr.sock");
  const server = await FakeHerdrServer.start(path, successResponder, 0);
  try {
    const url = navigationUrl("pane", "wA:pD", path);
    const baseline = invocationEnvironment(path, url);
    const cases: Array<readonly [Record<string, string | undefined>, RegExp]> = [
      [{ ...baseline, HERDR_PLUGIN_ID: undefined }, /HERDR_PLUGIN_ID/u],
      [{ ...baseline, HERDR_PLUGIN_ACTION_ID: undefined }, /HERDR_PLUGIN_ACTION_ID/u],
      [{ ...baseline, HERDR_PLUGIN_LINK_HANDLER_ID: undefined }, /HERDR_PLUGIN_LINK_HANDLER_ID/u],
      [{ ...baseline, HERDR_PLUGIN_CONTEXT_JSON: undefined }, /HERDR_PLUGIN_CONTEXT_JSON/u],
      [{ ...baseline, HERDR_WORKSPACE_ID: "wD" }, /workspace_id/u],
      [{ ...baseline, HERDR_PLUGIN_CONTEXT_JSON: "[]" }, /JSON object/u],
      [{ ...baseline, HERDR_PLUGIN_CONTEXT_JSON: "not json" }, /invalid HERDR_PLUGIN_CONTEXT_JSON/u],
    ];
    const context = JSON.parse(baseline.HERDR_PLUGIN_CONTEXT_JSON ?? "{}") as JsonObject;
    const contextCases: ReadonlyArray<readonly [JsonObject, RegExp]> = [
      [{ ...context, invocation_source: "api" }, /invocation_source/u],
      [{ ...context, clicked_url: `${url}?x` }, /clicked_url/u],
      [{ ...context, link_handler_id: "other" }, /link_handler_id/u],
    ];
    for (const [changed, pattern] of contextCases) {
      cases.push([{ ...baseline, HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify(changed) }, pattern]);
    }
    for (const [environment, pattern] of cases) await assert.rejects(handleNavigation(environment), pattern);
    assert.equal(server.requests.length, 0);
  } finally {
    await server.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("socket replacement invalidates previously generated links", async () => {
  const directory = temporaryDirectory();
  try {
    const path = join(directory, "herdr.sock");
    const first = await FakeHerdrServer.start(path, successResponder, 0);
    const url = navigationUrl("pane", "wA:pD", path);
    await first.stop();
    const second = await FakeHerdrServer.start(path, successResponder, 0);
    try {
      await assert.rejects(handleNavigation(invocationEnvironment(path, url)), /different Herdr session/u);
      assert.equal(second.requests.length, 0);
    } finally {
      await second.stop();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("post-connect session checks send no focus bytes after replacement", async () => {
  const directory = temporaryDirectory();
  const path = join(directory, "herdr.sock");
  const server = createServer();
  try {
    const received = new Promise<Buffer>((resolve) => {
      server.once("connection", (connection) => {
        const chunks: Buffer[] = [];
        connection.on("data", (chunk: Buffer) => chunks.push(chunk));
        connection.once("close", () => resolve(Buffer.concat(chunks)));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
      server.listen(path);
    });
    await assert.rejects(
      apiRequest(path, "pane.focus", { pane_id: "wA:pD" }, "pane_info", "0".repeat(64)),
      /socket changed before request/u,
    );
    assert.equal((await received).length, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});

test("stale click origin does not send focus", async () => {
  const directory = temporaryDirectory();
  try {
    const path = join(directory, "herdr.sock");
    const server = await FakeHerdrServer.start(path, successResponder, 1);
    const url = navigationUrl("pane", "wA:pD", path);
    const environment = invocationEnvironment(path, url);
    const context = JSON.parse(environment.HERDR_PLUGIN_CONTEXT_JSON ?? "{}") as JsonObject;
    environment.HERDR_WORKSPACE_ID = "wD";
    environment.HERDR_PLUGIN_CONTEXT_JSON = JSON.stringify({ ...context, workspace_id: "wD" });
    await assert.rejects(handleNavigation(environment), /clicked pane context/u);
    await server.finish();
    assert.equal(server.requests.length, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("response identity, type, snapshot and row shape are validated", async () => {
  const responders: Responder[] = [
    (request) => ({ ...successResponder(request), id: "wrong" }),
    (request) => ({ id: request["id"], result: { type: "workspace_info" } }),
    (request) => ({ id: request["id"], result: { type: "session_snapshot" } }),
    (request) => ({
      id: request["id"],
      result: { type: "session_snapshot", snapshot: { ...SNAPSHOT, panes: [null] } },
    }),
  ];
  for (const responder of responders) {
    const directory = temporaryDirectory();
    try {
      const path = join(directory, "herdr.sock");
      const server = await FakeHerdrServer.start(path, responder, 1);
      await assert.rejects(getSnapshot(path), HerdrApiError);
      await server.finish();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("empty, truncated, invalid and oversized responses fail closed", async () => {
  for (const data of [Buffer.alloc(0), Buffer.from("{}"), Buffer.from("not json\n"), Buffer.from(`${"x".repeat(101)}\n`)]) {
    const directory = temporaryDirectory();
    try {
      const path = join(directory, "herdr.sock");
      const server = await FakeHerdrServer.start(path, () => data, 1);
      await assert.rejects(apiRequest(path, "session.snapshot", {}, "session_snapshot", undefined, 100), HerdrApiError);
      await server.finish();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("labels reject controls before socket access", async () => {
  for (const label of ["", "hello\nworld", "\u001b[2J", "\u009b31m", "\u202etext"]) {
    await assert.rejects(navigationMarkdown("pane", "wA:pD", label, "/missing"), /label must be/u);
  }
});

test("stale targets do not send focus", async () => {
  const directory = temporaryDirectory();
  try {
    const path = join(directory, "herdr.sock");
    const server = await FakeHerdrServer.start(path, successResponder, 1);
    const url = navigationUrl("pane", "wA:pE", path);
    await assert.rejects(handleNavigation(invocationEnvironment(path, url)), /not live/u);
    await server.finish();
    assert.deepEqual(server.requests.map((request) => request["method"]), ["session.snapshot"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("focus API failures surface", async () => {
  const directory = temporaryDirectory();
  try {
    const path = join(directory, "herdr.sock");
    const server = await FakeHerdrServer.start(
      path,
      (request) =>
        request["method"] === "session.snapshot"
          ? successResponder(request)
          : { id: request["id"], error: { code: "pane_not_found", message: "pane disappeared" } },
      2,
    );
    const url = navigationUrl("pane", "wA:pD", path);
    await assert.rejects(handleNavigation(invocationEnvironment(path, url)), /pane_not_found.*pane disappeared/u);
    await server.finish();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Markdown generation validates live targets and escapes labels", async () => {
  const directory = temporaryDirectory();
  try {
    const path = join(directory, "herdr.sock");
    const server = await FakeHerdrServer.start(path, successResponder, 1);
    const expectedUrl = navigationUrl("agent", "wA:pC", path);
    const markdown = await navigationMarkdown("agent", "wA:pC", "wA:pC — build [ready]", path);
    await server.finish();
    assert.equal(markdown, `[wA:pC — build \\[ready\\]](${expectedUrl})`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("non-sockets and unsupported runtime pairs fail", async () => {
  const directory = temporaryDirectory();
  try {
    const file = join(directory, "not-a-socket");
    writeFileSync(file, "x");
    assert.throws(() => navigationUrl("pane", "wA:pD", file), /Unix socket/u);

    for (const [version, protocol] of [
      ["0.7.5", 22],
      ["0.9.0", 18],
      ["0.8.2", 21],
      ["0.9.0", 23],
      ["0.10.0", 22],
    ] as const) {
      const path = join(directory, `herdr-${version}-${protocol}.sock`);
      const snapshot = { ...SNAPSHOT, version, protocol };
      const server = await FakeHerdrServer.start(
        path,
        (request) => ({ id: request["id"], result: { type: "session_snapshot", snapshot } }),
        1,
      );
      await assert.rejects(getSnapshot(path), HerdrLinksError);
      await server.finish();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the 0.9 line and the 0.7.5 compatibility runtime are accepted", async () => {
  const directory = temporaryDirectory();
  try {
    for (const [version, protocol] of [
      ["0.7.5", 18],
      ["0.9.0", 22],
      ["0.9.1", 22],
      ["0.9.2", 22],
      ["0.9.3", 22],
    ] as const) {
      const path = join(directory, `herdr-${version}.sock`);
      const snapshot = { ...SNAPSHOT, version, protocol };
      const server = await FakeHerdrServer.start(
        path,
        (request) => ({ id: request["id"], result: { type: "session_snapshot", snapshot } }),
        1,
      );
      assert.equal((await getSnapshot(path))["version"], version);
      await server.finish();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
