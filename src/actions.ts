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

/**
 * Single action-discriminated Object schema (senpi convention: the discriminant
 * is an `action` union-literal FIELD, not a top-level Type.Union — a top-level
 * union serializes to JSON-Schema `anyOf`, which tool-calling providers deliver
 * as empty `{}` arguments). Per-action required fields are enforced at runtime by
 * `validateActionParams`.
 */
export const ACTION_NAMES = [
	"status",
	"windows",
	"capture",
	"wait",
	"click",
	"double_click",
	"right_click",
	"drag",
	"scroll",
	"type",
	"key",
	"hotkey",
	"set_value",
	"launch",
	"focus",
] as const;

export const PARAMETERS = Type.Object(
	{
		// Explicit literal tuple: a mapped `.map(Type.Literal)` array loses TypeBox
		// tuple inference and collapses the Static type to `never`.
		action: Type.Union(
			[
				Type.Literal("status"),
				Type.Literal("windows"),
				Type.Literal("capture"),
				Type.Literal("wait"),
				Type.Literal("click"),
				Type.Literal("double_click"),
				Type.Literal("right_click"),
				Type.Literal("drag"),
				Type.Literal("scroll"),
				Type.Literal("type"),
				Type.Literal("key"),
				Type.Literal("hotkey"),
				Type.Literal("set_value"),
				Type.Literal("launch"),
				Type.Literal("focus"),
			],
			{ description: "Which computer-use operation to perform." },
		),
		pid: Type.Optional(Pid),
		windowId: Type.Optional(WindowId),
		elementIndex: Type.Optional(ElementIndex),
		x: Type.Optional(Coordinate),
		y: Type.Optional(Coordinate),
		fromX: Type.Optional(Coordinate),
		fromY: Type.Optional(Coordinate),
		toX: Type.Optional(Coordinate),
		toY: Type.Optional(Coordinate),
		direction: Type.Optional(Type.Union([Type.Literal("up"), Type.Literal("down")])),
		amount: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
		ms: Type.Optional(Type.Integer({ minimum: 1, maximum: 10_000 })),
		text: Type.Optional(Type.String({ maxLength: 8192 })),
		key: Type.Optional(Type.String({ minLength: 1, maxLength: 32 })),
		keys: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 32 }), { minItems: 1, maxItems: 5 })),
		value: Type.Optional(Type.String({ maxLength: 8192 })),
		name: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
	},
	{ additionalProperties: false },
);

export type RawParameters = Static<typeof PARAMETERS>;
export type ActionName = RawParameters["action"];

/**
 * Discriminated union of fully-validated action shapes used by internal logic.
 * `validateActionParams` narrows a RawParameters into one of these.
 */
export type Parameters =
	| { action: "status" }
	| { action: "windows" }
	| { action: "capture"; pid: number; windowId?: number }
	| { action: "wait"; ms: number }
	| { action: "click" | "double_click" | "right_click"; pid: number; windowId?: number; elementIndex?: number; x?: number; y?: number }
	| { action: "drag"; pid: number; fromX: number; fromY: number; toX: number; toY: number }
	| { action: "scroll"; pid: number; direction: "up" | "down"; amount: number }
	| { action: "type"; pid: number; text: string }
	| { action: "key"; pid: number; key: string }
	| { action: "hotkey"; pid: number; keys: string[] }
	| { action: "set_value"; pid: number; elementIndex: number; value: string }
	| { action: "launch"; name: string }
	| { action: "focus"; pid: number; windowId?: number };

export type ValidationResult = { ok: true; params: Parameters } | { ok: false; error: string };

