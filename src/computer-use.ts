import type { ExtensionContext, ToolDefinition } from "@code-yeongyu/senpi";

import {
	type ActionName,
	checkHardBlocks,
	describeMutation,
	isMutatingAction,
	PARAMETERS,
	type Parameters,
	type RawParameters,
	SAFETY_POLICY_VERSION,
	toDriverInvocation,
	validateActionParams,
} from "./actions.js";
import { runDoctorPreflight, renderCapabilityReport, type CapabilityReport } from "./doctor.js";
import { boundedText, MAX_ELEMENTS, MAX_IMAGE_BYTES, MAX_TEXT_BYTES } from "./environment.js";
import type { DriverCall, ProxyStatus } from "./mcp.js";

export type FailureReason =
	| "interactive_approval_required"
	| "user_rejected"
	| "hard_blocked"
	| "stale_reference"
	| "driver_unavailable"
	| "driver_failed"
	| "unknown_outcome"
	| "aborted";

export interface Details {
	action: ActionName;
	ok: boolean;
	reason?: FailureReason;
	detail?: string;
	generation?: number;
	session?: string;
	policyVersion: number;
}

export interface ComputerUseDeps {
	call: DriverCall;
	proxyStatus: () => ProxyStatus;
	doctor?: (proxy: ProxyStatus) => Promise<CapabilityReport>;
}

interface TextBlock {
	type: "text";
	text: string;
}

interface ImageBlock {
	type: "image";
	data: string;
	mimeType: string;
}

type ResultShape = { content: (TextBlock | ImageBlock)[]; details: Details };

export function createComputerUseTool(deps: ComputerUseDeps): ToolDefinition<typeof PARAMETERS, Details> {
	const doctor = deps.doctor ?? runDoctorPreflight;
	/** Generation of the proxy at the time of the last successful capture (stale-reference guard, plan section 6). */
	let lastCaptureGeneration: number | undefined;

	const fail = (action: ActionName, reason: FailureReason, detail: string): ResultShape => ({
		content: [{ type: "text", text: boundedText(detail) }],
		details: { action, ok: false, reason, detail: boundedText(detail, 512), policyVersion: SAFETY_POLICY_VERSION },
	});

	return {
		name: "computer_use",
		label: "Computer Use",
		description:
			"Control the local desktop through cua-driver: inspect readiness (status), list windows, capture a window's accessibility elements (and a screenshot when the model accepts images), then act on captured elements (click/type/key/...). Every state-changing action requires explicit per-call user approval and is denied in non-interactive modes.",
		promptSnippet:
			"Desktop control: computer_use(action: status|windows|capture|click|type|...). Capture before acting; element indexes expire when the capture generation changes.",
		promptGuidelines: [
			"Use computer_use(action: capture, pid: ...) to read a window before clicking or typing into it; prefer elementIndex targets over raw coordinates.",
			"State-changing computer_use actions prompt the user for approval on every call; do not retry a rejected action without new user intent.",
		],
		parameters: PARAMETERS,
		executionMode: "sequential",
		async execute(_toolCallId, raw, signal, _onUpdate, ctx) {
			const validation = validateActionParams(raw);
			if (!validation.ok) {
				return fail(raw.action, "driver_failed", `computer_use ${raw.action}: ${validation.error}`);
			}
			const params: Parameters = validation.params;

			// Extension-local actions first.
			if (params.action === "status") {
				const report = await doctor(deps.proxyStatus());
				return {
					content: [{ type: "text", text: boundedText(renderCapabilityReport(report)) }],
					details: {
						action: params.action,
						ok: report.driver === "ok",
						...(report.driver === "ok" ? {} : { reason: "driver_unavailable" as const, detail: report.driverDetail }),
						generation: deps.proxyStatus().generation,
						policyVersion: SAFETY_POLICY_VERSION,
					},
				};
			}
			if (params.action === "wait") {
				await abortableSleep(params.ms, signal);
				return {
					content: [{ type: "text", text: `waited ${params.ms}ms` }],
					details: { action: params.action, ok: true, policyVersion: SAFETY_POLICY_VERSION },
				};
			}

			// Safety gate (plan SS10): hard blocks run BEFORE approval, approval before dispatch.
			if (isMutatingAction(params.action)) {
				const verdict = checkHardBlocks(params);
				if (verdict.blocked) {
					return fail(params.action, "hard_blocked", `computer_use ${params.action} refused: ${verdict.reason}`);
				}
				if (ctx.mode !== "tui") {
					return fail(
						params.action,
						"interactive_approval_required",
						`computer_use ${params.action} requires interactive approval and is denied in ${ctx.mode} mode.`,
					);
				}
				const approved = await ctx.ui.confirm("Allow computer action?", `Allow once: ${describeMutation(params)}`);
				if (!approved) {
					return fail(params.action, "user_rejected", `computer_use ${params.action} was rejected by the user.`);
				}
				// Stale-reference guard: element indexes are only valid for the generation they were captured in.
				if ("elementIndex" in params && params.elementIndex !== undefined) {
					const generation = deps.proxyStatus().generation;
					if (lastCaptureGeneration !== undefined && generation !== lastCaptureGeneration) {
						return fail(
							params.action,
							"stale_reference",
							`element ${params.elementIndex} references capture generation ${lastCaptureGeneration}, but the driver connection is now generation ${generation}; re-run capture first.`,
						);
					}
				}
			}

			const wantImage = params.action === "capture" && modelAcceptsImages(ctx);
			const invocation = toDriverInvocation(params, deps.proxyStatus().session ?? "", MAX_ELEMENTS, wantImage);
			if (invocation === undefined) {
				return fail(params.action, "driver_failed", `action ${params.action} has no driver mapping`);
			}
			const result = await deps.call(invocation.tool, invocation.args, {
				signal,
				mutating: isMutatingAction(params.action),
			});
			const status = deps.proxyStatus();

			if (result.isError) {
				const reason: FailureReason =
					result.failure === "unknown_outcome"
						? "unknown_outcome"
						: result.failure === "driver_unavailable" || result.failure === "contract_mismatch"
							? "driver_unavailable"
							: result.failure === "aborted" || result.failure === "aborted_before_dispatch"
								? "aborted"
								: "driver_failed";
				return fail(params.action, reason, result.text || `cua-driver ${invocation.tool} failed`);
			}

			if (params.action === "capture") {
				lastCaptureGeneration = status.generation;
				return assembleCaptureResult(params.action, result.text, result.structuredContent, wantImage ? result.images : [], status);
			}

			// Prefer structured window records so the model reliably gets pid/window_id.
			const text =
				params.action === "windows" && hasStructuredContent(result.structuredContent)
					? JSON.stringify(result.structuredContent)
					: result.text || `${invocation.tool} ok`;

			return {
				content: [{ type: "text", text: boundedText(text) }],
				details: {
					action: params.action,
					ok: true,
					generation: status.generation,
					...(status.session === undefined ? {} : { session: status.session }),
					policyVersion: SAFETY_POLICY_VERSION,
				},
			};
		},
	};
}

