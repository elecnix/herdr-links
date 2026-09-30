#!/usr/bin/env node

import { isAbsolute, join } from "node:path";
import {
  INSTRUCTION_AGENTS,
  PLUGIN_ID,
  ROOT,
  VERSION,
  Environment,
  HerdrLinksError,
  InstructionAgent,
  InstructionChange,
  cleanup,
  cleanupInstructionFile,
  claudeCodeMemoryFile,
  findExecutable,
  handleNavigation,
  install,
  installInstructions,
  instructionFileFor,
  migrateLegacyRegistration,
  navigationMarkdown,
  setup,
  setupInstructionFile,
  socketFromEnvironment,
  uninstall,
  validateTarget,
} from "./core.js";

const AGENT_LABEL: Readonly<Record<InstructionAgent, string>> = { "claude-code": "Claude Code", pi: "Pi" };

function installClaudeCode(environment: Environment, snippet: string): InstructionChange {
  return installInstructions(claudeCodeMemoryFile(environment), snippet, ROOT);
}

const HELP = `Usage: herdr-links <command>

Commands:
  handle
  link <agent|workspace|tab|pane> <ID> [--label <text>]
  setup
  cleanup
  install
  uninstall
  migrate
`;

interface LinkArguments {
  kind: string;
  target: string;
  label?: string;
}

function parseLinkArguments(arguments_: readonly string[]): LinkArguments {
  const [kind, target, ...options] = arguments_;
  if (!kind || !target) throw new HerdrLinksError("link requires a target kind and public ID");
  validateTarget(kind, target);
  if (options.length === 0) return { kind, target };
  if (options.length !== 2 || options[0] !== "--label" || options[1] === undefined) {
    throw new HerdrLinksError("link accepts only one optional --label value");
  }
  return { kind, target, label: options[1] };
}

function herdrBinary(environment: Environment): string {
  const binary = environment["HERDR_BIN_PATH"] ?? findExecutable("herdr", environment);
  if (!binary || !isAbsolute(binary)) throw new HerdrLinksError("cannot locate an absolute Herdr CLI executable");
  return binary;
}

function printableError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return JSON.stringify(message).slice(1, -1);
}

export async function main(
  arguments_: readonly string[] = process.argv.slice(2),
  environment: Environment = process.env,
): Promise<number> {
  const [command, ...rest] = arguments_;
  try {
    if (command === "--help" || command === "-h") {
      process.stdout.write(HELP);
      return 0;
    }
    if (command === "--version" || command === "-V") {
      console.log(`herdr-links ${VERSION}`);
      return 0;
    }
    if (!command) throw new HerdrLinksError("a command is required; use --help for usage");

    if (command === "handle") {
      if (rest.length !== 0) throw new HerdrLinksError("handle accepts no arguments");
      const result = await handleNavigation(environment);
      console.log(JSON.stringify({ ok: true, type: result["type"] }));
      return 0;
    }

    if (command === "link") {
      const { kind, target, label } = parseLinkArguments(rest);
      console.log(await navigationMarkdown(kind, target, label, socketFromEnvironment(environment)));
      return 0;
    }

    if (!["setup", "cleanup", "install", "uninstall", "migrate"].includes(command)) {
      throw new HerdrLinksError(`unknown command: ${command}`);
    }
    if (rest.length !== 0) throw new HerdrLinksError(`${command} accepts no arguments`);

    if (command === "cleanup") {
      for (const agent of INSTRUCTION_AGENTS) {
        const file = instructionFileFor(agent, environment);
        const instructions = cleanup(file);
        console.log(`${AGENT_LABEL[agent]} instructions: ${instructions.changed ? "removed" : "unchanged"} (${file})`);
        if (instructions.backup) console.log(`Pre-edit backup: ${instructions.backup}`);
      }
      return 0;
    }

    const binary = herdrBinary(environment);
    const agentFile = command === "uninstall" ? cleanupInstructionFile(environment) : setupInstructionFile(environment);
    const snippet = join(ROOT, "agent-instructions.md");
    const report = (target: InstructionAgent, receipt: InstructionChange): void => {
      console.log(`${AGENT_LABEL[target]} instructions: ${receipt.changed ? "updated" : "unchanged"} (${instructionFileFor(target, environment)})`);
      if (receipt.backup) console.log(`Pre-edit backup: ${receipt.backup}`);
    };
    // Pi edits and the plugin registration share one transaction, so that path
    // keeps its original call. Claude Code shares no transaction with the
    // plugin, so its memory file is edited separately, after the Pi edit lands.
    if (command === "migrate") {
      const migration = migrateLegacyRegistration(ROOT, binary);
      const receipt = setup(ROOT, agentFile, snippet, binary);
      console.log(`${migration.changed ? "Migrated" : "Verified"} ${PLUGIN_ID} at ${ROOT}`);
      report("pi", receipt.instructions);
      report("claude-code", installClaudeCode(environment, snippet));
    } else if (command === "setup") {
      const receipt = setup(ROOT, agentFile, snippet, binary);
      console.log(`Configured ${PLUGIN_ID} from ${ROOT}`);
      report("pi", receipt.instructions);
      report("claude-code", installClaudeCode(environment, snippet));
    } else if (command === "install") {
      const receipt = install(ROOT, agentFile, snippet, binary);
      console.log(`Installed ${PLUGIN_ID} from ${ROOT}`);
      report("pi", receipt.instructions);
      report("claude-code", installClaudeCode(environment, snippet));
    } else {
      const receipt = uninstall(agentFile, binary);
      console.log(`Uninstalled ${PLUGIN_ID}; unrelated plugins and instructions preserved`);
      report("pi", receipt.instructions);
      report("claude-code", cleanup(claudeCodeMemoryFile(environment)));
    }
    return 0;
  } catch (error) {
    console.error(`herdr-links: ${printableError(error)}`);
    return 1;
  }
}

process.exitCode = await main();
