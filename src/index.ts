import type { ExtensionAPI } from "@code-yeongyu/senpi";

import { createComputerUseTool, runCua } from "./computer-use.js";

export default function computerUseExtension(pi: ExtensionAPI): void {
	pi.registerTool(createComputerUseTool({ run: runCua }));
}

export { createComputerUseTool, runCua } from "./computer-use.js";
