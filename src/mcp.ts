import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";

import { cuaEnvironment, MAX_FRAME_BYTES, resolveDriverExecutable } from "./environment.js";

/**
 * Persistent bounded MCP stdio proxy for `cua-driver mcp` (plan T1-T4).
 * - newline-delimited JSON-RPC 2.0 framing with a hard frame bound
 * - startup contract validation (initialize + tools/list), fail closed
 * - FIFO serialization; queued aborts never dispatch; in-flight mutating aborts latch unknown outcome
 * - one logical CUA session per proxy generation; explicit end_session on shutdown
 * - graceful close -> terminate -> kill shutdown, idempotent
 */

export const MIN_VERIFIED_DRIVER_VERSION = "0.8.3";
export const REQUIRED_TOOLS = [
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
] as const;
const REQUIRED_GET_WINDOW_STATE_KEYS = ["pid", "window_id", "max_elements", "session"] as const;

export type DriverFailureReason =
	| "driver_unavailable"
	| "contract_mismatch"
	| "timeout"
	| "transport_lost"
	| "aborted_before_dispatch"
	| "aborted"
	| "unknown_outcome"
	| "protocol_error";

export interface DriverImage {
	data: string;
	mimeType: string;
}

export interface DriverToolResult {
	isError: boolean;
	text: string;
	images: DriverImage[];
	structuredContent?: unknown;
	failure?: DriverFailureReason;
}

export interface DriverCallOptions {
	signal?: AbortSignal | undefined;
	mutating?: boolean;
	timeoutMs?: number;
}

export type DriverCall = (toolName: string, args: Record<string, unknown>, opts?: DriverCallOptions) => Promise<DriverToolResult>;

/** Minimal child surface so tests can inject a fake transport. */
export interface DriverChild {
	stdin: Writable;
	stdout: Readable;
	stderr: Readable | null;
	kill(signal?: NodeJS.Signals): boolean;
	once(event: "error", listener: (error: Error) => void): void;
	once(event: "close", listener: (code: number | null) => void): void;
	removeListener(event: string, listener: (...args: never[]) => void): void;
}

export type SpawnDriver = () => DriverChild;

export function spawnCuaDriverMcp(): DriverChild {
	return spawn(resolveDriverExecutable(), ["mcp"], {
		env: cuaEnvironment(),
		shell: false,
		stdio: ["pipe", "pipe", "pipe"],
	}) as unknown as DriverChild;
}

interface JsonRpcResponse {
	jsonrpc: "2.0";
	id?: number;
	result?: unknown;
	error?: { code: number; message: string };
	method?: string;
}

interface PendingRequest {
	resolve: (response: JsonRpcResponse) => void;
	reject: (error: DriverProxyError) => void;
	mutating: boolean;
}

export class DriverProxyError extends Error {
	readonly reason: DriverFailureReason;
	constructor(reason: DriverFailureReason, message: string) {
		super(message);
		this.reason = reason;
	}
}

export interface ProxyStatus {
	running: boolean;
	generation: number;
	session: string | undefined;
	driverVersion: string | undefined;
	toolCount: number;
	lastFailure: string | undefined;
}

const DEFAULT_CALL_TIMEOUT_MS = 30_000;
const HANDSHAKE_TIMEOUT_MS = 15_000;
const SHUTDOWN_GRACE_MS = 3_000;

export class McpProxy {
	private readonly spawnDriver: SpawnDriver;
	private child: DriverChild | undefined;
	private buffer = "";
	private nextId = 1;
	private readonly pending = new Map<number, PendingRequest>();
	private queue: Promise<unknown> = Promise.resolve();
	private started = false;
	private startPromise: Promise<void> | undefined;
	private shuttingDown = false;
	private _generation = 0;
	private _session: string | undefined;
	private _driverVersion: string | undefined;
	private _toolCount = 0;
	private _lastFailure: string | undefined;

	constructor(options: { spawnDriver?: SpawnDriver } = {}) {
		this.spawnDriver = options.spawnDriver ?? spawnCuaDriverMcp;
	}

	get generation(): number {
		return this._generation;
	}

