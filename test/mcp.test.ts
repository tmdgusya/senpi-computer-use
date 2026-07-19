import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { McpProxy, compareVersions, type DriverChild } from "../src/mcp.js";

const REQUIRED_TOOLS = [
	"list_windows",
	"get_window_state",
	"click",
	"double_click",
	"right_click",
	"drag",
	"scroll",
	"type_text",
	"press_key",
	"hotkey",
	"set_value",
	"launch_app",
	"bring_to_front",
	"start_session",
	"end_session",
];

/** In-process fake of `cua-driver mcp`: newline-delimited JSON-RPC over piped streams. */
class FakeDriver extends EventEmitter {
	readonly stdin = new PassThrough();
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	killed: NodeJS.Signals | undefined;
	private inbuf = "";
	private closed = false;

	constructor(
		private readonly opts: {
			version?: string;
			tools?: string[];
			gwsKeys?: string[];
			toolCall?: (name: string, args: Record<string, unknown>) => unknown;
			stall?: boolean;
		} = {},
	) {
		super();
		this.stdin.on("data", (chunk: Buffer) => this.onData(chunk));
	}

	private onData(chunk: Buffer): void {
		if (this.opts.stall) return;
		this.inbuf += chunk.toString("utf8");
		let idx: number;
		while ((idx = this.inbuf.indexOf("\n")) >= 0) {
			const line = this.inbuf.slice(0, idx).trim();
			this.inbuf = this.inbuf.slice(idx + 1);
			if (line) this.handle(JSON.parse(line));
		}
	}

	private handle(msg: { id?: number; method?: string; params?: Record<string, unknown> }): void {
		if (msg.id === undefined) return; // notification
		if (msg.method === "initialize") {
			this.reply(msg.id, {
				protocolVersion: "2024-11-05",
				capabilities: { tools: {} },
				serverInfo: { name: "cua-driver", version: this.opts.version ?? "0.8.3" },
			});
		} else if (msg.method === "tools/list") {
			const names = this.opts.tools ?? REQUIRED_TOOLS;
			const gwsKeys = this.opts.gwsKeys ?? ["pid", "window_id", "max_elements", "session"];
			this.reply(msg.id, {
				tools: names.map((name) => ({
					name,
					inputSchema: {
						properties:
							name === "get_window_state" ? Object.fromEntries(gwsKeys.map((k) => [k, {}])) : {},
					},
				})),
			});
		} else if (msg.method === "tools/call") {
			const params = msg.params as { name: string; arguments: Record<string, unknown> };
			const custom = this.opts.toolCall?.(params.name, params.arguments);
			this.reply(msg.id, custom ?? { content: [{ type: "text", text: `${params.name} ok` }], isError: false });
		}
	}

	private reply(id: number, result: unknown): void {
		this.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
	}

	kill(signal?: NodeJS.Signals): boolean {
		this.killed = signal ?? "SIGTERM";
		if (!this.closed) {
			this.closed = true;
			queueMicrotask(() => this.emit("close", 0));
		}
		return true;
	}

	endStdin(): void {
		if (!this.closed) {
			this.closed = true;
			queueMicrotask(() => this.emit("close", 0));
		}
	}
}

function proxyOver(driver: FakeDriver): McpProxy {
	const child = driver as unknown as DriverChild;
	// Graceful shutdown ends stdin -> the fake should emit close.
	child.stdin.on("finish", () => driver.endStdin());
	return new McpProxy({ spawnDriver: () => child });
}

