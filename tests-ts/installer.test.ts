import assert from "node:assert/strict";
import { accessSync, constants, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ACTION_ID,
  CliResult,
  CliRunner,
  HerdrLinksError,
  LEGACY_PLUGIN_ID,
  LINK_HANDLER_ID,
  MANAGED_BLOCK_BEGIN,
  PLUGIN_ID,
  ROOT,
  VERSION,
  cleanup,
  cleanupInstructionFile,
  install,
  installInstructions,
  migrateLegacyRegistration,
  parseNavigationUrl,
  pluginRegistryPath,
  readStoredPlugins,
  runCli,
  setup,
  setupInstructionFile,
  uninstall,
  uninstallInstructions,
} from "../src/core.js";
import type { InstallerRuntime, JsonObject } from "../src/core.js";

function temporaryDirectory(): string {
  return mkdtempSync(join(tmpdir(), "herdr-links-install-test-"));
}

function result(status: number, stdout = "", stderr = ""): CliResult {
  return { status, stdout, stderr };
}

function normalizedPlugins(plugins: readonly unknown[]): JsonObject[] {
  return plugins.map((plugin) => {
    if (typeof plugin !== "object" || plugin === null || Array.isArray(plugin)) {
      throw new Error("test plugin must be an object");
    }
    return { source: { kind: "local" }, ...plugin };
  });
}

function pluginList(plugins: readonly unknown[]): string {
  return JSON.stringify({ result: { plugins: normalizedPlugins(plugins) } });
}

function installerRuntime(runner: CliRunner, snapshots: readonly (readonly unknown[])[]): InstallerRuntime {
  let index = 0;
  return {
    runner,
    readStoredPlugins: () => {
      const snapshot = snapshots[Math.min(index, snapshots.length - 1)] ?? [];
      index += 1;
      return normalizedPlugins(snapshot);
    },
  };
}