	get session(): string | undefined {
		return this._session;
	}

	status(): ProxyStatus {
		return {
			running: this.started,
			generation: this._generation,
			session: this._session,
			driverVersion: this._driverVersion,
			toolCount: this._toolCount,
			lastFailure: this._lastFailure,
		};
	}

	/** FIFO-serialized tool call. Lazily starts the proxy on first use. */
	callTool: DriverCall = (toolName, args, opts = {}) => {
		const run = this.queue.then(async (): Promise<DriverToolResult> => {
			if (opts.signal?.aborted) {
				return failure("aborted_before_dispatch", `tool ${toolName} aborted before dispatch`);
			}
			try {
				await this.ensureStarted();
			} catch (error) {
				return failureFromError(error);
			}
			try {
				const response = await this.request(
					"tools/call",
					{ name: toolName, arguments: { ...args, ...(this._session === undefined ? {} : { session: this._session }) } },
					{ mutating: opts.mutating ?? false, timeoutMs: opts.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS, signal: opts.signal },
				);
				return parseToolResult(response);
			} catch (error) {
				return failureFromError(error);
			}
		});
		// Keep the FIFO chain alive regardless of individual outcomes.
		this.queue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	};

	async ensureStarted(): Promise<void> {
		if (this.started) return;
		this.startPromise ??= this.start().catch((error: unknown) => {
			this.startPromise = undefined;
			throw error;
		});
		await this.startPromise;
	}

	private async start(): Promise<void> {
		this.shuttingDown = false;
		let child: DriverChild;
		try {
			child = this.spawnDriver();
		} catch (error) {
			throw new DriverProxyError("driver_unavailable", `failed to spawn cua-driver mcp: ${message(error)}`);
		}
		this.child = child;
		this.buffer = "";

		child.once("error", (error) => {
			this.failTransport(`cua-driver process error: ${error.message}`, "driver_unavailable");
		});
		child.once("close", (code) => {
			if (!this.shuttingDown) this.failTransport(`cua-driver exited unexpectedly (code ${code})`, "transport_lost");
		});
		child.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
		child.stderr?.on("data", () => {
			/* drain stderr so the child never blocks (plan section 7) */
		});
		child.stdin.on("error", () => {
			/* EPIPE surfaces through close */
		});

		const init = await this.request(
			"initialize",
			{
				protocolVersion: "2024-11-05",
				capabilities: {},
				clientInfo: { name: "senpi-computer-use", version: "0.0.0" },
			},
			{ mutating: false, timeoutMs: HANDSHAKE_TIMEOUT_MS },
		);
		validateInitialize(init);
		this._driverVersion = extractServerVersion(init);
		if (this._driverVersion === undefined || compareVersions(this._driverVersion, MIN_VERIFIED_DRIVER_VERSION) < 0) {
			void this.shutdown();
			throw new DriverProxyError(
				"contract_mismatch",
				`driver version ${this._driverVersion ?? "unknown"} is below the minimum verified ${MIN_VERIFIED_DRIVER_VERSION}`,
			);
		}
		this.notify("notifications/initialized");

		const listed = await this.request("tools/list", {}, { mutating: false, timeoutMs: HANDSHAKE_TIMEOUT_MS });
		this._toolCount = validateToolContract(listed);

		this._generation += 1;
		this._session = `senpi-${randomUUID()}`;
		this.started = true;

		const sessionResult = await this.request(
			"tools/call",
			{ name: "start_session", arguments: { session: this._session } },
			{ mutating: false, timeoutMs: HANDSHAKE_TIMEOUT_MS },
		).catch(() => undefined);
		if (sessionResult === undefined || parseToolResult(sessionResult).isError) {
			// Session declaration is advisory; actions still carry the session id.
			this._lastFailure = "start_session was not acknowledged by the driver";
		}
	}

