import { ProjectConfig } from "@masscode/contracts";
import * as Schema from "effect/Schema";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getErrorMessage } from "./errors.ts";

/** The text of the project's `masscode.toml`; null when there's none. */
export function readProjectConfigText(projectPath: string) {
  return readFile(join(projectPath, "masscode.toml"), "utf8").catch(() => null);
}

/** `text` as the project's config, or an Error saying what's wrong with it. */
export function parseProjectConfig(projectPath: string, text: string): ProjectConfig | Error {
  try {
    return Schema.decodeUnknownSync(ProjectConfig)(Bun.TOML.parse(text));
  } catch (error) {
    return new Error(
      `${join(projectPath, "masscode.toml")} isn't valid: ${getErrorMessage(error)}`,
    );
  }
}

/** The project's `masscode.toml`; empty when there's none, an Error saying what's wrong when it's invalid. */
export async function readProjectConfig(projectPath: string): Promise<ProjectConfig | Error> {
  const text = await readProjectConfigText(projectPath);

  return text === null ? {} : parseProjectConfig(projectPath, text);
}

/** Writes `config` as the project's `masscode.toml`, or removes the file when there's nothing in it; resolves to what went wrong, or null. */
export async function writeProjectConfig(projectPath: string, config: ProjectConfig) {
  const path = join(projectPath, "masscode.toml");
  const text = toToml(config);
  // ponytail: hand-rolled for this schema (Bun parses TOML but can't write it); parsed back so a mistake never lands.
  const parsed = text ? parseProjectConfig(projectPath, text) : null;

  if (parsed instanceof Error) return parsed.message;

  try {
    await (text ? writeFile(path, text) : rm(path, { force: true }));

    return null;
  } catch (error) {
    return `Couldn't save ${path}: ${getErrorMessage(error)}`;
  }
}

function toToml({ worktree, scripts = [] }: ProjectConfig) {
  const worktreeLines = [
    worktree?.default === undefined ? [] : [`default = ${worktree.default}`],
    worktree?.setup === undefined ? [] : [`setup = ${formatTomlString(worktree.setup)}`],
    worktree?.wait_for_setup === undefined ? [] : [`wait_for_setup = ${worktree.wait_for_setup}`],
  ].flat();

  const tables = [
    ...(worktreeLines.length ? [["[worktree]", ...worktreeLines]] : []),
    ...scripts.map((script) => [
      "[[scripts]]",
      `name = ${formatTomlString(script.name)}`,
      `command = ${formatTomlString(script.command)}`,
      ...(script.preview_url === undefined
        ? []
        : [`preview_url = ${formatTomlString(script.preview_url)}`]),
    ]),
  ];

  return tables.length ? `${tables.map((lines) => lines.join("\n")).join("\n\n")}\n` : "";
}

/** Multi-line text as a literal block, so a script reads as written; JSON's escapes are valid TOML ones. */
function formatTomlString(value: string) {
  return value.includes("\n") && !value.includes("'''")
    ? `'''\n${value.endsWith("\n") ? value : `${value}\n`}'''`
    : JSON.stringify(value);
}
