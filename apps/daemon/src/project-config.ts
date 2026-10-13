import { ProjectConfig } from "@masscode/contracts";
import * as Schema from "effect/Schema";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getErrorMessage } from "./errors.ts";
import { formatToml } from "./storage/toml-file.ts";

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

  // An empty table or list is left out, so a config with nothing set has no file.
  const table = Object.fromEntries(
    Object.entries(Schema.encodeSync(ProjectConfig)(config)).filter(
      ([, value]) => Object.keys(value).length > 0,
    ),
  );

  const text = Object.keys(table).length > 0 ? formatToml(table) : "";
  // Parsed back, so a file that wouldn't load never lands.
  const parsed = text ? parseProjectConfig(projectPath, text) : null;

  if (parsed instanceof Error) return parsed.message;

  try {
    await (text ? writeFile(path, text) : rm(path, { force: true }));

    return null;
  } catch (error) {
    return `Couldn't save ${path}: ${getErrorMessage(error)}`;
  }
}
