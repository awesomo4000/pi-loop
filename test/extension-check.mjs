import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";

const testRoot = `/tmp/pi-loop-extension-check-${process.pid}-${Date.now()}`;
process.env.PI_CODING_AGENT_DIR = `${testRoot}/agent`;
await mkdir(testRoot, { recursive: true });

const { default: loopExtension } = await import("../extensions/loop.ts");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, timeoutMs = 3000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await wait(25);
	}
	throw new Error("Timed out waiting for condition");
}

function createHarness(cwd) {
	const handlers = new Map();
	const tools = new Map();
	const commands = new Map();
	const sentUserMessages = [];
	let slowExecCount = 0;

	const pi = {
		on(name, handler) {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
		registerTool(tool) { tools.set(tool.name, tool); },
		registerCommand(name, command) { commands.set(name, command); },
		registerMessageRenderer() {},
		sendMessage() {},
		sendUserMessage(content, options) { sentUserMessages.push({ content, options }); },
		async exec(_file, args) {
			const command = args.at(-1) ?? "";
			if (command === "slow-safe-placeholder") {
				slowExecCount++;
				await wait(1500);
				return { code: 0, killed: false, stdout: "", stderr: "" };
			}
			if (command === "fail-safe-placeholder") {
				return { code: 7, killed: false, stdout: "", stderr: "expected failure" };
			}
			if (command === "message-checker-placeholder") {
				return { code: 0, killed: false, stdout: "New background message\n", stderr: "" };
			}
			return { code: 0, killed: false, stdout: "", stderr: "" };
		},
	};

	const notices = [];
	const ui = {
		theme: { fg: (_name, value) => value, bold: (value) => value },
		notify(message, level) { notices.push({ message, level }); },
		setStatus() {},
		setWidget() {},
	};
	const ctx = { cwd, hasUI: true, ui, isIdle: () => true };

	loopExtension(pi);
	return {
		ctx,
		tools,
		commands,
		notices,
		sentUserMessages,
		get slowExecCount() { return slowExecCount; },
		async emit(name, event = {}) {
			for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
		},
	};
}

async function list(harness) {
	const result = await harness.tools.get("list_loops").execute("test", {}, undefined, undefined, harness.ctx);
	return result.details.loops ?? [];
}

async function schedule(harness, params) {
	return harness.tools.get("schedule_loop").execute("test", params, undefined, undefined, harness.ctx);
}

console.log("# extension lifecycle");

const project = `${testRoot}/project`;
await mkdir(project, { recursive: true });

// Create and persist an active loop in one extension instance.
const first = createHarness(project);
await first.emit("session_start", { reason: "startup" });
await schedule(first, {
	action: "notify",
	type: "interval",
	schedule: "1s",
	message: "restart-safe-placeholder",
	maxFires: 3,
});
await first.emit("session_shutdown", { reason: "exit" });

// A new session must load the loop without arming it.
const second = createHarness(project);
await second.emit("session_start", { reason: "startup" });
await wait(1200);
let loops = await list(second);
assert.equal(loops.length, 1);
assert.equal(loops[0].runCount, 0, "restored loops must not auto-start");
const listedWhileLocked = await second.tools.get("list_loops").execute("test", {}, undefined, undefined, second.ctx);
assert.match(listedWhileLocked.content[0].text, /awaiting \/loop enable/);
console.log("  ✓ restored loops wait for /loop enable");

// Enabling preserves the old deadline, so this overdue interval catches up immediately.
await second.commands.get("loop").handler("enable", second.ctx);
await waitFor(async () => (await list(second))[0]?.runCount === 1);
console.log("  ✓ /loop enable starts saved loops explicitly");

// Compaction stays in the same extension instance; the existing timer fires once,
// with no restart gate and no duplicate timer.
const beforeCompact = (await list(second))[0].runCount;
await second.emit("session_compact", { compactionEntry: {}, fromExtension: false });
await wait(1100);
assert.equal((await list(second))[0].runCount, beforeCompact + 1);
console.log("  ✓ enabled timers survive compaction without duplication");

// Slow actions coalesce one missed occurrence instead of losing recurrence.
await schedule(second, {
	action: "shell",
	type: "interval",
	schedule: "1s",
	command: "slow-safe-placeholder",
	maxFires: 3,
});
await waitFor(() => second.slowExecCount === 3, 7000);
assert.equal(second.slowExecCount, 3);
assert.ok(!second.notices.some(({ message }) => message.includes("slow-safe-placeholder")));
console.log("  ✓ slow interval actions retain recurrence");

// Non-zero shell exits are failures, not successes.
const failed = await schedule(second, {
	action: "shell",
	type: "interval",
	schedule: "1s",
	command: "fail-safe-placeholder",
	maxFires: 2,
});
await waitFor(async () => (await list(second)).find((loop) => loop.id === failed.details.loop.id)?.runCount === 1);
assert.equal((await list(second)).find((loop) => loop.id === failed.details.loop.id)?.lastStatus, "error");
console.log("  ✓ non-zero shell exits set error status");

// Default shell reporting keeps empty routine checks invisible and reports only
// non-empty stdout, without displaying the checker command or waking the agent.
await schedule(second, {
	action: "shell",
	type: "interval",
	schedule: "1s",
	command: "message-checker-placeholder",
	maxFires: 2,
});
await waitFor(() => second.notices.some(({ message }) => message === "New background message"));
assert.ok(!second.notices.some(({ message }) => message.includes("message-checker-placeholder")));
assert.equal(second.sentUserMessages.length, 0);
console.log("  ✓ shell checkers stay quiet and notify only for stdout");

// Cron nextRun must advance after every occurrence.
const cron = await schedule(second, {
	action: "notify",
	type: "cron",
	schedule: "* * * * * *",
	message: "cron-safe-placeholder",
	maxFires: 5,
});
await waitFor(async () => (await list(second)).find((loop) => loop.id === cron.details.loop.id)?.runCount >= 1);
const cronLoop = (await list(second)).find((loop) => loop.id === cron.details.loop.id);
assert.ok(Date.parse(cronLoop.nextRun) > Date.now(), "cron nextRun must point to a future occurrence");
console.log("  ✓ cron nextRun advances after firing");

// The slash command parser must preserve the original shell payload.
const quotedCommand = 'printf "%s\\n" "hello world"';
await second.commands.get("loop").handler(`shell 1h ${quotedCommand}`, second.ctx);
assert.ok((await list(second)).some((loop) => loop.command === quotedCommand));
console.log("  ✓ slash-command shell quoting is preserved");

// Relative one-shots carry intervalMs internally but must not receive the
// unbounded rapid-interval warning because they fire only once.
const noticeCount = second.notices.length;
const oneShot = await schedule(second, {
	action: "notify",
	type: "once",
	schedule: "+5s",
	message: "one-shot-warning-placeholder",
});
assert.equal(second.notices.length, noticeCount);
await second.tools.get("stop_loop").execute(
	"test",
	{ query: oneShot.details.loop.id, delete: true },
	undefined,
	undefined,
	second.ctx,
);
console.log("  ✓ relative one-shots do not receive interval warnings");

await second.emit("session_shutdown", { reason: "exit" });
console.log("\n✅ EXTENSION CHECKS PASSED");