describe("McpProxy — startup contract (T4)", () => {
	it("connects, validates the tool contract, and starts a logical session", async () => {
		const driver = new FakeDriver();
		const proxy = proxyOver(driver);

		await proxy.ensureStarted();
		const status = proxy.status();

		expect(status.running).toBe(true);
		expect(status.generation).toBe(1);
		expect(status.session).toMatch(/^senpi-/);
		expect(status.driverVersion).toBe("0.8.3");
		await proxy.shutdown();
	});

	it("fails closed when a required tool is missing", async () => {
		const driver = new FakeDriver({ tools: ["list_windows"] });
		const proxy = proxyOver(driver);

		await expect(proxy.ensureStarted()).rejects.toMatchObject({ reason: "contract_mismatch" });
		expect(proxy.status().running).toBe(false);
	});

	it("fails closed when get_window_state is missing required schema keys", async () => {
		const driver = new FakeDriver({ gwsKeys: ["pid"] });
		const proxy = proxyOver(driver);

		await expect(proxy.ensureStarted()).rejects.toMatchObject({ reason: "contract_mismatch" });
	});

	it("fails closed when the driver version is below the minimum verified", async () => {
		const driver = new FakeDriver({ version: "0.7.0" });
		const proxy = proxyOver(driver);

		await expect(proxy.ensureStarted()).rejects.toMatchObject({ reason: "contract_mismatch" });
	});

	it("returns driver_unavailable when the process cannot spawn", async () => {
		const proxy = new McpProxy({
			spawnDriver: () => {
				throw new Error("spawn cua-driver ENOENT");
			},
		});

		const result = await proxy.callTool("list_windows", {});
		expect(result).toMatchObject({ isError: true, failure: "driver_unavailable" });
	});
});

describe("McpProxy — tool dispatch and FIFO (T3)", () => {
	it("carries the session id into every tool call and returns text content", async () => {
		let seenSession: unknown;
		const driver = new FakeDriver({
			toolCall: (name, args) => {
				if (name === "list_windows") seenSession = args.session;
				return { content: [{ type: "text", text: '{"windows":[]}' }], isError: false };
			},
		});
		const proxy = proxyOver(driver);

		const result = await proxy.callTool("list_windows", {});
		expect(result.text).toBe('{"windows":[]}');
		expect(seenSession).toBe(proxy.status().session);
		await proxy.shutdown();
	});

	it("serializes concurrent calls in FIFO order", async () => {
		const order: string[] = [];
		const driver = new FakeDriver({
			toolCall: (name) => {
				order.push(name);
				return { content: [{ type: "text", text: name }], isError: false };
			},
		});
		const proxy = proxyOver(driver);

		await Promise.all([proxy.callTool("list_windows", {}), proxy.callTool("get_window_state", { pid: 1 }), proxy.callTool("scroll", { pid: 1 })]);
		// start_session (handshake) runs first, then the three in submission order.
		expect(order).toEqual(["start_session", "list_windows", "get_window_state", "scroll"]);
		await proxy.shutdown();
	});

	it("does not dispatch a call whose signal is already aborted", async () => {
		let dispatched = false;
		const driver = new FakeDriver({
			toolCall: (name) => {
				if (name !== "start_session") dispatched = true;
				return { content: [], isError: false };
			},
		});
		const proxy = proxyOver(driver);
		await proxy.ensureStarted();

		const controller = new AbortController();
		controller.abort();
		const result = await proxy.callTool("click", { pid: 1 }, { signal: controller.signal, mutating: true });

		expect(result).toMatchObject({ isError: true, failure: "aborted_before_dispatch" });
		expect(dispatched).toBe(false);
		await proxy.shutdown();
	});

	it("maps driver isError responses to a failed tool result", async () => {
		const driver = new FakeDriver({
			toolCall: () => ({ content: [{ type: "text", text: "no such window" }], isError: true }),
		});
		const proxy = proxyOver(driver);

		const result = await proxy.callTool("get_window_state", { pid: 999 });
		expect(result).toMatchObject({ isError: true, text: "no such window" });
		await proxy.shutdown();
	});
});

describe("McpProxy — shutdown (T2)", () => {
	it("ends the session and terminates the child gracefully and idempotently", async () => {
		const ended: string[] = [];
		const driver = new FakeDriver({
			toolCall: (name, args) => {
				if (name === "end_session") ended.push(String(args.session));
				return { content: [], isError: false };
			},
		});
		const proxy = proxyOver(driver);
		await proxy.ensureStarted();
		const session = proxy.status().session!;

		await proxy.shutdown();
		await proxy.shutdown(); // idempotent

		expect(ended).toContain(session);
		expect(proxy.status().running).toBe(false);
	});
});

describe("compareVersions", () => {
	it("orders semantic versions numerically", () => {
		expect(compareVersions("0.8.3", "0.8.3")).toBe(0);
		expect(compareVersions("0.8.3", "0.7.9")).toBeGreaterThan(0);
		expect(compareVersions("0.8.3", "0.9.0")).toBeLessThan(0);
		expect(compareVersions("0.10.0", "0.9.0")).toBeGreaterThan(0);
	});
});
