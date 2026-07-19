import { spawn, type ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { McpProxy } from "../src/mcp.js";

/**
 * Isolated capture -> action fixture oracle (spec R4). Opt-in:
 *   SENPI_CUA_LIVE=1 npm test
 * On Linux `cua-driver mcp` runs in-process, so each proxy owns an isolated
 * driver instance that is torn down on shutdown. This test owns its own neutral
 * XWayland app (gnome-calculator), captures its real accessibility tree, exercises
 * one background action, and cleans everything up. It SKIPS (never fails) when the
 * host has no calculator or no XWayland window appears (headless CI).
 */
const LIVE = process.env.SENPI_CUA_LIVE === "1";

interface Fixture {
	proxy: McpProxy;
	app: ChildProcess;
	pid: number;
	windowId: number;
	elements: { element_index: number; role?: string; label?: string; name?: string }[];
}

let fixture: Fixture | undefined;
let skipReason: string | undefined;

beforeAll(async () => {
	if (!LIVE) {
		skipReason = "SENPI_CUA_LIVE!=1";
		return;
	}
	const app = spawn("gnome-calculator", [], {
		env: { ...process.env, GDK_BACKEND: "x11" },
		stdio: "ignore",
		detached: true,
	});
	const spawnFailed = await new Promise<boolean>((resolve) => {
		app.once("error", () => resolve(true));
		setTimeout(() => resolve(false), 500);
	});
	if (spawnFailed) {
		skipReason = "gnome-calculator not installed";
		return;
	}
	const proxy = new McpProxy();
	await proxy.ensureStarted();
	await new Promise((r) => setTimeout(r, 4000));

	const wins = await proxy.callTool("list_windows", {});
	const arr = (wins.structuredContent as { windows?: { pid: number; window_id: number; title?: string; app_name?: string }[] } | undefined)?.windows ?? [];
	const target = arr.find((w) => /calcul/i.test(w.title ?? "") || /calcul/i.test(w.app_name ?? ""));
	if (target === undefined) {
		skipReason = "no XWayland calculator window (headless?)";
		await proxy.shutdown();
		app.kill("SIGTERM");
		return;
	}
	const cap = await proxy.callTool("get_window_state", { pid: target.pid, window_id: target.window_id, max_elements: 60, include_screenshot: false });
	const elements = (cap.structuredContent as { elements?: Fixture["elements"] } | undefined)?.elements ?? [];
	fixture = { proxy, app, pid: target.pid, windowId: target.window_id, elements };
}, 30_000);

afterAll(async () => {
	if (fixture === undefined) return;
	try {
		await fixture.proxy.callTool("kill_app", { pid: fixture.pid }, { mutating: true });
	} catch {
		/* best effort */
	}
	await fixture.proxy.shutdown();
	try {
		fixture.app.kill("SIGKILL");
	} catch {
		/* already gone */
	}
});

describe.runIf(LIVE)("live isolated capture -> action fixture oracle (C4, R4)", () => {
	it("captures a real accessibility tree with a known digit control", () => {
		if (fixture === undefined) {
			expect(skipReason, `skipped: ${skipReason}`).toBeDefined();
			return;
		}
		expect(fixture.elements.length).toBeGreaterThan(0);
		const labels = fixture.elements.map((e) => e.label ?? e.name ?? "");
		// Oracle: a calculator always exposes digit buttons.
		expect(labels.some((l) => /^[0-9]$/.test(l))).toBe(true);
	});

	it("dispatches one background action against a captured element without error", async () => {
		if (fixture === undefined) {
			expect(skipReason, `skipped: ${skipReason}`).toBeDefined();
			return;
		}
		const digit = fixture.elements.find((e) => /button/i.test(e.role ?? "") && /^[0-9]$/.test(e.label ?? e.name ?? ""));
		if (digit === undefined) return; // structure varies; capture oracle above is the hard assertion
		const result = await fixture.proxy.callTool(
			"click",
			{ pid: fixture.pid, window_id: fixture.windowId, element_index: digit.element_index },
			{ mutating: true },
		);
		expect(result.isError).toBe(false);
	}, 15_000);
});
