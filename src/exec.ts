import { App, FileSystemAdapter, Notice } from "obsidian";
import { spawn } from "child_process";
import * as path from "path";

// The plugin-review lint runs without Node typings, so `child_process`,
// `path` and `process` resolve as `any` there. Pin the narrow surface we use
// to explicit types so no `any` flows through the code below.
interface SpawnedChild {
	on(event: "error", handler: (err: Error) => void): void;
	unref(): void;
}
const spawnDetached = spawn as unknown as (
	command: string,
	options: { shell: boolean; detached: boolean; stdio: "ignore"; cwd: string }
) => SpawnedChild;
const { join: joinPath, dirname: parentDir } = path as {
	join: (...parts: string[]) => string;
	dirname: (p: string) => string;
};
const platform = (process as { platform: string }).platform;

/**
 * Run a user-configured shell command, detached so the spawned application
 * outlives Obsidian. The {{path}}, {{folder}} and {{vault}} placeholders are
 * replaced with shell-quoted absolute paths derived from the active note, and
 * the command runs with the note's folder as its working directory.
 * Desktop only (the manifest declares isDesktopOnly).
 */
export function runTerminalCommand(app: App, template: string): void {
	const adapter = app.vault.adapter;
	if (!(adapter instanceof FileSystemAdapter)) return;

	const vaultDir = adapter.getBasePath();
	const file = app.workspace.getActiveFile();
	const notePath = file ? joinPath(vaultDir, file.path) : vaultDir;
	const noteDir = file ? parentDir(notePath) : vaultDir;

	// split/join instead of replace() so `$` in paths can't act as a
	// replacement pattern.
	const command = template
		.split("{{vault}}").join(quoteForShell(vaultDir))
		.split("{{path}}").join(quoteForShell(notePath))
		.split("{{folder}}").join(quoteForShell(noteDir));

	const child = spawnDetached(command, {
		shell: true,
		detached: true,
		stdio: "ignore",
		cwd: noteDir,
	});
	child.on("error", (err) => {
		new Notice(`Terminal command failed: ${err.message}`);
	});
	child.unref();
}

function quoteForShell(p: string): string {
	// cmd.exe on Windows (double quotes; `"` is not legal in Windows paths),
	// POSIX sh elsewhere (single quotes, with embedded quotes escaped).
	if (platform === "win32") return `"${p}"`;
	return `'${p.replace(/'/g, `'\\''`)}'`;
}
