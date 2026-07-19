import { afterEach, describe, expect, it, vi } from "vitest";

import { createComputerUseTool, isValidImage, type ComputerUseDeps } from "../src/computer-use.js";
import type { CapabilityReport } from "../src/doctor.js";
import type { DriverToolResult, ProxyStatus } from "../src/mcp.js";
import { cuaEnvironment, boundedText } from "../src/environment.js";
import { checkHardBlocks, isMutatingAction, normalizeKeyToken, toDriverInvocation } from "../src/actions.js";

function proxyStatus(overrides: Partial<ProxyStatus> = {}): ProxyStatus {
	return {
		running: true,
		generation: 1,
		session: "senpi-test-session",
		driverVersion: "0.8.3",
		toolCount: 42,
		lastFailure: undefined,
		...overrides,
	};
}

function okResult(overrides: Partial<DriverToolResult> = {}): DriverToolResult {
	return { isError: false, text: "", images: [], ...overrides };
}

function healthyReport(overrides: Partial<CapabilityReport> = {}): CapabilityReport {
	return {
		driver: "ok",
		driverDetail: "cua-driver 0.8.3",
		probes: [],
		surfaces: { x11: "warn", atspi: "ok", displayServer: "Wayland+XWayland" },
		proxy: proxyStatus(),
		...overrides,
	};
}

function build(
	overrides: Partial<ComputerUseDeps> = {},
): { tool: ReturnType<typeof createComputerUseTool>; call: ReturnType<typeof vi.fn> } {
	const call = vi.fn(async () => okResult());
	const deps: ComputerUseDeps = {
		call: call as unknown as ComputerUseDeps["call"],
		proxyStatus: () => proxyStatus(),
		doctor: async () => healthyReport(),
		...overrides,
	};
	return { tool: createComputerUseTool(deps), call };
}

const tuiCtx = { mode: "tui", ui: { confirm: vi.fn(async () => true) }, model: { input: ["text"] } } as never;
const imageCtx = { mode: "tui", ui: { confirm: vi.fn(async () => true) }, model: { input: ["text", "image"] } } as never;

describe("computer_use — status / doctor (C6)", () => {
	it("reports driver-ok readiness through the capability doctor", async () => {
		const doctor = vi.fn(async () => healthyReport());
		const { tool } = build({ doctor });

		const result = await tool.execute("s", { action: "status" }, undefined, undefined, tuiCtx);

		expect(doctor).toHaveBeenCalledOnce();
		expect(result.details).toMatchObject({ action: "status", ok: true });
		expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("Wayland+XWayland") });
	});

	it("fails closed and distinguishes a missing driver", async () => {
		const doctor = vi.fn(async () => healthyReport({ driver: "missing", driverDetail: "cua-driver unavailable: ENOENT" }));
		const { tool } = build({ doctor });

		const result = await tool.execute("s", { action: "status" }, undefined, undefined, tuiCtx);

		expect(result.details).toMatchObject({ action: "status", ok: false, reason: "driver_unavailable" });
	});
});

