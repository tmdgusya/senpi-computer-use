import { describe, expect, it, vi } from "vitest";

import { createComputerUseTool, cuaEnvironment, runCua } from "../src/computer-use.js";

describe("computer_use", () => {
	it("returns driver status without exposing credentials", async () => {
		const run = vi.fn(async () => ({ ok: true, stdout: '{"ok":true}', stderr: "" }));
		const tool = createComputerUseTool({ run });

		const result = await tool.execute("call-1", { action: "status" }, undefined, undefined, {} as never);

		expect(run).toHaveBeenCalledWith("doctor", ["--json"]);
		expect(result.content).toEqual([{ type: "text", text: '{"ok":true}' }]);
	});

	it("fails closed for mutating actions before invoking the driver", async () => {
		const run = vi.fn();
		const tool = createComputerUseTool({ run });

		const result = await tool.execute("call-2", { action: "click", pid: 42, windowId: 99, elementIndex: 3 }, undefined, undefined, {} as never);

		expect(run).not.toHaveBeenCalled();
		expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("requires interactive approval") });
	});

	it("lists X11 windows through the driver", async () => {
		const run = vi.fn(async () => ({ ok: true, stdout: '{"windows":[]}', stderr: "" }));
		const tool = createComputerUseTool({ run });

		const result = await tool.execute("call-3", { action: "windows" }, undefined, undefined, {} as never);

		expect(run).toHaveBeenCalledWith("call", ["list_windows", "{}"]);
		expect(result.content).toEqual([{ type: "text", text: '{"windows":[]}' }]);
	});


	it("disables driver telemetry in its child environment", () => {
		const environment = cuaEnvironment({ PATH: "/bin", OPENAI_API_KEY: "secret" });

		expect(environment.CUA_DRIVER_RS_TELEMETRY_ENABLED).toBe("0");
		expect(environment.CUA_DRIVER_RS_UPDATE_CHECK).toBe("false");
		expect(environment.OPENAI_API_KEY).toBeUndefined();
	});


	it("captures a selected window through get_window_state", async () => {
		const run = vi.fn(async () => ({ ok: true, stdout: '{"structuredContent":{"elements":[{"element_index":3,"label":"OK"}]}}', stderr: "" }));
		const tool = createComputerUseTool({ run });

		const result = await tool.execute("call-4", { action: "capture", pid: 42, windowId: 99 }, undefined, undefined, {} as never);

		expect(run).toHaveBeenCalledWith("call", ["get_window_state", '{"pid":42,"window_id":99,"max_elements":100}']);
		expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("element_index") });
	});

	it("clicks only after interactive approval", async () => {
		const run = vi.fn(async () => ({ ok: true, stdout: '{"verified":true}', stderr: "" }));
		const tool = createComputerUseTool({ run });
		const ui = { confirm: vi.fn(async () => true) };

		const result = await tool.execute(
			"call-5",
			{ action: "click", pid: 42, windowId: 99, elementIndex: 3 },
			undefined,
			undefined,
			{ ui } as never,
		);

		expect(ui.confirm).toHaveBeenCalledOnce();
		expect(run).toHaveBeenCalledWith("call", ["click", '{"pid":42,"window_id":99,"element_index":3,"delivery_mode":"background"}']);
		expect(result.details).toMatchObject({ ok: true });
	});


	it("returns a structured failure when cua-driver is missing", async () => {
		const original = process.env.SENPI_CUA_DRIVER_PATH;
		process.env.SENPI_CUA_DRIVER_PATH = "/definitely/missing/cua-driver";
		try {
			await expect(runCua("doctor", ["--json"])).resolves.toMatchObject({ ok: false });
		} finally {
			if (original === undefined) delete process.env.SENPI_CUA_DRIVER_PATH;
			else process.env.SENPI_CUA_DRIVER_PATH = original;
		}
	});

});
