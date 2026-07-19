import { spawn } from "node:child_process";

import { boundedText, cuaEnvironment, resolveDriverExecutable } from "./environment.js";
import type { ProxyStatus } from "./mcp.js";

/**
 * C6 doctor / capability reporting: distinguishes driver absence, display-server
 * readiness (X11 / XWayland / native Wayland helper), and proxy contract state.
 * Runs `cua-driver doctor --json` as a credential-free preflight process; this is
 * a diagnostic probe, not a tool-dispatch path (plan keeps tool calls MCP-only).
 */

export interface DoctorProbe {
	label: string;
	status: string;
	message: string;
}

export interface CapabilityReport {
	driver: "ok" | "missing" | "error";
	driverDetail: string;
	probes: DoctorProbe[];
	surfaces: {
		x11: "ok" | "warn" | "error" | "unknown";
		atspi: "ok" | "warn" | "error" | "unknown";
		displayServer: string;
	};
	proxy: ProxyStatus;
}

export async function runDoctorPreflight(proxy: ProxyStatus): Promise<CapabilityReport> {
	const result = await runDriverOnce(["doctor", "--json"]);
	if (result.failure !== undefined) {
		return {
			driver: result.failure === "missing" ? "missing" : "error",
			driverDetail: result.detail,
			probes: [],
			surfaces: { x11: "unknown", atspi: "unknown", displayServer: "unknown" },
			proxy,
		};
	}
	let probes: DoctorProbe[] = [];
	try {
		const parsed = JSON.parse(result.stdout) as { probes?: { label?: unknown; status?: unknown; message?: unknown }[] };
		probes = (parsed.probes ?? [])
			.filter((probe) => typeof probe.label === "string" && typeof probe.status === "string")
			.map((probe) => ({
				label: probe.label as string,
				status: probe.status as string,
				message: typeof probe.message === "string" ? probe.message : "",
			}));
	} catch {
		return {
			driver: "error",
			driverDetail: `doctor emitted unparseable output: ${boundedText(result.stdout, 512)}`,
			probes: [],
			surfaces: { x11: "unknown", atspi: "unknown", displayServer: "unknown" },
			proxy,
		};
	}
	const find = (label: string): DoctorProbe | undefined => probes.find((probe) => probe.label === label);
	const statusOf = (label: string): "ok" | "warn" | "error" | "unknown" => {
		const status = find(label)?.status;
		return status === "ok" || status === "warn" || status === "error" ? status : "unknown";
	};
	return {
		driver: "ok",
		driverDetail: find("binary")?.message ?? "cua-driver present",
		probes,
		surfaces: {
			x11: statusOf("X11 connection"),
			atspi: statusOf("AT-SPI"),
			displayServer: find("display server")?.message ?? "unknown",
		},
		proxy,
	};
}

export function renderCapabilityReport(report: CapabilityReport): string {
	const lines = [
		`driver: ${report.driver} (${report.driverDetail})`,
		`display server: ${report.surfaces.displayServer}`,
		`x11: ${report.surfaces.x11} | at-spi: ${report.surfaces.atspi}`,
		`mcp proxy: ${report.proxy.running ? `connected (generation ${report.proxy.generation}, ${report.proxy.toolCount} tools, driver ${report.proxy.driverVersion ?? "?"})` : "not connected"}`,
	];
	if (report.proxy.lastFailure !== undefined) lines.push(`last proxy failure: ${report.proxy.lastFailure}`);
	for (const probe of report.probes) {
		if (probe.status !== "ok") lines.push(`probe ${probe.label}: ${probe.status} — ${probe.message}`);
	}
	return lines.join("\n");
}

interface DriverOnceResult {
	stdout: string;
	failure?: "missing" | "failed";
	detail: string;
}

function runDriverOnce(args: string[]): Promise<DriverOnceResult> {
	return new Promise((resolve) => {
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(resolveDriverExecutable(), args, { env: cuaEnvironment(), shell: false, stdio: ["ignore", "pipe", "pipe"] });
		} catch (error) {
			resolve({ stdout: "", failure: "missing", detail: error instanceof Error ? error.message : String(error) });
			return;
		}
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout = boundedText(`${stdout}${chunk.toString("utf8")}`);
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr = boundedText(`${stderr}${chunk.toString("utf8")}`);
		});
		child.once("error", (error: NodeJS.ErrnoException) => {
			resolve({
				stdout: "",
				failure: error.code === "ENOENT" ? "missing" : "failed",
				detail: `cua-driver unavailable: ${error.message}`,
			});
		});
		child.once("close", (code) => {
			if (code === 0) resolve({ stdout, detail: "ok" });
			else resolve({ stdout, failure: "failed", detail: stderr || `cua-driver doctor exited with code ${code}` });
		});
	});
}
