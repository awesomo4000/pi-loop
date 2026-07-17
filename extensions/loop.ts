// pi-loop — reliable scheduled loops for the Pi coding agent.
//
// Why this exists: three prior plugins each broke differently.
//   • trvon/pi-loop            — invisible status (over-engineered, 80+ files).
//   • tintinweb/pi-schedule-prompt — overlay swallowed ctx.ui.input keystrokes.
//   • jl1990/pi-scheduler       — disk read clobbered live reschedule state;
//                                 recurring jobs landed in a terminal state.
//
// This extension's three guarantees:
//   1. ALWAYS-VISIBLE status: footer chip ("🔁 2 loops · next 4m") + a widget
//      below the editor listing every loop with a live countdown.
//   2. NATIVE DIALOGS only for the add/manage flow. No overlays competing for
//      keyboard input — Enter always registers.
//   3. BULLETPROOF recurrence: in-memory Map is authoritative, disk is a
//      write-through mirror read ONCE at session_start. For interval loops the
//      next run is re-armed BEFORE the action executes, so a crash or throw
//      never loses the recurrence.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, type Component, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Cron } from "croner";
import { join } from "node:path";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	inferType,
	nextRun,
	validateSchedule,
	type ActionType,
	type ScheduleType,
} from "../src/schedule.ts";
import { LoopStore, newId, planFire, type Loop, type ShellMode } from "../src/store.ts";
import { getSettings, loadSettings, saveSettings, DEFAULT_SETTINGS, type RenderSettings, type FooterStyle } from "../src/settings.ts";
import { formatRelative, loopPayloadPreview, loopPayloadRaw, loopScheduleLabel, safeParsed, displayName } from "../src/format.ts";

const CONFIG_DIR_NAME = ".pi";
const MAX_TIMER_DELAY_MS = 2_147_483_647; // setTimeout practical cap (~24.8d)
const DEFAULT_SHELL_TIMEOUT_MS = 5 * 60_000;
const MAX_OUTPUT_CHARS = 8_000;

type Handle = { kind: "timeout"; handle: NodeJS.Timeout } | { kind: "cron"; handle: Cron };

function truncateMiddle(text: string | undefined, max: number): string {
	const v = text ?? "";
	if (v.length <= max) return v;
	const head = Math.floor(max * 0.6);
	const tail = max - head - 60;
	return `${v.slice(0, head)}\n\n[… ${v.length - max} chars truncated …]\n\n${v.slice(-tail)}`;
}

function loopFilePath(cwd: string): string {
	return join(cwd, CONFIG_DIR_NAME, "loops.json");
}

function statusGlyph(loop: Loop): string {
	switch (loop.status) {
		case "active":
			return loop.lastStatus === "error" ? "⚠" : "●";
		case "paused":
			return "❚❚";
		case "done":
			return "✓";
		case "error":
			return "✗";
	}
}

/**
 * LoopWidget â a self-rendering, self-ticking TUI component.
 *
 * State-of-the-art countdown: the factory form of setWidget mounts this ONCE;
 * render() recomputes lines fresh from the live store each call; an adaptive
 * timer calls tui.requestRender() (coalesced by the TUI) â never re-calling
 * setWidget, so no widget teardown/rebuild or flicker. Tick rate scales with
 * the nearest fire: 1s under a minute out, 30s under an hour, 10m beyond.
 */
class LoopWidget implements Component {
	private timer?: ReturnType<typeof setTimeout>;
	private lastWidth = 80;
	constructor(
		private readonly tui: TUI,
		private readonly getLines: (width: number) => string[],
		private readonly getTickMs: () => number,
		private readonly onTick: () => void,
	) {
		this.scheduleTick();
	}
	render(width: number): string[] {
		this.lastWidth = width || this.lastWidth;
		return this.getLines(this.lastWidth);
	}
	invalidate() {
		/* render() is pure: reads live store + Date.now() each call; nothing cached. */
	}
	/** Re-render now and reschedule the adaptive tick. Called on mutations. */
	refresh() {
		this.scheduleTick();
		this.tui.requestRender();
		this.onTick();
	}
	private scheduleTick() {
		if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
		const lines = this.getLines(this.lastWidth);
		if (lines.length === 0) return; // nothing to count down -> timer stays cleared
		this.timer = setTimeout(() => {
			this.tui.requestRender();
			this.onTick();
			this.scheduleTick();
		}, Math.max(250, this.getTickMs()));
		this.timer.unref?.();
	}
	dispose() {
		if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
	}
}