describe("computer_use — read-only actions", () => {
	it("lists windows through the MCP list_windows tool with the session id", async () => {
		const { tool, call } = build();
		call.mockResolvedValueOnce(okResult({ text: "Found 1 windows:", structuredContent: { windows: [{ pid: 7, window_id: 9 }] } }));

		const result = await tool.execute("w", { action: "windows" }, undefined, undefined, tuiCtx);

		expect(call).toHaveBeenCalledWith("list_windows", { session: "senpi-test-session" }, expect.objectContaining({ mutating: false }));
		expect(result.details).toMatchObject({ action: "windows", ok: true });
		// Structured window records are preferred so the model reliably gets pid/window_id.
		expect((result.content[0] as { text: string }).text).toContain('"window_id":9');
	});

	it("captures a window via get_window_state without a screenshot when the model is text-only (C4)", async () => {
		const { tool, call } = build();
		call.mockResolvedValueOnce(okResult({ structuredContent: { elements: [{ element_index: 3, label: "OK" }] } }));

		const result = await tool.execute("c", { action: "capture", pid: 42, windowId: 99 }, undefined, undefined, tuiCtx);

		expect(call).toHaveBeenCalledWith(
			"get_window_state",
			{ pid: 42, window_id: 99, max_elements: 100, include_screenshot: false, session: "senpi-test-session" },
			expect.objectContaining({ mutating: false }),
		);
		expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("element_index") });
		expect(result.content).toHaveLength(1);
	});

	it("requests and attaches a validated screenshot when the model accepts images (C4)", async () => {
		const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(64)]).toString("base64");
		const { tool, call } = build();
		call.mockResolvedValueOnce(
			okResult({ structuredContent: { elements: [] }, images: [{ data: png, mimeType: "image/png" }] }),
		);

		const result = await tool.execute("c", { action: "capture", pid: 42 }, undefined, undefined, imageCtx);

		expect(call).toHaveBeenCalledWith(
			"get_window_state",
			expect.objectContaining({ include_screenshot: true, pid: 42 }),
			expect.anything(),
		);
		expect(result.content.some((block) => block.type === "image")).toBe(true);
	});

	it("degrades an invalid screenshot to text rather than emitting a bad image (C4)", async () => {
		const { tool, call } = build();
		call.mockResolvedValueOnce(
			okResult({ structuredContent: { elements: [] }, images: [{ data: "not-base64!!!", mimeType: "image/png" }] }),
		);

		const result = await tool.execute("c", { action: "capture", pid: 7 }, undefined, undefined, imageCtx);

		expect(result.content.every((block) => block.type === "text")).toBe(true);
		expect((result.content[0] as { text: string }).text).toContain("screenshot dropped");
	});
});

describe("computer_use — safety gate (SS10)", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("denies a mutating action in non-tui mode before any driver call", async () => {
		const { tool, call } = build();
		const printCtx = { mode: "print", ui: { confirm: vi.fn(async () => true) }, model: { input: ["text"] } } as never;

		const result = await tool.execute("k", { action: "click", pid: 42, elementIndex: 3 }, undefined, undefined, printCtx);

		expect(call).not.toHaveBeenCalled();
		expect(result.details).toMatchObject({ action: "click", ok: false, reason: "interactive_approval_required" });
	});

	it("auto-approves mutating actions by default without prompting", async () => {
		const confirm = vi.fn(async () => true);
		const ctx = { mode: "tui", ui: { confirm }, model: { input: ["text"] } } as never;
		const { tool, call } = build();
		call.mockResolvedValueOnce(okResult({ text: '{"verified":true}' }));

		const result = await tool.execute("k", { action: "click", pid: 42, windowId: 99, elementIndex: 3 }, undefined, undefined, ctx);

		expect(confirm).not.toHaveBeenCalled();
		expect(call).toHaveBeenCalledWith(
			"click",
			{ pid: 42, window_id: 99, element_index: 3, session: "senpi-test-session" },
			expect.objectContaining({ mutating: true }),
		);
		expect(result.details).toMatchObject({ action: "click", ok: true });
	});

	it("requires allow-once approval and dispatches click via the MCP click tool", async () => {
		vi.stubEnv("SENPI_CUA_REQUIRE_APPROVAL", "1");
		const confirm = vi.fn(async () => true);
		const ctx = { mode: "tui", ui: { confirm }, model: { input: ["text"] } } as never;
		const { tool, call } = build();
		call.mockResolvedValueOnce(okResult({ text: '{"verified":true}' }));

		const result = await tool.execute("k", { action: "click", pid: 42, windowId: 99, elementIndex: 3 }, undefined, undefined, ctx);

		expect(confirm).toHaveBeenCalledOnce();
		expect(call).toHaveBeenCalledWith(
			"click",
			{ pid: 42, window_id: 99, element_index: 3, session: "senpi-test-session" },
			expect.objectContaining({ mutating: true }),
		);
		expect(result.details).toMatchObject({ action: "click", ok: true });
	});

	it("records user_rejected — distinct from the no-UI denial — when approval is declined", async () => {
		vi.stubEnv("SENPI_CUA_REQUIRE_APPROVAL", "1");
		const confirm = vi.fn(async () => false);
		const ctx = { mode: "tui", ui: { confirm }, model: { input: ["text"] } } as never;
		const { tool, call } = build();

		const result = await tool.execute("k", { action: "type", pid: 42, text: "hi" }, undefined, undefined, ctx);

		expect(call).not.toHaveBeenCalled();
		expect(result.details).toMatchObject({ action: "type", ok: false, reason: "user_rejected" });
	});

	it("hard-blocks a catastrophic hotkey before approval is even requested", async () => {
		const confirm = vi.fn(async () => true);
		const ctx = { mode: "tui", ui: { confirm }, model: { input: ["text"] } } as never;
		const { tool, call } = build();

		const result = await tool.execute("k", { action: "hotkey", pid: 42, keys: ["ctrl", "alt", "Delete"] }, undefined, undefined, ctx);

		expect(confirm).not.toHaveBeenCalled();
		expect(call).not.toHaveBeenCalled();
		expect(result.details).toMatchObject({ action: "hotkey", ok: false, reason: "hard_blocked" });
	});

	it("surfaces an unknown-outcome driver failure as a non-replayed error", async () => {
		const confirm = vi.fn(async () => true);
		const ctx = { mode: "tui", ui: { confirm }, model: { input: ["text"] } } as never;
		const { tool, call } = build();
		call.mockResolvedValueOnce({ isError: true, text: "aborted in flight", images: [], failure: "unknown_outcome" });

		const result = await tool.execute("k", { action: "click", pid: 1, x: 2, y: 3 }, undefined, undefined, ctx);

		expect(result.details).toMatchObject({ action: "click", ok: false, reason: "unknown_outcome" });
	});
});

