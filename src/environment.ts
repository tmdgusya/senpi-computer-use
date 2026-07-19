/** Shared child-process environment sanitization and output bounds. */

export const MAX_TEXT_BYTES = 64 * 1024;
export const MAX_ELEMENTS = 100;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Base64 of 5 MiB plus JSON-RPC envelope headroom. */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

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

export function boundedText(value: string, maxBytes: number = MAX_TEXT_BYTES): string {
	const bytes = Buffer.from(value, "utf8");
	if (bytes.length <= maxBytes) return value;
	// Avoid splitting a multi-byte sequence: toString drops a trailing partial code point,
	// but re-encode-check keeps the boundary clean.
	let end = maxBytes;
	while (end > 0 && (bytes[end]! & 0b1100_0000) === 0b1000_0000) end--;
	return `${bytes.subarray(0, end).toString("utf8")}\n[output truncated]`;
}

export function resolveDriverExecutable(source: NodeJS.ProcessEnv = process.env): string {
	return source.SENPI_CUA_DRIVER_PATH ?? "cua-driver";
}
