import { describe, expect, it } from "vitest";

import { McpProxy } from "../src/mcp.js";
import { runDoctorPreflight } from "../src/doctor.js";

/**
 * Live integration against a REAL installed cua-driver. Opt-in only:
 *   SENPI_CUA_LIVE=1 npm test
 * Read-only probes; never dispatches a state-changing action.
 */
const LIVE = process.env.SENPI_CUA_LIVE === "1";
const describeLive = LIVE ? describe : describe.skip;

describeLive("live cua-driver — real MCP proxy (T1-T4, C6)", () => {
	it("starts, validates the contract, lists windows read-only, and shuts down", async () => {
		const proxy = new McpProxy();
		try {
			await proxy.ensureStarted();
			const status = proxy.status();
			expect(status.running).toBe(true);
			expect(status.session).toMatch(/^senpi-/);
			expect(status.toolCount).toBeGreaterThan(0);

			const windows = await proxy.callTool("list_windows", {});
			expect(windows.isError).toBe(false);
			expect(typeof windows.text).toBe("string");
		} finally {
			await proxy.shutdown();
			expect(proxy.status().running).toBe(false);
		}
	}, 30_000);

	it("reports a real capability matrix through the doctor preflight", async () => {
		const report = await runDoctorPreflight({
			running: false,
			generation: 0,
			session: undefined,
			driverVersion: undefined,
			toolCount: 0,
			lastFailure: undefined,
		});
		expect(report.driver).toBe("ok");
		expect(report.surfaces.displayServer).not.toBe("unknown");
		expect(["ok", "warn", "error", "unknown"]).toContain(report.surfaces.x11);
	}, 20_000);
});