export default function loopExtension(pi: ExtensionAPI) {
	let store = new LoopStore(loopFilePath(process.cwd()));
	const handles = new Map<string, Handle>();
	const firing = new Set<string>();
	// If a scheduled interval/cron occurrence arrives while the previous action is
	// still running, remember one coalesced catch-up fire. Dropping the overlapping
	// callback would otherwise leave interval loops permanently disarmed.
	const queuedFires = new Set<string>();
	// Persisted active loops never auto-start. Their ids remain here until the user
	// explicitly enables them for this session with `/loop enable` (or resumes one).
	const startupPending = new Set<string>();
	// Fires that happened while the agent was busy. Keyed by loop id, so repeated
	// fires of the same loop collapse to the latest — drained as ONE consolidated
	// turn at agent_settled. Prevents the flood of chained followUp turns during
	// long multi-turn runs (e.g. a goal skill).
	const pendingFires = new Map<string, { loop: Loop; firedAt: string; prompt: string; force: boolean }>();
	// Per-turn steer coalesce flag: at most one steer per turn window so a forced
	// (!) loop never bursts. Reset on turn_end.
	let steeredThisTurn = false;
	// Debounce timer for idle-state delivery: collects burst fires (e.g. many loops
	// created with the same interval firing in lockstep) into ONE consolidated
	// delivery. Fixes the flood where each fire saw isIdle()=true and sent immediately.
	let idleFlushTimer: ReturnType<typeof setTimeout> | undefined;
	const IDLE_FLUSH_MS = 50;
	let activeCtx: ExtensionContext | undefined;
	let loopWidget: LoopWidget | undefined;
	// Captured at widget mount so updateUI can force a render even if the widget
	// component hasn't been instantiated yet (otherwise setStatus wouldn't paint).
	let tuiRef: TUI | undefined;
	/** Render settings (user-global). Mutated via the Settings menu. */
	function widgetConfig(): RenderSettings {
		return getSettings();
	}
	function setWidgetConfig(cfg: RenderSettings) {
		void saveSettings(cfg);
		if (activeCtx) updateUI(activeCtx);
	}

	// ─── UI ────────────────────────────────────────────────────────────────────

	function updateUI(ctx = activeCtx) {
		if (!ctx?.hasUI) return;
		updateFooter(ctx);
		if (loopWidget) loopWidget.refresh();
		else tuiRef?.requestRender(); // ensure the footer status paints even before the widget mounts
	}

	/** Footer chip: "🔁 N loops · next Xm". Updated on every mutation and widget tick. */
	function updateFooter(ctx: ExtensionContext) {
		const theme = ctx.ui.theme;
		const pending = store.list().filter((l) => startupPending.has(l.id));
		const active = store.list().filter(
			(l) => l.enabled && l.status !== "done" && l.status !== "error" && !startupPending.has(l.id),
		);
		if (active.length === 0) {
			ctx.ui.setStatus(
				"loop",
				pending.length > 0 ? theme.fg("warning", `🔁 ${pending.length} saved · /loop enable`) : undefined,
			);
			return;
		}
		const next = earliestNextRun(active);
		const rel = next ? formatRelative(next, new Date()) : "";
		const cfg = widgetConfig();
		const pendingLabel = pending.length > 0 ? ` · ${pending.length} awaiting enable` : "";
		const chip = cfg.footerStyle === "verbose"
			? `🔁 ${active.length} loop${active.length === 1 ? "" : "s"}${rel ? ` · next ${rel}` : ""}`
			: `🔁 ${active.length}${rel ? ` · ${rel}` : ""}`;
		ctx.ui.setStatus("loop", theme.fg("accent", chip) + theme.fg("warning", pendingLabel));
	}

	/** Widget lines, laid out the Pi way (cf. custom-footer): fixed metadata columns +
	 * a flex title/payload slot that absorbs the remaining width. ANSI-aware via
	 * visibleWidth/truncateToWidth. Width is capped to widthPct of the terminal so the
	 * widget sits left-aligned and doesn't stretch across very wide terminals. */
	function widgetLines(theme: any, width: number): string[] {
		const visible = store.list();
		if (visible.length === 0) return [];
		const cfg = widgetConfig();
		// Cap width: widthPct of terminal, floored at 50 so narrow terminals stay usable.
		const w = Math.min(width, Math.max(50, Math.round(width * cfg.widthPct / 100)));
		const sorted = [...visible].sort((a, b) => {
			const order = { active: 0, paused: 1, error: 2, done: 3 } as const;
			if (order[a.status] !== order[b.status]) return order[a.status] - order[b.status];
			return (Date.parse(a.nextRun ?? "") || 0) - (Date.parse(b.nextRun ?? "") || 0);
		});
		const lines: string[] = [];
		for (const l of sorted) {
			const glyphColor = l.status === "done" ? "success" : l.status === "error" ? "error" : "accent";
			const glyph = theme.fg(glyphColor, statusGlyph(l));
			const awaitingEnable = startupPending.has(l.id);
			const live = l.enabled && l.status !== "done" && l.status !== "error" && !awaitingEnable;
			const nrText = awaitingEnable
				? "awaiting enable"
				: live
					? formatRelative(l.nextRun, new Date())
					: (l.status === "done" ? "done" : "paused");

			// Fixed metadata segments (plain text; themed after measuring). Hidden columns drop out.
			const metaParts: string[] = [];
			if (cfg.schedule) metaParts.push(loopScheduleLabel(l));
			if (cfg.countdown) metaParts.push(nrText);
			if (cfg.runs) metaParts.push(`×${l.runCount}`);
			if (cfg.action) metaParts.push(l.action);
			const metaPlain = metaParts.join("  ");
			const metaThemed = theme.fg("dim", metaPlain);

			// Marks: ! (forced) + ⏳ (buffered). Themed.
			const markThemed = (awaitingEnable ? " " + theme.fg("warning", "🔒") : "") + (l.force ? " " + theme.fg("warning", "!") : "") + (pendingFires.has(l.id) ? " " + theme.fg("warning", "⏳") : "");

			// Title/payload flex slot = whatever width remains.
			const indent = 2;
			const fixed = indent + visibleWidth(glyph) + 1 + visibleWidth(metaThemed) + 1 + visibleWidth(markThemed);
			const flex = Math.max(10, w - fixed);
			const slotPlain = loopPayloadRaw(l) || "(no payload)";
			const title = l.name ? truncateToWidth(l.name, flex, "…", true) : truncateToWidth(slotPlain, flex, "…", true);
			const slotThemed = theme.fg("accent", title);

			const raw = `${" ".repeat(indent)}${glyph} ${slotThemed} ${metaThemed}${markThemed}`;
			lines.push(truncateToWidth(raw, w));
		}
		return lines;
	}

	/** Adaptive tick: 1s when a fire is <1m away, 30s under an hour, 10m beyond. */
	function computeTickMs(): number {
		const active = store.list().filter((l) => l.enabled && l.nextRun && !startupPending.has(l.id));
		if (active.length === 0) return 60_000;
		const nearest = Math.min(...active.map((l) => Date.parse(l.nextRun!) - Date.now()));
		if (nearest < 60_000) return 1000;
		if (nearest < 3_600_000) return 30_000;
		return 600_000;
	}

	function earliestNextRun(loops: Loop[]): string | undefined {
		let best: number | undefined;
		for (const l of loops) {
			if (!l.nextRun) continue;
			const t = Date.parse(l.nextRun);
			if (Number.isFinite(t) && (best === undefined || t < best)) best = t;
		}
		return best !== undefined ? new Date(best).toISOString() : undefined;
	}
	// ─── Scheduling (arm/disarm/reschedule) ────────────────────────────────────

	function disarm(id: string) {
		const h = handles.get(id);
		if (!h) return;
		if (h.kind === "cron") h.handle.stop();
		else clearTimeout(h.handle);
		handles.delete(id);
	}

	function disarmAll() {
		for (const id of [...handles.keys()]) disarm(id);
	}

	/** Schedule a timeout for an absolute deadline, preserving deadlines beyond Node's timer cap. */
	function scheduleAt(loop: Loop, ctx: ExtensionContext, dueAt: number) {
		disarm(loop.id);
		const remaining = Math.max(0, dueAt - Date.now());
		const timer = setTimeout(() => {
			handles.delete(loop.id);
			const current = store.get(loop.id);
			if (!current || !current.enabled || current.status === "done" || current.status === "error") return;
			if (Date.now() < dueAt) {
				scheduleAt(current, ctx, dueAt);
				return;
			}
			void fire(loop.id, ctx);
		}, Math.min(remaining, MAX_TIMER_DELAY_MS));
		timer.unref?.();
		handles.set(loop.id, { kind: "timeout", handle: timer });
		store.update(loop.id, { nextRun: new Date(dueAt).toISOString() });
	}

	/** Arm (or re-arm) a loop. Restored interval/once loops may retain their persisted deadline. */
	function arm(loop: Loop, ctx: ExtensionContext, preserveNextRun = false) {
		if (!loop.enabled || loop.status === "done" || loop.status === "error") return;
		const parsed = safeParsed(loop);
		if (!parsed) {
			store.update(loop.id, { status: "error", enabled: false, lastError: "invalid schedule" });
			return;
		}
		disarm(loop.id);

		if (parsed.type === "cron") {
			try {
				// protect:true + our firing-set guard = belt and suspenders against overlap.
				const cron = new Cron(
					parsed.schedule,
					{ protect: true },
					() => void fire(loop.id, ctx),
				);
				const next = cron.nextRun();
				handles.set(loop.id, { kind: "cron", handle: cron });
				if (next) {
					store.update(loop.id, { nextRun: next.toISOString() });
				}
			} catch {
				store.update(loop.id, { status: "error", enabled: false, lastError: "invalid cron" });
			}
			return;
		}

		// Interval or once. On startup approval, keep the persisted absolute deadline
		// so restarting does not postpone relative schedules such as `+10m`.
		const persisted = preserveNextRun && loop.nextRun ? Date.parse(loop.nextRun) : Number.NaN;
		const dueAt = Number.isFinite(persisted) ? persisted : nextRun(parsed, new Date()).getTime();
		scheduleAt(loop, ctx, dueAt);
	}

	// ─── Firing ────────────────────────────────────────────────────────────────

	async function fire(id: string, ctx: ExtensionContext, manual = false): Promise<void> {
		const loop = store.get(id);
		if (!loop || loop.status === "done" || loop.status === "error") return;
		if (!manual && !loop.enabled) return; // pause stops the schedule, not a manual "run now"
		if (firing.has(id)) {
			if (!manual) queuedFires.add(id); // coalesce missed scheduled occurrences into one catch-up fire
			return;
		}
		firing.add(id);
		try {
			const now = new Date();
			const plan = planFire(loop, now);

			// Re-arm the NEXT run BEFORE executing the action. A throw or crash
			// during execute must not lose the recurrence. For cron, croner
			// re-fires on its own; we only stop it if terminal.
			if (plan.terminal) {
				disarm(id);
			} else if (loop.enabled && loop.type === "interval" && plan.nextDelayMs !== undefined) {
				scheduleAt(loop, ctx, now.getTime() + plan.nextDelayMs);
			} else if (loop.enabled && loop.type === "cron") {
				const handle = handles.get(id);
				const next = handle?.kind === "cron" ? handle.handle.nextRun() : null;
				if (next) store.update(id, { nextRun: next.toISOString() });
			}

			store.update(id, { runCount: plan.runCount, lastRun: now.toISOString() });

			// Execute the action.
			let ok = true;
			let errMsg: string | undefined;
			try {
				await executeAction(loop, ctx);
			} catch (err) {
				ok = false;
				errMsg = err instanceof Error ? err.message : String(err);
				record(ctx, `â  Loop "${displayName(loop)}" failed: ${errMsg}`, { loop, error: errMsg });
			}

			// Finalize state.
			if (plan.terminal) {
				// Finished its life (once fired, or maxFires reached) → remove it.
				// The widget shows only active/pending work; the fire's outcome was
				// already recorded in the transcript above.
				disarm(id);
				store.remove(id);
			} else {
				store.update(id, {
					lastStatus: ok ? "success" : "error",
					lastError: errMsg,
				});
			}
			void store.persist();
			updateUI(ctx);
		} finally {
			firing.delete(id);
			if (queuedFires.delete(id)) {
				const current = store.get(id);
				if (current?.enabled && current.status !== "done" && current.status !== "error") {
					void fire(id, ctx);
				}
			}
		}
	}

	async function executeAction(loop: Loop, ctx: ExtensionContext): Promise<void> {
		const label = displayName(loop);

		if (loop.action === "notify") {
			const message = loop.message || `🔔 ${label}`;
			if (ctx.hasUI) ctx.ui.notify(message, "info");
			record(ctx, `🔔 ${message}`, { loop });
			return;
		}

		if (loop.action === "prompt") {
			const prompt = wrapScheduled(loop.prompt || "");
			sendAgentPrompt(ctx, loop, prompt);
			return;
		}

		if (loop.action === "message") {
			const message = loop.message || `⏰ ${label}`;
			const triggerTurn = loop.triggerTurn !== false; // default true
			pi.sendMessage(
				{ customType: "loop-fire", content: message, display: true, details: { loop } },
				{ triggerTurn },
			);
			return;
		}

		if (loop.action === "shell") {
			const cwd = loop.cwd || ctx.cwd;
			const timeout = loop.timeoutMs ?? DEFAULT_SHELL_TIMEOUT_MS;
			const shellMode = loop.shellMode ?? "notify-output";
			if (shellMode === "verbose" && ctx.hasUI) ctx.ui.notify(`▶ ${label}: ${loop.command}`, "info");
			const result = await pi.exec("bash", ["-lc", loop.command || ""], { cwd, timeout });
			const summary = {
				command: loop.command,
				cwd,
				code: result.code,
				killed: result.killed,
				ok: result.code === 0 && !result.killed,
				stdout: truncateMiddle(result.stdout, MAX_OUTPUT_CHARS),
				stderr: truncateMiddle(result.stderr, MAX_OUTPUT_CHARS),
			};
			if (shellMode === "verbose") {
				record(ctx, `▣ ${label}: exit ${result.code}`, { loop, result: summary });
			} else if (shellMode === "notify-output" && summary.ok && summary.stdout.trim()) {
				const output = summary.stdout.trim();
				if (ctx.hasUI) ctx.ui.notify(output, "info");
				record(ctx, `🔔 ${truncateMiddle(output, 2_000)}`, {
					loopId: loop.id,
					result: { code: result.code, killed: result.killed },
				});
			}
			if (loop.followUpPrompt) {
				const block = [
					"A scheduled shell command completed.",
					"",
					`Command: \`${loop.command}\``,
					`CWD: \`${cwd}\``,
					`Exit code: ${result.code}${result.killed ? " (killed/timeout)" : ""}`,
					"",
					"STDOUT:",
					"```",
					summary.stdout,
					"```",
					"STDERR:",
					"```",
					summary.stderr,
					"```",
					"",
					loop.followUpPrompt,
				].join("\n");
				sendAgentPrompt(ctx, loop, wrapScheduled(block));
			}
			if (!summary.ok) {
				throw new Error(
					result.killed
						? `Shell command timed out or was killed (exit ${result.code})`
						: `Shell command exited with code ${result.code}`,
				);
			}
			return;
		}

		throw new Error(`Unsupported action: ${loop.action}`);
	}

	/**
	 * Wrap a loop's payload so the agent attributes it correctly: an automated
	 * scheduled trigger, NOT a user message. The tag is the semantic boundary;
	 * the one sentence is the irreducible attribution fix. Payload carries intent.
	 * (No metadata/priority/urgency invented — that's for the transcript, not the agent.)
	 */
	function wrapScheduled(payload: string): string {
		return `<scheduled_trigger>\nAutomated scheduled trigger — not a message from the user.\n\n${payload}\n</scheduled_trigger>`;
	}

	function sendAgentPrompt(ctx: ExtensionContext, loop: Loop, prompt: string) {
		// ALWAYS buffer (keyed by loop id → repeated fires of the same loop coalesce).
		pendingFires.set(loop.id, { loop, firedAt: new Date().toISOString(), prompt, force: !!loop.force });
		updateUI(ctx);
		if (loop.force) {
			maybeSteer(ctx); // forced (!): steer at the next tool-call boundary
			return;
		}
		// Default: deliver consolidated. If busy, agent_settled drains; if idle, a tiny
		// debounce collects burst fires into ONE delivery instead of N (the lockstep race).
		scheduleIdleFlush(ctx);
	}

	/** Collect burst fires into one consolidated delivery when idle. */
	function scheduleIdleFlush(ctx: ExtensionContext) {
		if (idleFlushTimer) return; // already scheduled — siblings join this flush
		idleFlushTimer = setTimeout(() => {
			idleFlushTimer = undefined;
			if (ctx.isIdle()) drainPending(ctx); // else: leave buffered for agent_settled
		}, IDLE_FLUSH_MS);
		idleFlushTimer.unref?.();
	}

	/** Coalesced steer for forced (!) loops: at most one steer per turn window. */
	function maybeSteer(ctx: ExtensionContext) {
		if (steeredThisTurn) return;
		const forced = [...pendingFires.values()].filter((e) => e.force);
		if (forced.length === 0) return;
		for (const e of forced) pendingFires.delete(e.loop.id); // delivered via steer
		steeredThisTurn = true;
		updateUI(ctx);
		const body = forced.map((e) => e.prompt).join("\n\n---\n\n");
		pi.sendUserMessage(body, { deliverAs: "steer" });
	}

	/** Drain buffered (default-deferred) fires as ONE consolidated user message. Called at agent_settled. */
	function drainPending(ctx: ExtensionContext) {
		if (pendingFires.size === 0) return;
		if (!ctx.isIdle()) return; // another extension started a run; wait for next settle
		const entries = [...pendingFires.values()];
		pendingFires.clear();
		updateUI(ctx);
		const body = entries.map((e) => e.prompt).join("\n\n---\n\n");
		pi.sendUserMessage(body);
	}

	function record(ctx: ExtensionContext, content: string, details?: Record<string, unknown>) {
		pi.sendMessage({ customType: "loop-fire", content, display: true, details }, { triggerTurn: false });
	}

	// ─── Create helper ─────────────────────────────────────────────────────────

	function createLoop(params: {
		action: ActionType;
		type?: ScheduleType;
		schedule: string;
		name?: string;
		prompt?: string;
		message?: string;
		command?: string;
		cwd?: string;
		timeoutMs?: number;
		shellMode?: ShellMode;
		followUpPrompt?: string;
		triggerTurn?: boolean;
		force?: boolean;
		enabled?: boolean;
		maxFires?: number;
	}, ctx: ExtensionContext): Loop {
		const type = params.type ?? inferType(params.schedule);
		const parsed = validateSchedule(type, params.schedule, new Date());
		// payload validation per action
		if (params.action === "prompt" && !(params.prompt?.trim())) throw new Error("prompt is required for action 'prompt'");
		if (params.action === "notify" && !(params.message?.trim())) throw new Error("message is required for action 'notify'");
		if (params.action === "message" && !(params.message?.trim())) throw new Error("message is required for action 'message'");
		if (params.action === "shell" && !(params.command?.trim())) throw new Error("command is required for action 'shell'");
		if (params.maxFires !== undefined && (!Number.isInteger(params.maxFires) || params.maxFires < 1)) {
			throw new Error("maxFires must be a positive integer");
		}
		if (params.timeoutMs !== undefined && (!Number.isFinite(params.timeoutMs) || params.timeoutMs < 1000)) {
			throw new Error("timeoutMs must be at least 1000");
		}

		// Defense-in-depth: a very short interval with no maxFires is almost always a
		// test/spam footgun (fires forever, rapidly). Warn — don't block.
		if (
			parsed.type === "interval" &&
			parsed.intervalMs !== undefined &&
			parsed.intervalMs < 10_000 &&
			params.maxFires === undefined
		) {
			ctx.ui.notify(
				`Interval ${params.schedule} has no maxFires — it will fire rapidly forever. Set maxFires or use a longer interval.`,
				"warning",
			);
		}

		const id = newId();
		// Derive a human-readable name from the payload when none is given, so
		// one-liner creates (`/loop 5m check the build`) are targetable by name.
		// name is opt-in: undefined unless the user set a title. Display falls back to payload.
		const name = params.name?.trim() || undefined;
		const loop = store.add(
			{
				name,
				action: params.action,
				type: parsed.type,
				schedule: parsed.schedule,
				intervalMs: parsed.intervalMs,
				prompt: params.prompt,
				message: params.message,
				command: params.command,
				cwd: params.cwd ?? ctx.cwd,
					timeoutMs: params.timeoutMs,
					shellMode: params.shellMode,
					followUpPrompt: params.followUpPrompt,
				triggerTurn: params.triggerTurn,
				force: params.force,
				enabled: params.enabled,
				maxFires: params.maxFires,
			},
			id,
		);
		arm(loop, ctx);
		updateUI(ctx);
		return loop;
	}

	// Reset the per-turn steer coalesce flag so forced (!) loops can steer again next turn.
	pi.on("turn_end", async () => {
		steeredThisTurn = false;
		if (activeCtx) maybeSteer(activeCtx);
	});

	// Drain buffered (default-deferred) fires as one consolidated turn when the
	// agent truly settles. Forced (!) loops are steered mid-run (see maybeSteer).
	pi.on("agent_settled", async (_event, ctx) => {
		steeredThisTurn = false;
		drainPending(ctx);
	});

	pi.on("session_start", async (_event, ctx) => {
		store = new LoopStore(loopFilePath(ctx.cwd));
		await store.load();
		await loadSettings();
		disarmAll();
		queuedFires.clear();
		startupPending.clear();
		for (const loop of store.list()) {
			if (loop.enabled && loop.status !== "done" && loop.status !== "error") startupPending.add(loop.id);
		}
		pendingFires.clear();
		if (idleFlushTimer) { clearTimeout(idleFlushTimer); idleFlushTimer = undefined; }
		activeCtx = ctx;
		// Mount the widget ONCE via the factory form. The component reads the live
		// store at render time and self-ticks adaptively — no more setWidget churn.
		if (ctx.hasUI) {
			ctx.ui.setWidget(
				"loop",
				(tui, theme) => {
					tuiRef = tui;
					loopWidget = new LoopWidget(
						tui,
						(width) => widgetLines(theme, width),
						() => computeTickMs(),
						() => { if (activeCtx) updateFooter(activeCtx); },
					);
					return loopWidget;
				},
				{ placement: "belowEditor" },
			);
		}
		updateUI(ctx);
		if (ctx.hasUI && startupPending.size > 0) {
			ctx.ui.notify(
				`${startupPending.size} saved loop${startupPending.size === 1 ? " is" : "s are"} waiting. Use /loop enable to start ${startupPending.size === 1 ? "it" : "them"}.`,
				"warning",
			);
		}
	});

	// Compaction only rewrites conversation context; this extension instance and
	// its timer handles remain live. Refreshing the UI makes that invariant visible.
	pi.on("session_compact", async (_event, ctx) => {
		await store.persist();
		updateUI(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		pendingFires.clear();
		queuedFires.clear();
		startupPending.clear();
		loopWidget?.dispose();
		loopWidget = undefined;
		disarmAll();
		await store.persist(); // flush write-through mirror before exit
		if (ctx.hasUI) {
			ctx.ui.setStatus("loop", undefined);
			ctx.ui.setWidget("loop", undefined);
		}
		activeCtx = undefined;
	});

	// ─── Renderer for transcript entries ───────────────────────────────────────

	pi.registerMessageRenderer("loop-fire", (message, options, theme) => {
		let text = `${theme.fg("accent", theme.bold("loop"))} ${message.content}`;
		if (options.expanded && message.details) {
			text += `\n${theme.fg("dim", JSON.stringify(message.details, null, 2))}`;
		}
		return new Text(text, 0, 0);
	});

	// ─── Verb grammar ─────────────────────────────────────────────────────────
	// First token of `/loop <args>` decides intent:
	//   control verb (pause/resume/delete/remove/run) → control op
	//   action verb (prompt/notify/shell/message)      → create with that action
	//   else                                            → prompt action, schedule-first
	// Cron schedules contain spaces → quote them: /loop "*/5 * * * *" check the build
	const ACTION_VERBS = new Set<ActionType>(["prompt", "notify", "shell", "message"]);
	const CONTROL_VERBS = new Set<string>(["enable", "pause", "resume", "delete", "remove", "run"]);

	/** Quote-aware tokens with source spans. Payloads are sliced from the original input so shell quoting survives. */
	function tokenize(s: string): Array<{ value: string; start: number; end: number }> {
		const out: Array<{ value: string; start: number; end: number }> = [];
		let i = 0;
		while (i < s.length) {
			while (i < s.length && /\s/.test(s[i])) i++;
			if (i >= s.length) break;
			const start = i;
			let value = "";
			let quote: '"' | "'" | undefined;
			while (i < s.length) {
				const c = s[i];
				if (quote) {
					if (c === quote) { quote = undefined; i++; continue; }
					if (c === "\\" && quote === '"' && i + 1 < s.length) { value += s[i + 1]; i += 2; continue; }
					value += c;
					i++;
					continue;
				}
				if (c === '"' || c === "'") { quote = c; i++; continue; }
				if (/\s/.test(c)) break;
				if (c === "\\" && i + 1 < s.length) { value += s[i + 1]; i += 2; continue; }
				value += c;
				i++;
			}
			out.push({ value, start, end: i });
		}
		return out;
	}

	/** Resolve a name/id query to one loop. Empty query targets the sole active loop, if unique. */
	function resolveQuery(ctx: ExtensionContext, query: string): Loop | undefined {
		if (query) {
			const loop = store.find(query);
			if (!loop) ctx.ui.notify(`No unique loop matching "${query}".`, "warning");
			return loop;
		}
		const visible = store.list().filter((l) => l.status !== "done" && l.status !== "error");
		if (visible.length === 1) return visible[0];
		if (visible.length === 0) ctx.ui.notify("No loops to act on.", "warning");
		else ctx.ui.notify("Multiple loops — specify a name or id.", "warning");
		return undefined;
	}

	// Shared control ops — used by both the CLI verbs and the interactive menu.
	function enablePendingLoops(ctx: ExtensionContext, loops?: Loop[]) {
		const candidates = (loops ?? store.list()).filter((loop) => startupPending.has(loop.id));
		for (const loop of candidates) {
			startupPending.delete(loop.id);
			if (loop.enabled && loop.status !== "done" && loop.status !== "error") arm(loop, ctx, true);
		}
		updateUI(ctx);
		if (candidates.length === 0) {
			ctx.ui.notify("No saved loops are waiting to be enabled.", "info");
		} else {
			ctx.ui.notify(
				`Enabled ${candidates.length} saved loop${candidates.length === 1 ? "" : "s"} for this session.`,
				"info",
			);
		}
	}

	function pauseLoop(loop: Loop, ctx: ExtensionContext) {
		disarm(loop.id);
		startupPending.delete(loop.id);
		queuedFires.delete(loop.id);
		pendingFires.delete(loop.id);
		store.update(loop.id, { enabled: false, status: "paused", nextRun: undefined });
		void store.persist();
		updateUI(ctx);
		ctx.ui.notify(`Paused "${displayName(loop)}"`, "info");
	}
	function resumeLoop(loop: Loop, ctx: ExtensionContext) {
		const preserveNextRun = startupPending.delete(loop.id);
		const updated = store.update(loop.id, { enabled: true, status: "active" })!;
		arm(updated, ctx, preserveNextRun);
		updateUI(ctx);
		ctx.ui.notify(`Resumed "${displayName(loop)}"`, "info");
	}
	function deleteLoop(loop: Loop, ctx: ExtensionContext) {
		disarm(loop.id);
		startupPending.delete(loop.id);
		queuedFires.delete(loop.id);
		pendingFires.delete(loop.id);
		store.remove(loop.id);
		updateUI(ctx);
		ctx.ui.notify(`Deleted "${displayName(loop)}"`, "info");
	}
	function runLoopNow(loop: Loop, ctx: ExtensionContext) {
		ctx.ui.notify(`Firing "${displayName(loop)}" now…`, "info");
		void fire(loop.id, ctx, true); // manual: fires even while paused, without un-pausing
	}

	async function controlLoop(verb: string, query: string, ctx: ExtensionContext) {
		if (verb === "enable" && !query) return enablePendingLoops(ctx);
		const loop = resolveQuery(ctx, query);
		if (!loop) return;
		if (verb === "enable") {
			if (startupPending.has(loop.id)) return enablePendingLoops(ctx, [loop]);
			if (!loop.enabled) return resumeLoop(loop, ctx);
			ctx.ui.notify(`"${displayName(loop)}" is already enabled`, "info");
			return;
		}
		if (verb === "pause") return pauseLoop(loop, ctx);
		if (verb === "resume") {
			if (startupPending.has(loop.id)) return resumeLoop(loop, ctx);
			if (loop.enabled) { ctx.ui.notify(`"${displayName(loop)}" is already active`, "info"); return; }
			return resumeLoop(loop, ctx);
		}
		if (verb === "delete" || verb === "remove") return deleteLoop(loop, ctx);
		if (verb === "run") return runLoopNow(loop, ctx);
	}

	/** Disarm + arm, recomputing nextRun. Used after edits that change scheduling. */
	function rearm(loop: Loop, ctx: ExtensionContext) {
		disarm(loop.id);
		if (
			loop.enabled &&
			loop.status !== "done" &&
			loop.status !== "error" &&
			!startupPending.has(loop.id)
		) arm(loop, ctx);
		updateUI(ctx);
	}

	/** Interactive field editor — pick a field, change it, loop until Done. */
	async function editLoop(initial: Loop, ctx: ExtensionContext) {
		let loop = initial;
		while (true) {
			// Snapshot current values so the picker reflects the latest state each loop.
			const schedLabel = loopScheduleLabel(loop);
			const payloadLabel = (() => {
				const raw = (loop.prompt ?? loop.message ?? loop.command ?? "").replace(/\n/g, " ").trim();
				return raw.length > 30 ? `${raw.slice(0, 27)}…` : raw || "(empty)";
			})();
			const fields = [
				`Schedule       ${schedLabel}`,
				`Force (!)      ${loop.force ? "on" : "off"}`,
				`Payload        ${payloadLabel}`,
				...(loop.action === "shell" ? [`Shell reporting ${loop.shellMode ?? "notify-output"}`] : []),
				`Name           ${loop.name ?? "(none)"}`,
				`Max fires      ${loop.maxFires ? String(loop.maxFires) : "forever"}`,
				"Done",
			];
			const choice = await ctx.ui.select(`Edit ${displayName(loop)}`, fields);
			if (!choice || choice === "Done") return;

			try {
				if (choice.startsWith("Schedule")) {
					const typeChoice = await ctx.ui.select("Schedule type", [
						`Interval (current: ${loop.type === "interval" ? "yes" : "no"})`,
						`Once (current: ${loop.type === "once" ? "yes" : "no"})`,
						`Cron (current: ${loop.type === "cron" ? "yes" : "no"})`,
					]);
					if (!typeChoice) continue;
					const type = typeChoice.split(" ")[0].toLowerCase() as ScheduleType;
					let ph = "";
					let schedule = "";
					while (true) {
						ph = type === "interval" ? "e.g. 5m, 1h, 30s" : type === "once" ? "e.g. +10m, tomorrow 9am" : "e.g. */5 * * * *";
						schedule = (await ctx.ui.input(`Schedule (current: ${loop.schedule})`, ph)) ?? "";
						if (!schedule) { schedule = ""; break; }
						try { validateSchedule(type, schedule.trim()); schedule = schedule.trim(); break; }
						catch (e) { ph = e instanceof Error ? e.message : "Invalid schedule"; }
					}
					if (schedule) {
						const parsed = validateSchedule(type, schedule, new Date());
						const updated = store.update(loop.id, {
							type: parsed.type,
							schedule: parsed.schedule,
							intervalMs: parsed.intervalMs,
							nextRun: undefined,
						})!;
						loop = updated;
						rearm(loop, ctx);
						ctx.ui.notify(`Schedule → ${loopScheduleLabel(loop)}`, "info");
					}
				} else if (choice.startsWith("Force")) {
					const next = !loop.force;
					loop = store.update(loop.id, { force: next })!;
					ctx.ui.notify(`Force ${next ? "on (!)" : "off"}`, "info");
				} else if (choice.startsWith("Payload")) {
					const field = loop.action === "shell" ? "command" : loop.action === "notify" || loop.action === "message" ? "message" : "prompt";
					const title = field === "command" ? "Shell command" : field === "message" ? "Message text" : "Prompt";
					const edited = await ctx.ui.editor(title, loop[field] ?? "");
					if (edited === undefined) continue;
					loop = store.update(loop.id, { [field]: edited } as Partial<Loop>)!;
					ctx.ui.notify("Payload updated", "info");
				} else if (choice.startsWith("Shell reporting")) {
					const selected = await ctx.ui.select("Shell reporting", [
						"Notify on stdout — silent checks; notify when stdout is non-empty",
						"Quiet — suppress successful checks and output",
						"Verbose — show the command and every result",
					]);
					if (!selected) continue;
					const shellMode: ShellMode = selected.startsWith("Notify")
						? "notify-output"
						: selected.startsWith("Quiet")
							? "quiet"
							: "verbose";
					loop = store.update(loop.id, { shellMode })!;
					ctx.ui.notify(`Shell reporting → ${shellMode}`, "info");
				} else if (choice.startsWith("Name")) {
					const edited = await ctx.ui.input("Name", loop.name ?? "");
					if (edited === undefined) continue;
					loop = store.update(loop.id, { name: edited.trim() || undefined })!;
					ctx.ui.notify("Name updated", "info");
				} else if (choice.startsWith("Max fires")) {
					const raw = await ctx.ui.input("Max fires (empty = forever)", loop.maxFires ? String(loop.maxFires) : "");
					if (raw === undefined) continue;
					const n = raw.trim() === "" ? undefined : Number(raw);
					if (raw.trim() !== "" && (!Number.isInteger(n) || (n as number) <= 0)) {
						ctx.ui.notify("Max fires must be a positive integer", "warning");
						continue;
					}
					loop = store.update(loop.id, { maxFires: n as number | undefined, runCount: 0 })!;
					rearm(loop, ctx);
					ctx.ui.notify(`Max fires → ${n ?? "forever"} (run count reset)`, "info");
				}
				void store.persist();
				updateUI(ctx);
			} catch (err) {
				ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
			}
		}
	}

	// ─── Commands ──────────────────────────────────────────────────────────────

	pi.registerCommand("loop", {
		description: "Create or control scheduled loops. With no args, opens the manager.",
		handler: async (args, ctx) => {
			let trimmed = args.trim();
			// `!` prefix → forced loop (steer at next tool-call boundary when busy, vs defer to agent_settled).
			let force = false;
			if (trimmed.startsWith("!")) {
				force = true;
				trimmed = trimmed.slice(1).trimStart();
			}
			if (!trimmed) return manage(ctx); // wizard

			const tokens = tokenize(trimmed);
			const verb = tokens[0].value.toLowerCase();

			// Control verbs: /loop pause|resume|delete|remove|run [name|id]
			if (CONTROL_VERBS.has(verb)) {
				return controlLoop(verb, tokens.slice(1).map((token) => token.value).join(" ").trim(), ctx);
			}

			// Optional action verb: /loop prompt|notify|shell|message <schedule> <payload>
			let action: ActionType = "prompt";
			let scheduleIndex = 0;
			if (ACTION_VERBS.has(verb as ActionType)) {
				action = verb as ActionType;
				scheduleIndex = 1;
				if (tokens.length === 1) {
					ctx.ui.notify(`Usage: /loop ${verb} <schedule> <payload>`, "warning");
					return;
				}
			}

			// Schedule is one decoded token; payload is the untouched remainder so shell
			// quotes, escapes, substitutions, and redirects retain their intended meaning.
			if (tokens.length < scheduleIndex + 2) {
				ctx.ui.notify("Usage: /loop [action] <schedule> <payload>", "warning");
				return;
			}
			const schedule = tokens[scheduleIndex].value;
			const payload = trimmed.slice(tokens[scheduleIndex + 1].start).trim();

			try {
				const params: Parameters<typeof createLoop>[0] = { action, schedule, force };
				if (action === "prompt") params.prompt = payload;
				else if (action === "notify" || action === "message") params.message = payload;
				else if (action === "shell") params.command = payload;
				const loop = createLoop(params, ctx);
				ctx.ui.notify(`Created ${action} loop "${displayName(loop)}" (${loopScheduleLabel(loop)})${force ? " [forced]" : ""}`, "info");
			} catch (err) {
				ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
			}
		},
	});

	async function manage(ctx: ExtensionContext) {
		const choices = ["Add a loop…", "List / manage…", "Settings…"];
		if (startupPending.size > 0) choices.push("Enable saved loops");
		choices.push("Pause all", "Resume all", "Clear all");
		const choice = await ctx.ui.select("Loops", choices);
		if (!choice) return;
		if (choice === "Add a loop…") return addLoop(ctx);
		if (choice === "List / manage…") return manageOne(ctx);
		if (choice === "Settings…") return widgetSettings(ctx);
		if (choice === "Enable saved loops") return enablePendingLoops(ctx);
		if (choice === "Pause all") {
			for (const l of store.list()) {
				if (l.enabled) {
					disarm(l.id);
					startupPending.delete(l.id);
					queuedFires.delete(l.id);
					pendingFires.delete(l.id);
					store.update(l.id, { enabled: false, status: "paused", nextRun: undefined });
				}
			}
			void store.persist();
			updateUI(ctx);
			ctx.ui.notify("All loops paused", "info");
			return;
		}
		if (choice === "Resume all") {
			for (const l of store.list()) {
				if (!l.enabled && l.status !== "done" && l.status !== "error") {
					store.update(l.id, { enabled: true, status: "active" });
					arm(store.get(l.id)!, ctx);
				}
			}
			updateUI(ctx);
			ctx.ui.notify("All loops resumed", "info");
			return;
		}
		if (choice === "Clear all") {
			const ok = await ctx.ui.confirm("Clear all loops?", "This removes every loop. Cannot be undone.");
			if (!ok) return;
			disarmAll();
			startupPending.clear();
			queuedFires.clear();
			pendingFires.clear();
			store.clear();
			updateUI(ctx);
			ctx.ui.notify("All loops cleared", "info");
		}
	}

	async function addLoop(ctx: ExtensionContext) {
		// 1. Action
		const actionChoice = await ctx.ui.select("What should the loop do?", [
			"Prompt — wake the agent with a prompt",
			"Notify — show a reminder (no agent wake)",
			"Shell — run a command on a schedule",
			"Message — post a message in the transcript",
		]);
		if (!actionChoice) return;
		const actionMap: Record<string, ActionType> = {
			"Prompt — wake the agent with a prompt": "prompt",
			"Notify — show a reminder (no agent wake)": "notify",
			"Shell — run a command on a schedule": "shell",
			"Message — post a message in the transcript": "message",
		};
		const action = actionMap[actionChoice];

		// 2. Schedule type
		const typeChoice = await ctx.ui.select("Schedule type", [
			"Interval — every N minutes/hours",
			"Once — one-shot at a time",
			"Cron — cron expression",
		]);
		if (!typeChoice) return;
		const typeMap: Record<string, ScheduleType> = {
			"Interval — every N minutes/hours": "interval",
			"Once — one-shot at a time": "once",
			"Cron — cron expression": "cron",
		};
		const type = typeMap[typeChoice];

		// 3. Schedule value (re-prompt on validation error)
		const placeholder: Record<ScheduleType, string> = {
			interval: "e.g. 5m, 1h, 30s, 2h",
			once: "e.g. +10m, tomorrow 9am, 2026-01-01T09:00",
			cron: "e.g. */5 * * * * (every 5 min), 0 9 * * 1-5 (9am weekdays)",
		};
		let schedule: string | undefined;
		let ph = placeholder[type];
		while (true) {
			schedule = await ctx.ui.input("Schedule", ph);
			if (!schedule) return; // cancel
			try {
				validateSchedule(type, schedule.trim());
				schedule = schedule.trim();
				break;
			} catch (err) {
				ph = err instanceof Error ? err.message : "Invalid schedule";
			}
		}

		// 4. Payload per action
		let prompt: string | undefined;
		let message: string | undefined;
		let command: string | undefined;
		let shellMode: ShellMode | undefined;
		let followUpPrompt: string | undefined;
		if (action === "prompt") {
			prompt = await ctx.ui.input("Prompt", "What should the agent do when this fires?");
			if (!prompt) return;
		} else if (action === "notify") {
			message = await ctx.ui.input("Reminder text", "e.g. Standup in 5 minutes");
			if (!message) return;
		} else if (action === "message") {
			message = await ctx.ui.input("Message", "Text to post in the transcript");
			if (!message) return;
		} else {
			command = await ctx.ui.input("Shell command", "e.g. npm test");
			if (!command) return;
			const reporting = await ctx.ui.select("Shell reporting", [
				"Notify on stdout — silent checks; notify when stdout is non-empty",
				"Quiet — suppress successful checks and output",
				"Verbose — show the command and every result",
			]);
			if (!reporting) return;
			shellMode = reporting.startsWith("Notify")
				? "notify-output"
				: reporting.startsWith("Quiet")
					? "quiet"
					: "verbose";
			followUpPrompt = (await ctx.ui.input("Follow-up prompt (optional, Enter to skip)", "Wake the agent with the output?")) || undefined;
		}

		// 5. Name (optional)
		const name = (await ctx.ui.input("Name (optional)", "e.g. build-check")) || undefined;

		// 6. maxFires for recurring (optional)
		let maxFires: number | undefined;
		if (type !== "once") {
			const raw = await ctx.ui.input("Max fires (optional, Enter = run forever)", "e.g. 20");
			if (raw) {
				const n = Number(raw);
				if (Number.isInteger(n) && n > 0) maxFires = n;
			}
		}

		// Force (!): steer the fire in at the next tool-call boundary when the agent is busy,
		// instead of deferring to the end of the run.
		let force = false;
		if (action === "prompt" || action === "shell" || action === "message") {
			force = await ctx.ui.confirm(
				"Force interrupt?",
				"If the agent is busy when this fires, inject at the next tool-call boundary (!) instead of waiting for it to finish.",
			);
		}

		try {
			const loop = createLoop(
				{ action, type, schedule, name, prompt, message, command, shellMode, followUpPrompt, maxFires, force },
				ctx,
			);
			ctx.ui.notify(`Created loop "${displayName(loop)}" (${loopScheduleLabel(loop)})`, "info");
		} catch (err) {
			ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
		}
	}

	/** Render settings (user-global): width, footer style, column toggles. */
	async function widgetSettings(ctx: ExtensionContext) {
		const cfg = { ...widgetConfig() };
		const cols: Array<["schedule" | "countdown" | "runs" | "action", string]> = [
			["schedule", "Schedule"],
			["countdown", "Countdown"],
			["runs", "Run count"],
			["action", "Action"],
		];
		while (true) {
			const items: string[] = [];
			items.push(`Width: ${cfg.widthPct}% of terminal`);
			items.push(`Footer: ${cfg.footerStyle}`);
			for (const [k, label] of cols) items.push(`${label}: ${cfg[k] ? "shown" : "hidden"}`);
			items.push("Back");
			const choice = await ctx.ui.select("Loop rendering (user-global)", items);
			if (!choice || choice === "Back") return;
			if (choice.startsWith("Width:")) {
				const raw = await ctx.ui.input("Widget width (% of terminal, 1-100)", String(cfg.widthPct));
				if (raw === undefined) continue;
				const n = Number(raw);
				if (Number.isInteger(n) && n >= 1 && n <= 100) { cfg.widthPct = n; setWidgetConfig(cfg); }
				else ctx.ui.notify("Width must be an integer 1-100", "warning");
				continue;
			}
			if (choice.startsWith("Footer:")) {
				cfg.footerStyle = cfg.footerStyle === "compact" ? "verbose" : "compact";
				setWidgetConfig(cfg);
				continue;
			}
			const hit = cols.find(([k, label]) => choice.startsWith(label));
			if (hit) { cfg[hit[0]] = !cfg[hit[0]]; setWidgetConfig(cfg); }
		}
	}

	async function manageOne(ctx: ExtensionContext) {
		const loops = store.list();
		if (loops.length === 0) {
			ctx.ui.notify("No loops yet. Use /loop to add one.", "info");
			return;
		}
		// ctx.ui.select takes string[]. Build one descriptive line per loop,
		// prefixed with the short id so we can map the choice back uniquely.
		const labelToId = new Map<string, string>();
		const options = loops.map((l) => {
			const glyph = statusGlyph(l);
			const next = l.nextRun && l.enabled ? formatRelative(l.nextRun, new Date()) : l.status;
			const preview = loopPayloadPreview(l);
			const shortId = l.id.slice(0, 12);
			const label = `${glyph} ${displayName(l)} [${shortId}] ${loopScheduleLabel(l)} · ${next} · ×${l.runCount} · ${l.action}${preview ? ` :: ${preview}` : ""}`;
			labelToId.set(label, l.id);
			return label;
		});
		const chosen = await ctx.ui.select("Select a loop", options);
		if (!chosen) return;
		const loop = store.get(labelToId.get(chosen)!);
		if (!loop) return;

		const opts: string[] = [];
		if (startupPending.has(loop.id)) opts.push("Enable");
		else if (loop.enabled) opts.push("Pause");
		else if (loop.status !== "done" && loop.status !== "error") opts.push("Resume");
		opts.push("Run now", "Edit…", "Delete");

		const action = await ctx.ui.select(`${displayName(loop)} (${loopScheduleLabel(loop)})`, opts);
		if (!action) return;

		if (action === "Enable") {
			enablePendingLoops(ctx, [loop]);
		} else if (action === "Pause") {
			pauseLoop(loop, ctx);
		} else if (action === "Resume") {
			resumeLoop(loop, ctx);
		} else if (action === "Run now") {
			runLoopNow(loop, ctx);
		} else if (action === "Edit…") {
			await editLoop(loop, ctx);
		} else if (action === "Delete") {
			deleteLoop(loop, ctx);
		}
	}

	// ─── Tools (for the LLM to self-schedule) ──────────────────────────────────

	pi.registerTool({
		name: "schedule_loop",
		label: "Schedule Loop",
		description:
			"Schedule a recurring or one-shot loop in this Pi session that can wake the agent with a prompt, run a shell command, post a message, or notify the user. Persists across restarts but requires /loop enable in each new session. Shows in the status bar.",
		promptSnippet: "Schedule a recurring or one-shot loop (prompt/notify/shell/message) on a timer or cron",
		promptGuidelines: [
			"Use schedule_loop for periodic or deferred work — 'check CI every 5 min', 'remind me at 9am', 'poll until the build passes', 'run npm test hourly'.",
			"Do NOT create schedule_loop calls to test, experiment with, or demonstrate the tool — only create loops for real work the user explicitly asked for. Avoid intervals shorter than ~30s; they fire rapidly and create noise.",
			"Do NOT create multiple schedule_loop calls with the same interval for one goal — they fire in lockstep and flood the session. Instead create ONE interval loop with maxFires.",
			"Do NOT use action='prompt' when no agent action is needed — use 'notify' (a silent reminder) or 'message' (a transcript log line). Use 'shell'+followUpPrompt to run a command on a schedule without waking the agent to run it.",
			"Always set schedule_loop maxFires for polling so it stops itself; a loop without maxFires runs forever. Call stop_loop to remove a loop once its purpose is done.",
			"Set schedule_loop force=true ONLY for time-sensitive triggers that must interrupt a running task; otherwise leave it unset — the default defers until the agent finishes, avoiding disruption.",
			"Name loops you create (schedule_loop name) and call list_loops before creating, to avoid duplicates and so stop_loop can target them.",
		],
		parameters: Type.Object({
			action: StringEnum(["prompt", "notify", "shell", "message"] as const, {
				description: "What the loop does when it fires. 'prompt' wakes the agent.",
			}),
			type: Type.Optional(
				StringEnum(["interval", "once", "cron"] as const, {
					description: "Schedule type. If omitted, inferred from the schedule string.",
				}),
			),
			schedule: Type.String({
				description: "Interval '5m'/'1h'/'30s', once '+10m'/'tomorrow 9am'/ISO, or cron '*/5 * * * *'.",
			}),
			prompt: Type.Optional(Type.String({ description: "Required for action 'prompt'." })),
			message: Type.Optional(Type.String({ description: "Required for actions 'notify' and 'message'." })),
			command: Type.Optional(Type.String({ description: "Required for action 'shell'." })),
			followUpPrompt: Type.Optional(
				Type.String({ description: "Shell: wake the agent with command output + this prompt after it runs." }),
			),
			cwd: Type.Optional(Type.String({ description: "Shell working directory. Defaults to current cwd." })),
			timeoutMs: Type.Optional(Type.Number({ description: "Shell timeout ms.", minimum: 1000 })),
			shellMode: Type.Optional(
				StringEnum(["notify-output", "quiet", "verbose"] as const, {
					description:
						"Shell reporting. Default 'notify-output' runs silently and notifies only when stdout is non-empty; 'quiet' suppresses successful output; 'verbose' shows every run.",
				}),
			),
			name: Type.Optional(Type.String({ description: "Human-readable loop name." })),
			maxFires: Type.Optional(
				Type.Integer({ description: "Stop after this many fires (recurring only).", minimum: 1 }),
			),
			enabled: Type.Optional(Type.Boolean({ description: "Start enabled. Default true." })),
			triggerTurn: Type.Optional(
				Type.Boolean({ description: "Message action: trigger an agent turn. Default true." }),
			),
			force: Type.Optional(
				Type.Boolean({ description: "Force: when the agent is busy, steer the fire in at the next tool-call boundary instead of deferring to agent_settled." }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const loop = createLoop(params as Parameters<typeof createLoop>[0], ctx);
			return {
				content: [{ type: "text", text: `Created loop "${displayName(loop)}" (${loopScheduleLabel(loop)}, ${loop.action}). id=${loop.id}` }],
				details: { loop },
			};
		},
		renderCall(args, theme) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("schedule_loop"))} ${theme.fg("muted", args.action)}/${theme.fg("muted", args.type ?? "auto")} ${theme.fg("accent", args.schedule ?? "")}`,
				0,
				0,
			);
		},
		renderResult(result, _options, theme) {
			const text = result.content?.[0];
			return new Text(theme.fg("success", "✓ ") + (text?.type === "text" ? text.text : "Loop created"), 0, 0);
		},
	});

	pi.registerTool({
		name: "list_loops",
		label: "List Loops",
		description: "List all scheduled loops with status, schedule, next run, and run count.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const loops = store.list();
			if (loops.length === 0) {
				return { content: [{ type: "text", text: "No loops scheduled." }], details: {} };
			}
			const lines = loops.map((l) => {
				const awaitingEnable = startupPending.has(l.id);
				const next = awaitingEnable
					? "awaiting /loop enable"
					: l.nextRun && l.enabled
						? formatRelative(l.nextRun, new Date())
						: l.status;
				return `- ${l.id} ${displayName(l)} [${l.action}/${l.type}] ${loopScheduleLabel(l)} next=${next} runs=${l.runCount}${l.lastStatus === "error" ? " last=error" : ""}`;
			});
			return {
				content: [{ type: "text", text: `${loops.length} loop(s):\n${lines.join("\n")}` }],
				details: { loops },
			};
		},
	});

	pi.registerTool({
		name: "stop_loop",
		label: "Stop Loop",
		description: "Pause or delete a scheduled loop by id, id prefix, or unique name.",
		parameters: Type.Object({
			query: Type.String({ description: "Loop id, id prefix, or unique name." }),
			delete: Type.Optional(Type.Boolean({ description: "Permanently delete instead of pausing. Default false." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const loop = store.find(params.query);
			if (!loop) throw new Error(`No loop matching "${params.query}"`);
			if (params.delete) {
				disarm(loop.id);
				startupPending.delete(loop.id);
				queuedFires.delete(loop.id);
				pendingFires.delete(loop.id);
				store.remove(loop.id);
				updateUI(ctx);
				return { content: [{ type: "text", text: `Deleted loop "${displayName(loop)}".` }], details: { loop } };
			}
			disarm(loop.id);
			startupPending.delete(loop.id);
			queuedFires.delete(loop.id);
			pendingFires.delete(loop.id);
			store.update(loop.id, { enabled: false, status: "paused", nextRun: undefined });
			void store.persist();
			updateUI(ctx);
			return { content: [{ type: "text", text: `Paused loop "${displayName(loop)}".` }], details: { loop } };
		},
	});
}