function hasStructuredContent(value: unknown): boolean {
	return typeof value === "object" && value !== null && Object.keys(value).length > 0;
}

function modelAcceptsImages(ctx: ExtensionContext): boolean {
	return ctx.model?.input.includes("image") ?? false;
}

function assembleCaptureResult(
	action: Parameters["action"],
	text: string,
	structuredContent: unknown,
	images: { data: string; mimeType: string }[],
	status: ProxyStatus,
): ResultShape {
	const elements = extractElements(structuredContent);
	const elementText =
		elements.length > 0 ? JSON.stringify({ elements: elements.slice(0, MAX_ELEMENTS) }, undefined, 1) : text;
	const primary: TextBlock = { type: "text", text: boundedText(elementText, MAX_TEXT_BYTES) };
	const content: (TextBlock | ImageBlock)[] = [primary];
	const image = images.find(isValidImage);
	if (image !== undefined) content.push({ type: "image", data: image.data, mimeType: image.mimeType });
	else if (images.length > 0) primary.text = `${primary.text}\n[screenshot dropped: failed image validation]`;
	return {
		content,
		details: {
			action,
			ok: true,
			generation: status.generation,
			...(status.session === undefined ? {} : { session: status.session }),
			policyVersion: SAFETY_POLICY_VERSION,
		},
	};
}

function extractElements(structuredContent: unknown): unknown[] {
	if (typeof structuredContent !== "object" || structuredContent === null) return [];
	const elements = (structuredContent as { elements?: unknown }).elements;
	return Array.isArray(elements) ? elements : [];
}

/** C4: at most one validated PNG/JPEG image, <= 5 MiB decoded; anything else degrades to text. */
export function isValidImage(image: { data: string; mimeType: string }): boolean {
	if (image.mimeType !== "image/png" && image.mimeType !== "image/jpeg") return false;
	let decoded: Buffer;
	try {
		decoded = Buffer.from(image.data, "base64");
	} catch {
		return false;
	}
	if (decoded.length === 0 || decoded.length > MAX_IMAGE_BYTES) return false;
	const isPng = decoded.length > 8 && decoded[0] === 0x89 && decoded[1] === 0x50 && decoded[2] === 0x4e && decoded[3] === 0x47;
	const isJpeg = decoded.length > 3 && decoded[0] === 0xff && decoded[1] === 0xd8 && decoded[2] === 0xff;
	return image.mimeType === "image/png" ? isPng : isJpeg;
}

function abortableSleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) {
			resolve();
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		function onAbort(): void {
			clearTimeout(timer);
			resolve();
		}
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
