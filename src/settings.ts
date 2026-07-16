// User-global render settings for pi-loop.
// Lives at ~/.pi/agent/loops-settings.json (via getAgentDir) so rendering prefs
// (width, footer style, column toggles) follow the user across every project.
// Loops themselves stay project-local in .pi/loops.json.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type FooterStyle = "compact" | "verbose";

export interface RenderSettings {
	/** Widget width as a percentage of terminal width (1–100). Default 60. */
	widthPct: number;
	/** Footer chip verbosity. Default compact. */
	footerStyle: FooterStyle;
	/** Widget column toggles. */
	schedule: boolean;
	countdown: boolean;
	runs: boolean;
	action: boolean;
}

export const DEFAULT_SETTINGS: RenderSettings = {
	widthPct: 60,
	footerStyle: "compact",
	schedule: true,
	countdown: true,
	runs: true,
	action: true,
};

const SETTINGS_FILE = join(getAgentDir(), "loops-settings.json");

let cached: RenderSettings = { ...DEFAULT_SETTINGS };

export function getSettings(): RenderSettings {
	return cached;
}

export async function loadSettings(): Promise<RenderSettings> {
	try {
		const raw = await readFile(SETTINGS_FILE, "utf8");
		cached = normalizeSettings(JSON.parse(raw));
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
			// corrupt/unreadable: fall back to defaults rather than crash
			cached = { ...DEFAULT_SETTINGS };
		}
	}
	return cached;
}

export async function saveSettings(s: RenderSettings): Promise<void> {
	cached = s;
	const json = `${JSON.stringify(s, null, 2)}\n`;
	try {
		await mkdir(dirname(SETTINGS_FILE), { recursive: true });
		const tmp = `${SETTINGS_FILE}.${process.pid}.tmp`;
		await writeFile(tmp, json, "utf8");
		await rename(tmp, SETTINGS_FILE);
	} catch {
		// best-effort: a failed persist must not crash the agent.
	}
}

function normalizeSettings(raw: unknown): RenderSettings {
	const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	const s = { ...DEFAULT_SETTINGS };
	if (typeof r.widthPct === "number" && r.widthPct >= 1 && r.widthPct <= 100) s.widthPct = r.widthPct;
	if (r.footerStyle === "compact" || r.footerStyle === "verbose") s.footerStyle = r.footerStyle;
	for (const k of ["schedule", "countdown", "runs", "action"] as const) {
		if (typeof r[k] === "boolean") s[k] = r[k] as boolean;
	}
	return s;
}