	private onData(chunk: Buffer): void {
		this.buffer += chunk.toString("utf8");
		if (this.buffer.length > MAX_FRAME_BYTES) {
			this.failTransport(`driver frame exceeded ${MAX_FRAME_BYTES} bytes`, "protocol_error");
			void this.shutdown();
			return;
		}
		let index: number;
		while ((index = this.buffer.indexOf("\n")) >= 0) {
			const line = this.buffer.slice(0, index).trim();
			this.buffer = this.buffer.slice(index + 1);
			if (line.length === 0) continue;
			let parsed: JsonRpcResponse;
			try {
				parsed = JSON.parse(line) as JsonRpcResponse;
			} catch {
				continue; // Non-JSON noise on stdout is ignored; requests time out if starved.
			}
			if (parsed.id !== undefined && this.pending.has(parsed.id)) {
				const pending = this.pending.get(parsed.id)!;
				this.pending.delete(parsed.id);
				pending.resolve(parsed);
			}
		}
	}

	private request(
		method: string,
		params: Record<string, unknown>,
		options: { mutating: boolean; timeoutMs: number; signal?: AbortSignal | undefined },
	): Promise<JsonRpcResponse> {
		const child = this.child;
		if (child === undefined) {
			return Promise.reject(new DriverProxyError("transport_lost", "driver transport is not connected"));
		}
		const id = this.nextId++;
		return new Promise<JsonRpcResponse>((resolve, reject) => {
			const pending: PendingRequest = { resolve: onResolve, reject: onReject, mutating: options.mutating };
			const timer = setTimeout(() => {
				this.pending.delete(id);
				onReject(
					options.mutating
						? new DriverProxyError("unknown_outcome", `mutating request ${method} timed out; outcome unknown, not replayed`)
						: new DriverProxyError("timeout", `request ${method} timed out after ${options.timeoutMs}ms`),
				);
			}, options.timeoutMs);
			const onAbort = (): void => {
				this.pending.delete(id);
				onReject(
					options.mutating
						? new DriverProxyError("unknown_outcome", `mutating request ${method} aborted in flight; outcome unknown, not replayed`)
						: new DriverProxyError("aborted", `request ${method} aborted`),
				);
			};
			function onResolve(response: JsonRpcResponse): void {
				clearTimeout(timer);
				options.signal?.removeEventListener("abort", onAbort);
				resolve(response);
			}
			function onReject(error: DriverProxyError): void {
				clearTimeout(timer);
				options.signal?.removeEventListener("abort", onAbort);
				reject(error);
			}
			options.signal?.addEventListener("abort", onAbort, { once: true });
			this.pending.set(id, pending);
			try {
				child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
			} catch (error) {
				this.pending.delete(id);
				onReject(new DriverProxyError("transport_lost", `failed to write to driver: ${message(error)}`));
			}
		});
	}

	private notify(method: string): void {
		try {
			this.child?.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
		} catch {
			/* close handler owns transport failure */
		}
	}

	private failTransport(detail: string, reason: DriverFailureReason): void {
		this.started = false;
		this.startPromise = undefined;
		this.child = undefined;
		this._session = undefined;
		this._lastFailure = detail;
		for (const [id, pending] of [...this.pending]) {
			this.pending.delete(id);
			pending.reject(
				pending.mutating && reason === "transport_lost"
					? new DriverProxyError("unknown_outcome", `${detail}; mutating call outcome unknown, not replayed`)
					: new DriverProxyError(reason, detail),
			);
		}
	}

	/** Graceful close -> terminate -> kill. Idempotent; awaited on every shutdown path. */
	async shutdown(): Promise<void> {
		const child = this.child;
		if (child === undefined) {
			this.started = false;
			this.startPromise = undefined;
			return;
		}
		this.shuttingDown = true;
		if (this.started && this._session !== undefined) {
			await this.request(
				"tools/call",
				{ name: "end_session", arguments: { session: this._session } },
				{ mutating: false, timeoutMs: 2_000 },
			).catch(() => undefined);
		}
		this.started = false;
		this.startPromise = undefined;
		this.child = undefined;
		this._session = undefined;

		const closed = new Promise<void>((resolve) => {
			child.once("close", () => resolve());
		});
		try {
			child.stdin.end();
		} catch {
			/* already closed */
		}
		const graceful = await withTimeout(closed, SHUTDOWN_GRACE_MS);
		if (!graceful) {
			child.kill("SIGTERM");
			const terminated = await withTimeout(closed, SHUTDOWN_GRACE_MS);
			if (!terminated) {
				child.kill("SIGKILL");
				await withTimeout(closed, SHUTDOWN_GRACE_MS);
			}
		}
		for (const [id, pending] of [...this.pending]) {
			this.pending.delete(id);
			pending.reject(new DriverProxyError("transport_lost", "driver proxy shut down"));
		}
	}
}