/** Enforce per-action required fields that the flat schema cannot express. */
export function validateActionParams(raw: RawParameters): ValidationResult {
	const need = (present: boolean, field: string): string | undefined => (present ? undefined : `${raw.action} requires "${field}"`);
	const pointer = (): number | undefined => (raw.elementIndex !== undefined ? undefined : raw.x !== undefined && raw.y !== undefined ? undefined : NaN);
	switch (raw.action) {
		case "status":
			return { ok: true, params: { action: "status" } };
		case "windows":
			return { ok: true, params: { action: "windows" } };
		case "wait": {
			const err = need(raw.ms !== undefined, "ms");
			return err ? { ok: false, error: err } : { ok: true, params: { action: "wait", ms: raw.ms! } };
		}
		case "capture": {
			const err = need(raw.pid !== undefined, "pid");
			return err
				? { ok: false, error: err }
				: { ok: true, params: { action: "capture", pid: raw.pid!, ...(raw.windowId === undefined ? {} : { windowId: raw.windowId }) } };
		}
		case "click":
		case "double_click":
		case "right_click": {
			const err = need(raw.pid !== undefined, "pid");
			if (err) return { ok: false, error: err };
			if (Number.isNaN(pointer())) return { ok: false, error: `${raw.action} requires either "elementIndex" or both "x" and "y"` };
			return {
				ok: true,
				params: {
					action: raw.action,
					pid: raw.pid!,
					...(raw.windowId === undefined ? {} : { windowId: raw.windowId }),
					...(raw.elementIndex === undefined ? {} : { elementIndex: raw.elementIndex }),
					...(raw.x === undefined ? {} : { x: raw.x }),
					...(raw.y === undefined ? {} : { y: raw.y }),
				},
			};
		}
		case "drag": {
			const missing = ["pid", "fromX", "fromY", "toX", "toY"].filter((f) => raw[f as keyof RawParameters] === undefined);
			return missing.length > 0
				? { ok: false, error: `drag requires ${missing.join(", ")}` }
				: { ok: true, params: { action: "drag", pid: raw.pid!, fromX: raw.fromX!, fromY: raw.fromY!, toX: raw.toX!, toY: raw.toY! } };
		}
		case "scroll": {
			const missing = ["pid", "direction", "amount"].filter((f) => raw[f as keyof RawParameters] === undefined);
			return missing.length > 0
				? { ok: false, error: `scroll requires ${missing.join(", ")}` }
				: { ok: true, params: { action: "scroll", pid: raw.pid!, direction: raw.direction!, amount: raw.amount! } };
		}
		case "type": {
			const missing = ["pid", "text"].filter((f) => raw[f as keyof RawParameters] === undefined);
			return missing.length > 0
				? { ok: false, error: `type requires ${missing.join(", ")}` }
				: { ok: true, params: { action: "type", pid: raw.pid!, text: raw.text! } };
		}
		case "key": {
			const missing = ["pid", "key"].filter((f) => raw[f as keyof RawParameters] === undefined);
			return missing.length > 0
				? { ok: false, error: `key requires ${missing.join(", ")}` }
				: { ok: true, params: { action: "key", pid: raw.pid!, key: raw.key! } };
		}
		case "hotkey": {
			const missing = ["pid", "keys"].filter((f) => raw[f as keyof RawParameters] === undefined);
			return missing.length > 0
				? { ok: false, error: `hotkey requires ${missing.join(", ")}` }
				: { ok: true, params: { action: "hotkey", pid: raw.pid!, keys: raw.keys! } };
		}
		case "set_value": {
			const missing = ["pid", "elementIndex", "value"].filter((f) => raw[f as keyof RawParameters] === undefined);
			return missing.length > 0
				? { ok: false, error: `set_value requires ${missing.join(", ")}` }
				: { ok: true, params: { action: "set_value", pid: raw.pid!, elementIndex: raw.elementIndex!, value: raw.value! } };
		}
		case "launch": {
			const err = need(raw.name !== undefined, "name");
			return err ? { ok: false, error: err } : { ok: true, params: { action: "launch", name: raw.name! } };
		}
		case "focus": {
			const err = need(raw.pid !== undefined, "pid");
			return err
				? { ok: false, error: err }
				: { ok: true, params: { action: "focus", pid: raw.pid!, ...(raw.windowId === undefined ? {} : { windowId: raw.windowId }) } };
		}
	}
	return { ok: false, error: `unknown action: ${String((raw as { action: unknown }).action)}` };
}

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
