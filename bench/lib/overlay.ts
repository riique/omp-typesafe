/**
 * Builds the per-run config overlay (bench/results/<runId>/runs/<cell>/overlay.yml).
 * Per the parent plan (2.3): advisor disabled, plan autosave pointed at the run
 * dir, and disabledExtensions restated verbatim (config arrays replace wholesale
 * on merge, so a partial list here would silently re-enable extensions).
 */
export function overlayYaml(disabledExtensions: string[], planAutosaveDir: string): string {
	const lines: string[] = [];
	lines.push("advisor:");
	lines.push("  enabled: false");
	lines.push("plan:");
	lines.push("  autosave: true");
	lines.push(`  autosaveDir: ${JSON.stringify(planAutosaveDir)}`);
	lines.push("disabledExtensions:");
	for (const ext of disabledExtensions) {
		lines.push(`  - ${JSON.stringify(ext)}`);
	}
	return `${lines.join("\n")}\n`;
}
