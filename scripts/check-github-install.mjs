import { chmodSync, cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const temporaryRoot = mkdtempSync(join(tmpdir(), "herdr-links-github-install-"));
const checkout = join(temporaryRoot, "checkout");
const npmConfig = join(temporaryRoot, "npmrc");

function run(command, arguments_, options = {}) {
  const completed = spawnSync(command, arguments_, {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    env: options.env ?? process.env,
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (completed.error) throw completed.error;
  if (completed.status !== 0) {
    const detail = options.capture ? `\n${completed.stderr || completed.stdout}` : "";
    throw new Error(`${command} ${arguments_.join(" ")} failed with exit ${completed.status}${detail}`);
  }
  return completed.stdout;
}

try {
  mkdirSync(checkout);
  const listed = run(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { capture: true },
  );
  const paths = listed.split("\0").filter(Boolean);
  if (paths.some((path) => path === "dist" || path.startsWith("dist/"))) {
    throw new Error("clean-checkout simulation must build without a tracked dist directory");
  }
  for (const path of paths) {
    const source = join(root, path);
    if (!existsSync(source)) continue;
    const destination = join(checkout, path);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination, { recursive: true });
  }

  writeFileSync(npmConfig, "", { mode: 0o600 });
  const environment = {
    ...process.env,
    CI: "true",
    npm_config_userconfig: npmConfig,
  };
  run("npm", ["ci", "--include=dev", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: checkout,
    env: environment,
  });
  run("npm", ["run", "build"], { cwd: checkout, env: environment });
  if (!existsSync(join(checkout, "dist", "cli.js"))) throw new Error("build did not create dist/cli.js");
  const version = run("node", ["./dist/cli.js", "--version"], {
    cwd: checkout,
    env: environment,
    capture: true,
  }).trim();
  const packageJson = JSON.parse(readFileSync(join(checkout, "package.json"), "utf8"));
  const expectedVersion = `herdr-links ${packageJson.version}`;
  if (version !== expectedVersion) throw new Error(`unexpected clean-checkout version: ${version}`);

  const fakeBin = join(temporaryRoot, "bin");
  const fakeHerdr = join(fakeBin, "herdr");
  const fakeLog = join(temporaryRoot, "herdr-calls.jsonl");
  const piAgentDirectory = join(temporaryRoot, "pi-agent");
  const xdgConfigHome = join(temporaryRoot, "xdg-config");
  const registryDirectory = join(xdgConfigHome, "herdr");
  mkdirSync(fakeBin);
  mkdirSync(registryDirectory, { recursive: true });
  writeFileSync(
    join(registryDirectory, "plugins.json"),
    JSON.stringify([
      {
        plugin_id: "herdr-links",
        plugin_root: checkout,
        enabled: true,
        warnings: [],
        source: { kind: "github", owner: "elecnix", repo: "herdr-links" },
      },
    ]),
  );
  writeFileSync(
    fakeHerdr,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_HERDR_LOG, JSON.stringify(args) + "\\n");
if (args.length === 1 && args[0] === "--version") {
  process.stdout.write("herdr 0.9.0\\n");
} else if (JSON.stringify(args) === JSON.stringify(["plugin", "list", "--json"])) {
  process.stdout.write(JSON.stringify({ result: { plugins: [{ plugin_id: "herdr-links", plugin_root: process.env.FAKE_PLUGIN_ROOT, enabled: true, warnings: [], source: { kind: "github", owner: "elecnix", repo: "herdr-links" } }] } }));
} else {
  process.stderr.write("unexpected fake Herdr call: " + JSON.stringify(args) + "\\n");
  process.exitCode = 91;
}
`,
    { mode: 0o755 },
  );
  chmodSync(fakeHerdr, 0o755);
  const setupEnvironment = {
    ...environment,
    PATH: `${fakeBin}:${environment.PATH ?? ""}`,
    PI_CODING_AGENT_DIR: piAgentDirectory,
    XDG_CONFIG_HOME: xdgConfigHome,
    HERDR_BIN_PATH: fakeHerdr,
    FAKE_HERDR_LOG: fakeLog,
    FAKE_PLUGIN_ROOT: checkout,
  };
  run("node", ["./dist/cli.js", "setup"], { cwd: checkout, env: setupEnvironment, capture: true });
  const instructionFile = join(piAgentDirectory, "AGENTS.md");
  const instructions = readFileSync(instructionFile, "utf8");
  if (!instructions.includes(checkout) || !instructions.includes("<!-- BEGIN HERDR LINKS -->")) {
    throw new Error("setup did not install managed Pi instructions from the managed checkout");
  }
  const herdrCalls = readFileSync(fakeLog, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  if (herdrCalls.some((arguments_) => arguments_.includes("link") || arguments_.includes("unlink"))) {
    throw new Error("setup changed GitHub-managed Herdr registration provenance");
  }
  run("node", ["./dist/cli.js", "cleanup"], { cwd: checkout, env: setupEnvironment, capture: true });
  if (readFileSync(instructionFile, "utf8") !== "") throw new Error("cleanup left managed Pi instructions behind");

  console.log("Clean GitHub checkout build and setup/cleanup passed.");
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