async function withTimeout(promise: Promise<void>, ms: number): Promise<boolean> {
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<boolean>((resolve) => {
		timer = setTimeout(() => resolve(false), ms);
	});
	const result = await Promise.race([promise.then(() => true), timeout]);
	clearTimeout(timer);
	return result;
}

function validateInitialize(response: JsonRpcResponse): void {
	if (response.error !== undefined) {
		throw new DriverProxyError("contract_mismatch", `initialize rejected: ${response.error.message}`);
	}
	const result = response.result as { capabilities?: { tools?: unknown } } | undefined;
	if (result?.capabilities?.tools === undefined) {
		throw new DriverProxyError("contract_mismatch", "driver did not advertise MCP tools capability");
	}
}

function extractServerVersion(response: JsonRpcResponse): string | undefined {
	const result = response.result as { serverInfo?: { version?: unknown } } | undefined;
	const version = result?.serverInfo?.version;
	return typeof version === "string" ? version : undefined;
}

export function compareVersions(a: string, b: string): number {
	const pa = a.split(".").map((part) => Number.parseInt(part, 10) || 0);
	const pb = b.split(".").map((part) => Number.parseInt(part, 10) || 0);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}

function validateToolContract(response: JsonRpcResponse): number {
	if (response.error !== undefined) {
		throw new DriverProxyError("contract_mismatch", `tools/list rejected: ${response.error.message}`);
	}
	const result = response.result as { tools?: { name?: unknown; inputSchema?: { properties?: Record<string, unknown> } }[] } | undefined;
	const tools = result?.tools;
	if (!Array.isArray(tools)) {
		throw new DriverProxyError("contract_mismatch", "tools/list returned no tool array");
	}
	const byName = new Map(tools.filter((tool) => typeof tool.name === "string").map((tool) => [tool.name as string, tool]));
	const missing = REQUIRED_TOOLS.filter((name) => !byName.has(name));
	if (missing.length > 0) {
		throw new DriverProxyError("contract_mismatch", `driver is missing required tools: ${missing.join(", ")}`);
	}
	const gws = byName.get("get_window_state")!;
	const keys = Object.keys(gws.inputSchema?.properties ?? {});
	const missingKeys = REQUIRED_GET_WINDOW_STATE_KEYS.filter((key) => !keys.includes(key));
	if (missingKeys.length > 0) {
		throw new DriverProxyError("contract_mismatch", `get_window_state schema is missing keys: ${missingKeys.join(", ")}`);
	}
	return tools.length;
}

function parseToolResult(response: JsonRpcResponse): DriverToolResult {
	if (response.error !== undefined) {
		return { isError: true, text: response.error.message, images: [] };
	}
	const result = response.result as
		| { isError?: boolean; content?: { type?: string; text?: string; data?: string; mimeType?: string }[]; structuredContent?: unknown }
		| undefined;
	const content = Array.isArray(result?.content) ? result.content : [];
	const text = content
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n");
	const images = content
		.filter((block): block is { type: "image"; data: string; mimeType: string } => block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string")
		.map((block) => ({ data: block.data, mimeType: block.mimeType }));
	return {
		isError: result?.isError === true,
		text,
		images,
		...(result?.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
	};
}

function failure(reason: DriverFailureReason, detail: string): DriverToolResult {
	return { isError: true, text: detail, images: [], failure: reason };
}

function failureFromError(error: unknown): DriverToolResult {
	if (error instanceof DriverProxyError) return failure(error.reason, error.message);
	return failure("protocol_error", message(error));
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