describe("actions — pure mapping and policy", () => {
	it("classifies safe vs mutating actions", () => {
		expect(isMutatingAction("status")).toBe(false);
		expect(isMutatingAction("windows")).toBe(false);
		expect(isMutatingAction("capture")).toBe(false);
		expect(isMutatingAction("wait")).toBe(false);
		expect(isMutatingAction("click")).toBe(true);
		expect(isMutatingAction("launch")).toBe(true);
	});

	it("blocks a hotkey superset of a catastrophic family", () => {
		expect(checkHardBlocks({ action: "hotkey", pid: 1, keys: ["ctrl", "alt", "f1"] }).blocked).toBe(true);
		expect(checkHardBlocks({ action: "hotkey", pid: 1, keys: ["ctrl", "shift", "t"] }).blocked).toBe(false);
	});

	it("blocks control characters in typed text", () => {
		expect(checkHardBlocks({ action: "type", pid: 1, text: "hello\u0000world" }).blocked).toBe(true);
		expect(checkHardBlocks({ action: "type", pid: 1, text: "hello world\n" }).blocked).toBe(false);
	});

	it("normalizes key aliases", () => {
		expect(normalizeKeyToken("Control")).toBe("ctrl");
		expect(normalizeKeyToken("Meta")).toBe("super");
		expect(normalizeKeyToken("Delete")).toBe("delete");
	});

	it("maps scroll and type to their MCP tools with the session id", () => {
		const scroll = toDriverInvocation({ action: "scroll", pid: 5, direction: "down", amount: 3 }, "s1", 100, false);
		expect(scroll).toEqual({ tool: "scroll", args: { pid: 5, direction: "down", amount: 3, session: "s1" } });
		const type = toDriverInvocation({ action: "type", pid: 5, text: "hi" }, "s1", 100, false);
		expect(type).toEqual({ tool: "type_text", args: { pid: 5, text: "hi", session: "s1" } });
	});
});

describe("environment", () => {
	it("disables telemetry and strips credentials from the child environment", () => {
		const environment = cuaEnvironment({ PATH: "/bin", OPENAI_API_KEY: "secret" });
		expect(environment.CUA_DRIVER_RS_TELEMETRY_ENABLED).toBe("0");
		expect(environment.CUA_DRIVER_RS_UPDATE_CHECK).toBe("false");
		expect(environment.OPENAI_API_KEY).toBeUndefined();
		expect(environment.PATH).toBe("/bin");
	});

	it("bounds oversized text on a UTF-8 boundary", () => {
		const big = "a".repeat(100 * 1024);
		expect(boundedText(big).endsWith("[output truncated]")).toBe(true);
		expect(boundedText("short")).toBe("short");
	});
});

describe("image validation (C4)", () => {
	it("accepts a small PNG and rejects wrong mime / oversize / non-image", () => {
		const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(16)]).toString("base64");
		expect(isValidImage({ data: png, mimeType: "image/png" })).toBe(true);
		expect(isValidImage({ data: png, mimeType: "image/gif" })).toBe(false);
		const huge = Buffer.alloc(6 * 1024 * 1024, 0x89).toString("base64");
		expect(isValidImage({ data: huge, mimeType: "image/png" })).toBe(false);
	});
});
