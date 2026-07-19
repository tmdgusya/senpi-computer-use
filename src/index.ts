import type { ExtensionAPI } from "@code-yeongyu/senpi";

import { createComputerUseTool } from "./computer-use.js";
import { McpProxy } from "./mcp.js";

/**
 * Senpi computer-use extension: registers one `computer_use` tool backed by a
 * lazy persistent MCP stdio proxy to `cua-driver mcp`. The proxy starts on first
 * driver-backed action and is shut down deterministically on session shutdown.
 */
export default function computerUseExtension(pi: ExtensionAPI): void {
	const proxy = new McpProxy();
	pi.registerTool(
		createComputerUseTool({
			call: proxy.callTool,
			proxyStatus: () => proxy.status(),
		}),
	);
	pi.on("session_shutdown", async () => {
		await proxy.shutdown();
	});
}

export { createComputerUseTool, isValidImage } from "./computer-use.js";
export { McpProxy, compareVersions, spawnCuaDriverMcp } from "./mcp.js";
export { PARAMETERS, checkHardBlocks, isMutatingAction, normalizeKeyToken, toDriverInvocation } from "./actions.js";
export { cuaEnvironment, boundedText } from "./environment.js";
export { runDoctorPreflight, renderCapabilityReport } from "./doctor.js";
