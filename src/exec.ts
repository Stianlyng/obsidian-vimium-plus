import { App, FileSystemAdapter, Notice } from "obsidian";
import { spawn } from "child_process";
import * as path from "path";

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
	const notePath = file ? path.join(vaultDir, file.path) : vaultDir;
	const noteDir = file ? path.dirname(notePath) : vaultDir;

	// split/join instead of replace() so `$` in paths can't act as a
	// replacement pattern.
	const command = template
		.split("{{vault}}").join(quoteForShell(vaultDir))
		.split("{{path}}").join(quoteForShell(notePath))
		.split("{{folder}}").join(quoteForShell(noteDir));

	const child = spawn(command, {
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
	if (process.platform === "win32") return `"${p}"`;
	return `'${p.replace(/'/g, `'\\''`)}'`;
}
