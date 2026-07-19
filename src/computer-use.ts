import { spawn } from "node:child_process";

import type { ToolDefinition } from "@code-yeongyu/senpi";
import { Type, type Static } from "typebox";

const PARAMETERS = Type.Union([
	Type.Object({ action: Type.Literal("status") }, { additionalProperties: false }),
	Type.Object({ action: Type.Literal("windows") }, { additionalProperties: false }),
	Type.Object({
		action: Type.Literal("capture"),
		pid: Type.Integer({ minimum: 1 }),
		windowId: Type.Integer({ minimum: 1 }),
	}, { additionalProperties: false }),
	Type.Object({
		action: Type.Literal("click"),
		pid: Type.Integer({ minimum: 1 }),
		windowId: Type.Integer({ minimum: 1 }),
		elementIndex: Type.Integer({ minimum: 0 }),
	}, { additionalProperties: false }),
]);

type Parameters = Static<typeof PARAMETERS>;

type DriverResult = {
	ok: boolean;
	stdout: string;
	stderr: string;
};

type DriverRunner = (command: string, args: string[]) => Promise<DriverResult>;

type Details = {
	action: Parameters["action"];
	ok: boolean;
	reason?: string;
};

const MAX_OUTPUT_BYTES = 64 * 1024;
const ALLOWED_ENVIRONMENT = [
	"HOME",
	"PATH",
	"LANG",
	"LC_ALL",
	"XDG_RUNTIME_DIR",
	"XDG_SESSION_TYPE",
	"WAYLAND_DISPLAY",
	"DISPLAY",
	"DBUS_SESSION_BUS_ADDRESS",
	"XAUTHORITY",
] as const;

function boundedText(value: string): string {
	const bytes = Buffer.from(value, "utf8");
	if (bytes.length <= MAX_OUTPUT_BYTES) return value;
	return `${bytes.subarray(0, MAX_OUTPUT_BYTES).toString("utf8")}\n[output truncated]`;
}

function driverArgs(params: Parameters): [string, string[]] {
	switch (params.action) {
		case "status": return ["doctor", ["--json"]];
		case "windows": return ["call", ["list_windows", "{}"]];
		case "capture": return ["call", ["get_window_state", JSON.stringify({ pid: params.pid, window_id: params.windowId, max_elements: 100 })]];
		case "click": return ["call", ["click", JSON.stringify({ pid: params.pid, window_id: params.windowId, element_index: params.elementIndex, delivery_mode: "background" })]];
	}
}

export function cuaEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const environment = Object.fromEntries(
		ALLOWED_ENVIRONMENT.flatMap((key) => {
			const value = source[key];
			return value === undefined ? [] : [[key, value]];
		}),
	);
	return {
		...environment,
		CUA_DRIVER_RS_TELEMETRY_ENABLED: "0",
		CUA_DRIVER_RS_UPDATE_CHECK: "false",
	};
}

export async function runCua(command: string, args: string[]): Promise<DriverResult> {
	const executable = process.env.SENPI_CUA_DRIVER_PATH ?? "cua-driver";
	const child = spawn(executable, [command, ...args], {
		env: cuaEnvironment(),
		shell: false,
		stdio: ["ignore", "pipe", "pipe"],
	});

	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk: Buffer) => { stdout = boundedText(`${stdout}${chunk.toString("utf8")}`); });
	child.stderr.on("data", (chunk: Buffer) => { stderr = boundedText(`${stderr}${chunk.toString("utf8")}`); });

	const outcome = await new Promise<{ code: number | null; error?: Error }>((resolve) => {
		child.once("error", (error: Error) => resolve({ code: null, error }));
		child.once("close", (code: number | null) => resolve({ code }));
	});
	if (outcome.error) {
		return { ok: false, stdout: "", stderr: `cua-driver unavailable: ${outcome.error.message}` };
	}
	return { ok: outcome.code === 0, stdout: boundedText(stdout), stderr: boundedText(stderr) };
}

function resultFor(params: Parameters, result: DriverResult): { content: [{ type: "text"; text: string }]; details: Details } {
	if (result.ok) return { content: [{ type: "text", text: boundedText(result.stdout) }], details: { action: params.action, ok: true } };
	return {
		content: [{ type: "text", text: boundedText(result.stderr || `cua-driver ${params.action} failed`) }],
		details: { action: params.action, ok: false, reason: "driver_failed" },
	};
}

export function createComputerUseTool({ run }: { run: DriverRunner }): ToolDefinition<typeof PARAMETERS, Details> {
	return {
		name: "computer_use",
		label: "Computer Use",
		description: "Inspect windows, capture a selected window, and click a captured accessibility element after explicit approval.",
		promptSnippet: "Use computer_use to list windows, capture a selected window, then click an element only after user approval.",
		parameters: PARAMETERS,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (params.action === "click") {
				if (!ctx.ui?.confirm) {
					return {
						content: [{ type: "text", text: "computer_use click requires interactive approval and is unavailable in this mode." }],
						details: { action: params.action, ok: false, reason: "interactive_approval_required" },
					};
				}
				const approved = await ctx.ui.confirm("Allow computer click?", `Click accessibility element ${params.elementIndex} in window ${params.windowId}.`);
				if (!approved) {
					return {
						content: [{ type: "text", text: "computer_use click was rejected by the user." }],
						details: { action: params.action, ok: false, reason: "user_rejected" },
					};
				}
			}

			const [command, args] = driverArgs(params);
			return resultFor(params, await run(command, args));
		},
	};
}
