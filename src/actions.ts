import { Type, type Static } from "typebox";

/**
 * Closed action map (plan T5): every model-visible action is enumerated here and
 * maps to exactly one driver MCP tool. Raw tool passthrough is forbidden.
 */

export const SAFETY_POLICY_VERSION = 1;

const Pid = Type.Integer({ minimum: 1 });
const WindowId = Type.Integer({ minimum: 1 });
const ElementIndex = Type.Integer({ minimum: 0 });
const Coordinate = Type.Integer({ minimum: 0 });

export const PARAMETERS = Type.Union([
	Type.Object({ action: Type.Literal("status") }, { additionalProperties: false }),
	Type.Object({ action: Type.Literal("windows") }, { additionalProperties: false }),
	Type.Object(
		{
			action: Type.Literal("capture"),
			pid: Pid,
			windowId: Type.Optional(WindowId),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{ action: Type.Literal("wait"), ms: Type.Integer({ minimum: 1, maximum: 10_000 }) },
		{ additionalProperties: false },
	),
	Type.Object(
		{
			action: Type.Literal("click"),
			pid: Pid,
			windowId: Type.Optional(WindowId),
			elementIndex: Type.Optional(ElementIndex),
			x: Type.Optional(Coordinate),
			y: Type.Optional(Coordinate),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			action: Type.Literal("double_click"),
			pid: Pid,
			windowId: Type.Optional(WindowId),
			elementIndex: Type.Optional(ElementIndex),
			x: Type.Optional(Coordinate),
			y: Type.Optional(Coordinate),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			action: Type.Literal("right_click"),
			pid: Pid,
			windowId: Type.Optional(WindowId),
			elementIndex: Type.Optional(ElementIndex),
			x: Type.Optional(Coordinate),
			y: Type.Optional(Coordinate),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			action: Type.Literal("drag"),
			pid: Pid,
			fromX: Coordinate,
			fromY: Coordinate,
			toX: Coordinate,
			toY: Coordinate,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			action: Type.Literal("scroll"),
			pid: Pid,
			direction: Type.Union([Type.Literal("up"), Type.Literal("down")]),
			amount: Type.Integer({ minimum: 1, maximum: 20 }),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{ action: Type.Literal("type"), pid: Pid, text: Type.String({ maxLength: 8192 }) },
		{ additionalProperties: false },
	),
	Type.Object(
		{ action: Type.Literal("key"), pid: Pid, key: Type.String({ minLength: 1, maxLength: 32 }) },
		{ additionalProperties: false },
	),
	Type.Object(
		{
			action: Type.Literal("hotkey"),
			pid: Pid,
			keys: Type.Array(Type.String({ minLength: 1, maxLength: 32 }), { minItems: 1, maxItems: 5 }),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			action: Type.Literal("set_value"),
			pid: Pid,
			elementIndex: ElementIndex,
			value: Type.String({ maxLength: 8192 }),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{ action: Type.Literal("launch"), name: Type.String({ minLength: 1, maxLength: 256 }) },
		{ additionalProperties: false },
	),
	Type.Object(
		{ action: Type.Literal("focus"), pid: Pid, windowId: Type.Optional(WindowId) },
		{ additionalProperties: false },
	),
]);

export type Parameters = Static<typeof PARAMETERS>;
export type ActionName = Parameters["action"];

/** Safe actions never mutate desktop state (plan SS10). Everything else is allow-once approved. */
const SAFE_ACTIONS: ReadonlySet<ActionName> = new Set(["status", "windows", "capture", "wait"]);

export function isMutatingAction(action: ActionName): boolean {
	return !SAFE_ACTIONS.has(action);
}

/**
 * Catastrophic hotkey families (Linux tier v1). Subset semantics: a requested
 * combo that CONTAINS every key of a blocked family is blocked (round-5 remediation).
 */
const BLOCKED_HOTKEY_FAMILIES: readonly (readonly string[])[] = [
	["ctrl", "alt", "delete"],
	["ctrl", "alt", "backspace"],
	["alt", "sysrq"],
	["super", "l"],
	["ctrl", "alt", "l"],
	...Array.from({ length: 12 }, (_, i) => ["ctrl", "alt", `f${i + 1}`]),
];

const KEY_ALIASES: Record<string, string> = {
	control: "ctrl",
	meta: "super",
	win: "super",
	windows: "super",
	cmd: "super",
	command: "super",
	del: "delete",
	esc: "escape",
	return: "enter",
	option: "alt",
};

export function normalizeKeyToken(token: string): string {
	const lowered = token.trim().toLowerCase();
	return KEY_ALIASES[lowered] ?? lowered;
}

export type HardBlockVerdict = { blocked: false } | { blocked: true; reason: string };

export function checkHardBlocks(params: Parameters): HardBlockVerdict {
	if (params.action === "hotkey") {
		const requested = new Set(params.keys.map(normalizeKeyToken));
		for (const family of BLOCKED_HOTKEY_FAMILIES) {
			if (family.every((key) => requested.has(key))) {
				return { blocked: true, reason: `hotkey combination [${family.join("+")}] is unconditionally blocked (policy v${SAFETY_POLICY_VERSION})` };
			}
		}
	}
	if (params.action === "key" && normalizeKeyToken(params.key) === "sysrq") {
		return { blocked: true, reason: `key "sysrq" is unconditionally blocked (policy v${SAFETY_POLICY_VERSION})` };
	}
	if ((params.action === "type" || params.action === "set_value") && containsControlCharacters(params.action === "type" ? params.text : params.value)) {
		return {
			blocked: true,
			reason: `text containing non-printable control characters is unconditionally blocked (policy v${SAFETY_POLICY_VERSION})`,
		};
	}
	return { blocked: false };
}

function containsControlCharacters(text: string): boolean {
	for (const char of text) {
		const code = char.codePointAt(0)!;
		if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return true;
		if (code === 0x7f) return true;
	}
	return false;
}

export interface DriverInvocation {
	tool: string;
	args: Record<string, unknown>;
}

/**
 * Map a validated action to its driver MCP tool invocation.
 * `session` is the runtime-local logical CUA session id (plan section 6).
 * Returns undefined for extension-local actions (status, wait).
 */
export function toDriverInvocation(params: Parameters, session: string, maxElements: number, wantScreenshot: boolean): DriverInvocation | undefined {
	switch (params.action) {
		case "status":
		case "wait":
			return undefined;
		case "windows":
			return { tool: "list_windows", args: { session } };
		case "capture":
			return {
				tool: "get_window_state",
				args: {
					pid: params.pid,
					...(params.windowId === undefined ? {} : { window_id: params.windowId }),
					max_elements: maxElements,
					include_screenshot: wantScreenshot,
					session,
				},
			};
		case "click":
		case "double_click":
		case "right_click":
			return {
				tool: params.action,
				args: {
					pid: params.pid,
					...(params.windowId === undefined ? {} : { window_id: params.windowId }),
					...(params.elementIndex === undefined ? {} : { element_index: params.elementIndex }),
					...(params.x === undefined ? {} : { x: params.x }),
					...(params.y === undefined ? {} : { y: params.y }),
					session,
				},
			};
		case "drag":
			return {
				tool: "drag",
				args: { pid: params.pid, from_x: params.fromX, from_y: params.fromY, to_x: params.toX, to_y: params.toY, session },
			};
		case "scroll":
			return { tool: "scroll", args: { pid: params.pid, direction: params.direction, amount: params.amount, session } };
		case "type":
			return { tool: "type_text", args: { pid: params.pid, text: params.text, session } };
		case "key":
			return { tool: "press_key", args: { pid: params.pid, key: params.key, session } };
		case "hotkey":
			return { tool: "hotkey", args: { pid: params.pid, keys: params.keys, session } };
		case "set_value":
			return { tool: "set_value", args: { pid: params.pid, element_index: params.elementIndex, value: params.value, session } };
		case "launch":
			return { tool: "launch_app", args: { name: params.name, session } };
		case "focus":
			return {
				tool: "bring_to_front",
				args: { pid: params.pid, ...(params.windowId === undefined ? {} : { window_id: params.windowId }), session },
			};
	}
}

/** One-line human description used in the allow-once approval prompt. */
export function describeMutation(params: Parameters): string {
	switch (params.action) {
		case "click":
		case "double_click":
		case "right_click":
			return `${params.action.replace("_", " ")} on ${params.elementIndex !== undefined ? `element ${params.elementIndex}` : `(${params.x},${params.y})`} in pid ${params.pid}`;
		case "drag":
			return `drag (${params.fromX},${params.fromY}) -> (${params.toX},${params.toY}) in pid ${params.pid}`;
		case "scroll":
			return `scroll ${params.direction} x${params.amount} in pid ${params.pid}`;
		case "type":
			return `type ${params.text.length} chars into pid ${params.pid}`;
		case "key":
			return `press key "${params.key}" in pid ${params.pid}`;
		case "hotkey":
			return `press hotkey ${params.keys.join("+")} in pid ${params.pid}`;
		case "set_value":
			return `set value on element ${params.elementIndex} in pid ${params.pid}`;
		case "launch":
			return `launch app "${params.name}"`;
		case "focus":
			return `bring pid ${params.pid} to foreground (focus change)`;
		default:
			return params.action;
	}
}