test("instruction install and uninstall are idempotent and preserve unrelated bytes", () => {
  const directory = temporaryDirectory();
  try {
    const agentFile = join(directory, "AGENTS.md");
    const snippetFile = join(directory, "agent-instructions.md");
    const original = "# Existing\n\nKeep this exactly.\n";
    writeFileSync(agentFile, original);
    writeFileSync(snippetFile, "## Herdr links\n\nRun `node \"@PLUGIN_ROOT@/dist/cli.js\"`.\n");

    const first = installInstructions(agentFile, snippetFile, "/tmp/plugin");
    const installed = readFileSync(agentFile, "utf8");
    const second = installInstructions(agentFile, snippetFile, "/tmp/plugin");

    assert.equal(first.changed, true);
    assert.equal(second.changed, false);
    assert.equal(readFileSync(agentFile, "utf8"), installed);
    assert.equal(installed.split(MANAGED_BLOCK_BEGIN).length - 1, 1);
    assert.match(installed, /node "\/tmp\/plugin\/dist\/cli\.js"/u);
    assert.equal(readFileSync(join(directory, "AGENTS.md.herdr-links.bak"), "utf8"), original);

    const removed = uninstallInstructions(agentFile);
    const removedAgain = uninstallInstructions(agentFile);
    assert.equal(removed.changed, true);
    assert.equal(removedAgain.changed, false);
    assert.equal(readFileSync(agentFile, "utf8"), original);
    assert.ok(removed.backup);
    assert.equal(readFileSync(removed.backup, "utf8"), installed);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("instruction round trips preserve missing newline, CRLF and empty files", () => {
  for (const original of ["no final newline", "# Existing\r\nKeep CRLF\r\n", ""]) {
    const directory = temporaryDirectory();
    try {
      const path = join(directory, "AGENTS.md");
      const snippet = join(directory, "snippet.md");
      writeFileSync(path, original);
      writeFileSync(snippet, "instructions");
      installInstructions(path, snippet, ROOT);
      uninstallInstructions(path);
      assert.equal(readFileSync(path, "utf8"), original);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("instruction round trips and backups preserve a UTF-8 BOM byte-for-byte", () => {
  const directory = temporaryDirectory();
  try {
    const path = join(directory, "AGENTS.md");
    const snippet = join(directory, "snippet.md");
    const original = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("# Existing\n")]);
    writeFileSync(path, original);
    writeFileSync(snippet, "instructions");
    const installed = installInstructions(path, snippet, ROOT);
    assert.ok(installed.backup);
    assert.deepEqual(readFileSync(installed.backup), original);
    uninstallInstructions(path);
    assert.deepEqual(readFileSync(path), original);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("updates preserve unrelated content added after installation", () => {
  const directory = temporaryDirectory();
  try {
    const path = join(directory, "AGENTS.md");
    const snippet = join(directory, "snippet.md");
    writeFileSync(path, "before\n");
    writeFileSync(snippet, "version one");
    installInstructions(path, snippet, ROOT);
    writeFileSync(path, `${readFileSync(path, "utf8")}after\n`);
    const beforeUpdate = readFileSync(path, "utf8");
    writeFileSync(snippet, "version two");
    const update = installInstructions(path, snippet, ROOT);
    assert.ok(update.backup);
    assert.equal(readFileSync(update.backup, "utf8"), beforeUpdate);
    assert.match(readFileSync(path, "utf8"), /version two/u);
    uninstallInstructions(path);
    assert.equal(readFileSync(path, "utf8"), "before\nafter\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("symlinks and malformed marker sets fail closed", () => {
  const directory = temporaryDirectory();
  try {
    const real = join(directory, "actual.md");
    const path = join(directory, "AGENTS.md");
    const snippet = join(directory, "snippet.md");
    writeFileSync(real, "keep me\n");
    writeFileSync(snippet, "content");
    symlinkSync(real, path);
    assert.throws(() => uninstallInstructions(path), /symlink/u);
    assert.equal(readFileSync(real, "utf8"), "keep me\n");
    rmSync(path);

    const cases = [
      `text\n${MANAGED_BLOCK_BEGIN}\n`,
      "<!-- END HERDR LINKS -->\ntext",
      `${MANAGED_BLOCK_BEGIN}\na\n<!-- END HERDR LINKS -->\n${MANAGED_BLOCK_BEGIN}\nb\n<!-- END HERDR LINKS -->\n`,
    ];
    for (const content of cases) {
      writeFileSync(path, content);
      assert.throws(() => installInstructions(path, snippet, ROOT), HerdrLinksError);
      assert.equal(readFileSync(path, "utf8"), content);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Pi instruction paths honor PI_CODING_AGENT_DIR and active override files", () => {
  const directory = temporaryDirectory();
  try {
    const profile = join(directory, "profile");
    const override = join(profile, "AGENTS.override.md");
    mkdirSync(profile);
    writeFileSync(override, "# Override\n");
    const environment = { HOME: join(directory, "home"), PI_CODING_AGENT_DIR: profile };
    assert.equal(setupInstructionFile(environment), override);
    assert.equal(cleanupInstructionFile(environment), override);
    assert.throws(() => setupInstructionFile({ PI_CODING_AGENT_DIR: "relative" }), /must be absolute/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("inactive Pi context symlink aliases do not block the active regular file", () => {
  const directory = temporaryDirectory();
  try {
    const profile = join(directory, "profile");
    const agents = join(profile, "AGENTS.md");
    const claude = join(profile, "CLAUDE.md");
    mkdirSync(profile);
    writeFileSync(agents, "# Agents\n");
    symlinkSync(agents, claude);
    const environment = { PI_CODING_AGENT_DIR: profile };
    assert.equal(setupInstructionFile(environment), agents);
    assert.equal(cleanupInstructionFile(environment), agents);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("stored plugin registry lookup honors XDG_CONFIG_HOME and rejects symlinks", () => {
  const directory = temporaryDirectory();
  try {
    const registry = join(directory, "herdr", "plugins.json");
    mkdirSync(join(directory, "herdr"));
    const plugin = { plugin_id: PLUGIN_ID, plugin_root: ROOT, enabled: true, source: { kind: "local" } };
    writeFileSync(registry, JSON.stringify([plugin]));
    assert.equal(pluginRegistryPath({ XDG_CONFIG_HOME: directory }), registry);
    assert.deepEqual(readStoredPlugins({ XDG_CONFIG_HOME: directory }), [plugin]);
    rmSync(registry);
    const target = join(directory, "registry-target.json");
    writeFileSync(target, "[]");
    symlinkSync(target, registry);
    assert.throws(() => readStoredPlugins({ XDG_CONFIG_HOME: directory }), /regular file.*symlink/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("setup refuses a managed block shadowed by a higher-priority context file", () => {
  const directory = temporaryDirectory();
  try {
    const profile = join(directory, "profile");
    const agents = join(profile, "AGENTS.md");
    const override = join(profile, "AGENTS.override.md");
    mkdirSync(profile);
    writeFileSync(agents, `${MANAGED_BLOCK_BEGIN}\n\nold\n\n<!-- END HERDR LINKS -->\n`);
    writeFileSync(override, "# Override\n");
    assert.throws(() => setupInstructionFile({ PI_CODING_AGENT_DIR: profile }), /shadowed/u);
    assert.equal(cleanupInstructionFile({ PI_CODING_AGENT_DIR: profile }), agents);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("failed plugin linking rolls back instruction changes", () => {
  const directory = temporaryDirectory();
  try {
    const agentFile = join(directory, "AGENTS.md");
    const snippet = join(directory, "instructions.md");
    writeFileSync(agentFile, "unrelated\n");
    writeFileSync(snippet, "use @PLUGIN_ROOT@");
    const calls: readonly string[][] = [];
    const mutableCalls = calls as string[][];
    const runner: CliRunner = (_binary, arguments_) => {
      mutableCalls.push([...arguments_]);
      if (arguments_.join(" ") === "--version") return result(0, "herdr 0.9.0\n");
      if (arguments_[0] === "plugin" && arguments_[1] === "list") return result(0, pluginList([]));
      return result(1, "", "link failed");
    };
    assert.throws(() => install(ROOT, agentFile, snippet, "/fake/herdr", installerRuntime(runner, [[]])), /link failed/u);
    assert.equal(readFileSync(agentFile, "utf8"), "unrelated\n");
    assert.deepEqual(calls[2], ["plugin", "link", ROOT, "--enabled"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("setup preserves a GitHub-managed registration without relinking it", () => {
  const directory = temporaryDirectory();
  try {
    const agentFile = join(directory, "AGENTS.md");
    const snippet = join(directory, "instructions.md");
    writeFileSync(agentFile, "unrelated\n");
    writeFileSync(snippet, "use @PLUGIN_ROOT@");
    const plugin = {
      plugin_id: PLUGIN_ID,
      plugin_root: ROOT,
      enabled: true,
      warnings: [],
      source: { kind: "github", owner: "dima-m711", repo: "herdr-links" },
    };
    const calls: string[][] = [];
    const runner: CliRunner = (_binary, arguments_) => {
      calls.push([...arguments_]);
      if (arguments_[0] === "--version") return result(0, "herdr 0.9.0\n");
      return result(0, pluginList([plugin]));
    };
    const receipt = setup(ROOT, agentFile, snippet, "/fake/herdr", installerRuntime(runner, [[plugin], [plugin]]));
    assert.deepEqual(receipt.plugin["source"], plugin.source);
    assert.equal(receipt.instructions.changed, true);
    assert.equal(calls.some((arguments_) => arguments_.includes("link")), false);
    assert.equal(readFileSync(agentFile, "utf8").includes(ROOT), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("setup rollback preserves a concurrent user edit", () => {
  const directory = temporaryDirectory();
  try {
    const agentFile = join(directory, "AGENTS.md");
    const snippet = join(directory, "instructions.md");
    writeFileSync(agentFile, "unrelated\n");
    writeFileSync(snippet, "use @PLUGIN_ROOT@");
    const plugin = {
      plugin_id: PLUGIN_ID,
      plugin_root: ROOT,
      enabled: true,
      warnings: [],
      source: { kind: "github", owner: "dima-m711", repo: "herdr-links" },
    };
    let lists = 0;
    const runner: CliRunner = (_binary, arguments_) => {
      if (arguments_[0] === "--version") return result(0, "herdr 0.9.0\n");
      lists += 1;
      if (lists === 2) {
        writeFileSync(agentFile, readFileSync(agentFile, "utf8") + "user edit\n");
        return result(0, pluginList([]));
      }
      return result(0, pluginList([plugin]));
    };
    assert.throws(
      () => setup(ROOT, agentFile, snippet, "/fake/herdr", installerRuntime(runner, [[plugin], [plugin]])),
      /rollback incomplete.*changed concurrently/u,
    );
    const preserved = readFileSync(agentFile, "utf8");
    assert.match(preserved, /user edit/u);
    assert.match(preserved, new RegExp(MANAGED_BLOCK_BEGIN, "u"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("setup rejects missing or unknown registration provenance", () => {
  const directory = temporaryDirectory();
  try {
    const agentFile = join(directory, "AGENTS.md");
    const snippet = join(directory, "instructions.md");
    writeFileSync(agentFile, "unrelated\n");
    writeFileSync(snippet, "use @PLUGIN_ROOT@");
    const plugin = { plugin_id: PLUGIN_ID, plugin_root: ROOT, enabled: true, warnings: [], source: null };
    const runner: CliRunner = (_binary, arguments_) =>
      arguments_[0] === "--version" ? result(0, "herdr 0.9.0\n") : result(0, pluginList([plugin]));
    assert.throws(
      () => setup(ROOT, agentFile, snippet, "/fake/herdr", installerRuntime(runner, [[plugin]])),
      /plugin source/u,
    );
    assert.equal(readFileSync(agentFile, "utf8"), "unrelated\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("install preserves a same-root GitHub registration instead of converting it to local", () => {
  const directory = temporaryDirectory();
  try {
    const agentFile = join(directory, "AGENTS.md");
    const snippet = join(directory, "instructions.md");
    writeFileSync(agentFile, "unrelated\n");
    writeFileSync(snippet, "use @PLUGIN_ROOT@");
    const plugin = {
      plugin_id: PLUGIN_ID,
      plugin_root: ROOT,
      enabled: true,
      warnings: [],
      source: { kind: "github", owner: "dima-m711", repo: "herdr-links" },
    };
    const calls: string[][] = [];
    const runner: CliRunner = (_binary, arguments_) => {
      calls.push([...arguments_]);
      if (arguments_[0] === "--version") return result(0, "herdr 0.9.0\n");
      return result(0, pluginList([plugin]));
    };
    const receipt = install(
      ROOT,
      agentFile,
      snippet,
      "/fake/herdr",
      installerRuntime(runner, [[plugin], [plugin], [plugin]]),
    );
    assert.equal(receipt.instructions.changed, true);
    assert.equal(calls.some((arguments_) => arguments_.includes("link")), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("cleanup removes instructions without touching Herdr registration", () => {
  const directory = temporaryDirectory();
  try {
    const agentFile = join(directory, "AGENTS.md");
    const snippet = join(directory, "instructions.md");
    writeFileSync(agentFile, "unrelated\n");
    writeFileSync(snippet, "use @PLUGIN_ROOT@");
    installInstructions(agentFile, snippet, ROOT);
    const receipt = cleanup(agentFile);
    assert.equal(receipt.changed, true);
    assert.equal(readFileSync(agentFile, "utf8"), "unrelated\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("legacy plugin registration blocks setup before instructions change", () => {
  const directory = temporaryDirectory();
  try {
    const agentFile = join(directory, "AGENTS.md");
    const snippet = join(directory, "instructions.md");
    writeFileSync(agentFile, "unrelated\n");
    writeFileSync(snippet, "use @PLUGIN_ROOT@");
    const legacy = { plugin_id: LEGACY_PLUGIN_ID, plugin_root: "/legacy", enabled: true, warnings: [] };
    const runner: CliRunner = (_binary, arguments_) =>
      arguments_[0] === "--version" ? result(0, "herdr 0.9.0\n") : result(0, pluginList([legacy]));
    assert.throws(
      () => setup(ROOT, agentFile, snippet, "/fake/herdr", installerRuntime(runner, [[legacy]])),
      /legacy.*dima\.herdr-links/u,
    );
    assert.equal(readFileSync(agentFile, "utf8"), "unrelated\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("local install refuses a hidden stored legacy identity before linking", () => {
  const directory = temporaryDirectory();
  try {
    const agentFile = join(directory, "AGENTS.md");
    writeFileSync(agentFile, "unrelated\n");
    const legacy = {
      plugin_id: LEGACY_PLUGIN_ID,
      plugin_root: ROOT,
      enabled: true,
      warnings: [],
      source: { kind: "local" },
    };
    const projected = { ...legacy, plugin_id: PLUGIN_ID };
    const calls: string[][] = [];
    const runner: CliRunner = (_binary, arguments_) => {
      calls.push([...arguments_]);
      return arguments_[0] === "--version" ? result(0, "herdr 0.9.0\n") : result(0, pluginList([projected]));
    };
    assert.throws(
      () => install(
        ROOT,
        agentFile,
        join(ROOT, "agent-instructions.md"),
        "/fake/herdr",
        installerRuntime(runner, [[legacy]]),
      ),
      /legacy stored plugin/u,
    );
    assert.equal(calls.some((arguments_) => arguments_.includes("link")), false);
    assert.equal(readFileSync(agentFile, "utf8"), "unrelated\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("legacy migration repairs an in-place manifest rename through stored registry identity", () => {
  const legacy = {
    plugin_id: LEGACY_PLUGIN_ID,
    plugin_root: ROOT,
    enabled: true,
    warnings: [],
    source: { kind: "local" },
  };
  const current = { ...legacy, plugin_id: PLUGIN_ID };
  const responses = [
    result(0, "herdr 0.9.0\n"),
    result(0, pluginList([current])),
    result(0, "unlinked\n"),
    result(0, pluginList([])),
    result(0, "linked\n"),
    result(0, pluginList([current])),
  ];
  const calls: string[][] = [];
  const runner: CliRunner = (_binary, arguments_) => {
    calls.push([...arguments_]);
    const response = responses.shift();
    if (!response) throw new Error("unexpected call");
    return response;
  };
  const receipt = migrateLegacyRegistration(
    ROOT,
    "/fake/herdr",
    installerRuntime(runner, [[legacy], [legacy], [], [current]]),
  );
  assert.equal(receipt.changed, true);
  assert.equal(receipt.plugin["plugin_id"], PLUGIN_ID);
  assert.deepEqual(calls[2], ["plugin", "unlink", LEGACY_PLUGIN_ID]);
  assert.deepEqual(calls[4], ["plugin", "link", ROOT, "--enabled"]);
});

test("legacy migration is idempotent for an already-migrated local registration", () => {
  const plugin = {
    plugin_id: PLUGIN_ID,
    plugin_root: ROOT,
    enabled: true,
    warnings: [],
    source: { kind: "local" },
  };
  const calls: string[][] = [];
  const runner: CliRunner = (_binary, arguments_) => {
    calls.push([...arguments_]);
    return arguments_[0] === "--version" ? result(0, "herdr 0.9.0\n") : result(0, pluginList([plugin]));
  };
  const receipt = migrateLegacyRegistration(
    ROOT,
    "/fake/herdr",
    installerRuntime(runner, [[plugin]]),
  );
  assert.equal(receipt.changed, false);
  assert.equal(calls.some((arguments_) => arguments_[1] === "unlink" || arguments_[1] === "link"), false);
});

test("legacy migration never touches GitHub-managed, foreign-root, or ambiguous stored registrations", () => {
  const github = {
    plugin_id: LEGACY_PLUGIN_ID,
    plugin_root: ROOT,
    enabled: true,
    warnings: [],
    source: { kind: "github", owner: "dima-m711", repo: "herdr-links" },
  };
  const foreign = { ...github, plugin_root: "/different/checkout", source: { kind: "local" } };
  const current = { ...github, plugin_id: PLUGIN_ID, source: { kind: "local" } };
  for (const [plugins, expected] of [
    [[github], /GitHub-managed/u],
    [[foreign], /another checkout/u],
    [[github, current], /ambiguous/u],
  ] as const) {
    const calls: string[][] = [];
    const runner: CliRunner = (_binary, arguments_) => {
      calls.push([...arguments_]);
      return result(0, "herdr 0.9.0\n");
    };
    assert.throws(
      () => migrateLegacyRegistration(ROOT, "/fake/herdr", installerRuntime(runner, [plugins])),
      expected,
    );
    assert.equal(calls.some((arguments_) => arguments_.includes("unlink") || arguments_.includes("link")), false);
  }
});

test("successful installation verifies the exact enabled plugin", () => {
  const directory = temporaryDirectory();
  try {
    const agentFile = join(directory, "AGENTS.md");
    const snippet = join(directory, "instructions.md");
    writeFileSync(agentFile, "unrelated\n");
    writeFileSync(snippet, "use @PLUGIN_ROOT@");
    const plugin = { plugin_id: PLUGIN_ID, plugin_root: ROOT, enabled: true, warnings: [] };
    const responses = [
      result(0, "herdr 0.9.0\n"),
      result(0, pluginList([])),
      result(0, "linked\n"),
      result(0, pluginList([plugin])),
    ];
    const runner: CliRunner = () => responses.shift() ?? result(1, "", "unexpected call");
    const receipt = install(ROOT, agentFile, snippet, "/fake/herdr", installerRuntime(runner, [[], [plugin]]));
    assert.equal(receipt.instructions.changed, true);
    assert.equal(receipt.plugin["plugin_id"], PLUGIN_ID);
    assert.equal(responses.length, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("another checkout registration is never overwritten or unlinked", () => {
  const directory = temporaryDirectory();
  try {
    const path = join(directory, "AGENTS.md");
    writeFileSync(path, "preserve\n");
    const plugin = { plugin_id: PLUGIN_ID, plugin_root: "/different/checkout" };
    const calls: string[][] = [];
    const runner: CliRunner = (_binary, arguments_) => {
      calls.push([...arguments_]);
      return arguments_[0] === "--version" ? result(0, "herdr 0.9.0") : result(0, pluginList([plugin]));
    };
    assert.throws(
      () => install(
        ROOT,
        path,
        join(ROOT, "agent-instructions.md"),
        "/fake/herdr",
        installerRuntime(runner, [[plugin]]),
      ),
      /another checkout/u,
    );
    assert.throws(
      () => uninstall(path, "/fake/herdr", installerRuntime(runner, [[plugin]])),
      /another checkout/u,
    );
    assert.equal(readFileSync(path, "utf8"), "preserve\n");
    assert.equal(calls.some((arguments_) => arguments_.includes("link") || arguments_.includes("unlink")), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("uninstall refuses GitHub-managed registrations before editing instructions", () => {
  const directory = temporaryDirectory();
  try {
    const agentFile = join(directory, "AGENTS.md");
    const snippet = join(directory, "instructions.md");
    writeFileSync(agentFile, "unrelated\n");
    writeFileSync(snippet, "use @PLUGIN_ROOT@");
    installInstructions(agentFile, snippet, ROOT);
    const installed = readFileSync(agentFile, "utf8");
    const plugin = {
      plugin_id: PLUGIN_ID,
      plugin_root: ROOT,
      enabled: true,
      warnings: [],
      source: { kind: "github", owner: "dima-m711", repo: "herdr-links" },
    };
    const runner: CliRunner = (_binary, arguments_) =>
      arguments_[0] === "--version" ? result(0, "herdr 0.9.0\n") : result(0, pluginList([plugin]));
    assert.throws(
      () => uninstall(agentFile, "/fake/herdr", installerRuntime(runner, [[plugin]])),
      /GitHub-managed.*cleanup/u,
    );
    assert.equal(readFileSync(agentFile, "utf8"), installed);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("uninstall failure restores the managed instruction block", () => {
  const directory = temporaryDirectory();
  try {
    const path = join(directory, "AGENTS.md");
    writeFileSync(path, "preserve\n");
    installInstructions(path, join(ROOT, "agent-instructions.md"), ROOT);
    const installed = readFileSync(path, "utf8");
    const plugin = { plugin_id: PLUGIN_ID, plugin_root: ROOT, enabled: true };
    const runner: CliRunner = (_binary, arguments_) => {
      if (arguments_[0] === "--version") return result(0, "herdr 0.9.0\n");
      return arguments_[1] === "list" ? result(0, pluginList([plugin])) : result(1, "", "unlink failed");
    };
    assert.throws(
      () => uninstall(path, "/fake/herdr", installerRuntime(runner, [[plugin]])),
      /unlink failed/u,
    );
    assert.equal(readFileSync(path, "utf8"), installed);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("post-link verification failure restores instructions and new registration", () => {
  const directory = temporaryDirectory();
  try {
    const path = join(directory, "AGENTS.md");
    writeFileSync(path, "keep\n");
    let plugin: Record<string, unknown> | undefined;
    const runner: CliRunner = (_binary, arguments_) => {
      if (arguments_[0] === "--version") return result(0, "herdr 0.9.0");
      if (arguments_[1] === "list") return result(0, pluginList(plugin ? [plugin] : []));
      if (arguments_[1] === "link") plugin = { plugin_id: PLUGIN_ID, plugin_root: ROOT, enabled: true, warnings: ["bad"] };
      if (arguments_[1] === "unlink") plugin = undefined;
      return result(0, "ok");
    };
    assert.throws(
      () => install(ROOT, path, join(ROOT, "agent-instructions.md"), "/fake/herdr", {
        runner,
        readStoredPlugins: () => normalizedPlugins(plugin ? [plugin] : []),
      }),
      /verification failed/u,
    );
    assert.equal(readFileSync(path, "utf8"), "keep\n");
    assert.equal(plugin, undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rollback failures are explicit without preventing instruction restore", () => {
  const directory = temporaryDirectory();
  try {
    const path = join(directory, "AGENTS.md");
    writeFileSync(path, "keep\n");
    let plugin: Record<string, unknown> | undefined;
    const runner: CliRunner = (_binary, arguments_) => {
      if (arguments_[0] === "--version") return result(0, "herdr 0.9.0");
      if (arguments_[1] === "list") return result(0, pluginList(plugin ? [plugin] : []));
      if (arguments_[1] === "link") {
        plugin = { plugin_id: PLUGIN_ID, plugin_root: ROOT, enabled: false };
        return result(0, "ok");
      }
      return result(1, "", "unlink failed");
    };
    assert.throws(
      () => install(ROOT, path, join(ROOT, "agent-instructions.md"), "/fake/herdr", {
        runner,
        readStoredPlugins: () => normalizedPlugins(plugin ? [plugin] : []),
      }),
      /rollback incomplete.*plugin rollback.*unlink failed/u,
    );
    assert.equal(readFileSync(path, "utf8"), "keep\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("CLI execution failures are surfaced", () => {
  const runner: CliRunner = () => ({ status: null, stdout: "", stderr: "", error: new Error("timed out") });
  assert.throws(() => runCli("/fake/herdr", ["--version"], runner), /CLI failed.*timed out/u);
});

test("uninstall skips unlink when the plugin is absent", () => {
  const directory = temporaryDirectory();
  try {
    const agentFile = join(directory, "AGENTS.md");
    const snippet = join(directory, "instructions.md");
    writeFileSync(agentFile, "unrelated\n");
    writeFileSync(snippet, "use @PLUGIN_ROOT@");
    installInstructions(agentFile, snippet, ROOT);
    const calls: string[][] = [];
    const runner: CliRunner = (_binary, arguments_) => {
      calls.push([...arguments_]);
      return arguments_[0] === "--version" ? result(0, "herdr 0.9.0\n") : result(0, pluginList([]));
    };
    const receipt = uninstall(agentFile, "/fake/herdr", installerRuntime(runner, [[]]));
    assert.equal(receipt.instructions.changed, true);
    assert.equal(receipt.pluginWasLinked, false);
    assert.deepEqual(calls, [["--version"], ["plugin", "list", "--json"]]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("manifest, package and parser remain aligned", () => {
  const manifest = readFileSync(join(ROOT, "herdr-plugin.toml"), "utf8");
  const packageJson = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as Record<string, unknown>;
  assert.equal(PLUGIN_ID, "herdr-links");
  assert.equal(LEGACY_PLUGIN_ID, "dima.herdr-links");
  assert.match(manifest, new RegExp(`^version = "${VERSION}"$`, "mu"));
  assert.equal(packageJson["version"], VERSION);
  assert.match(
    manifest,
    /command = \["\/bin\/sh", "-lc", "npm ci --include=dev --ignore-scripts --no-audit --no-fund"\]/u,
  );
  assert.match(manifest, /command = \["\/bin\/sh", "-lc", "npm run build"\]/u);
  assert.match(manifest, /id = "setup"[\s\S]+command = \["\/bin\/sh", "-lc", "node \.\/dist\/cli\.js setup"\]/u);
  assert.match(manifest, /id = "cleanup"[\s\S]+command = \["\/bin\/sh", "-lc", "node \.\/dist\/cli\.js cleanup"\]/u);
  assert.match(manifest, /command = \["\/bin\/sh", "-lc", "node \.\/dist\/cli\.js handle"\]/u);
  assert.match(manifest, new RegExp(`^id = "${PLUGIN_ID}"$`, "mu"));
  assert.match(manifest, new RegExp(`action = "${ACTION_ID}"`, "u"));
  assert.match(manifest, new RegExp(`id = "${LINK_HANDLER_ID}"`, "u"));

  const patternText = /^pattern = '(.+)'$/mu.exec(manifest)?.[1];
  assert.ok(patternText);
  const pattern = new RegExp(patternText);
  for (const scheme of ["https://herdr.invalid/v1", "herdr://navigation/v1"]) {
    for (const [kind, target] of [
      ["agent", "wA:pD"],
      ["pane", "wA:pD"],
      ["workspace", "wA"],
      ["tab", "wA:tE"],
    ]) {
      const url = `${scheme}/${"a".repeat(64)}/${kind}/${target}`;
      assert.match(url, pattern);
      assert.deepEqual(parseNavigationUrl(url).slice(1), [kind, target]);
    }
    for (const [kind, target] of [
      ["agent", "wA"],
      ["pane", "wA:tE"],
      ["workspace", "wA:pD"],
      ["tab", "wA:pD"],
    ]) {
      const url = `${scheme}/${"a".repeat(64)}/${kind}/${target}`;
      assert.doesNotMatch(url, pattern);
      assert.throws(() => parseNavigationUrl(url), HerdrLinksError);
    }
  }
});

test("source wrapper remains executable and never falls back to Python", () => {
  const wrapper = join(ROOT, "bin", "herdr-links");
  accessSync(wrapper, constants.X_OK);
  const contents = readFileSync(wrapper, "utf8");
  assert.doesNotMatch(contents, /python/iu);
  assert.match(contents, /exec node/u);
});
