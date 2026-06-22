import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import type { HFModelItem, RetryConfig } from "./types";
import { OpenAIFunctionToolDef } from "./openai/openaiTypes";

import { logger } from "./logger";

const RETRY_MAX_ATTEMPTS = 3;
const RETRY_INTERVAL_MS = 1000;
const RETRY_BACKOFF_FACTOR = 2;
const RETRY_MAX_INTERVAL_MS = 60000;

// HTTP status codes that should trigger a retry
const RETRYABLE_STATUS_CODES = [429, 500, 502, 503, 504];

// Network error patterns to retry
const networkErrorPatterns = [
	"fetch failed",
	"ECONNRESET",
	"ETIMEDOUT",
	"ENOTFOUND",
	"ECONNREFUSED",
	"timeout",
	"TIMEOUT",
	"network error",
	"NetworkError",
];

export interface ImageInfo {
	filePath?: string;
	mimeType: string;
	base64Data: string;
	dataUrl?: string;
}

// Model ID parsing helper
export interface ParsedModelId {
	baseId: string;
	configId?: string;
}

export function getModelProviderId(model: unknown): string {
	if (!model || typeof model !== "object") {
		return "";
	}
	const obj = model as Record<string, unknown>;
	const pick = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
	return (
		pick(obj.owned_by) ||
		pick(obj.provide) ||
		pick(obj.provider) ||
		pick(obj.ownedBy) ||
		pick(obj.owner) ||
		pick(obj.vendor)
	);
}

export function normalizeUserModels(models: unknown): HFModelItem[] {
	const list = Array.isArray(models) ? models : [];
	const out: HFModelItem[] = [];
	for (const item of list) {
		if (!item || typeof item !== "object") {
			continue;
		}
		const provider = getModelProviderId(item);
		out.push({ ...(item as HFModelItem), owned_by: provider });
	}
	return out;
}

/**
 * Parse a model ID that may contain a configuration ID separator.
 * Format: "baseId::configId" or just "baseId"
 */
export function parseModelId(modelId: string): ParsedModelId {
	const parts = modelId.split("::");
	if (parts.length >= 2) {
		return {
			baseId: parts[0],
			configId: parts.slice(1).join("::"), // In case configId itself contains '::'
		};
	}
	return {
		baseId: modelId,
	};
}

/**
 * Map VS Code message role to OpenAI message role string.
 * @param message The message whose role is mapped.
 */
export function mapRole(message: vscode.LanguageModelChatRequestMessage): "user" | "assistant" | "system" {
	const USER = vscode.LanguageModelChatMessageRole.User as unknown as number;
	const ASSISTANT = vscode.LanguageModelChatMessageRole.Assistant as unknown as number;
	const r = message.role as unknown as number;
	if (r === USER) {
		return "user";
	}
	if (r === ASSISTANT) {
		return "assistant";
	}
	return "system";
}

/**
 * Convert VS Code tool definitions to OpenAI function tool definitions.
 * @param options Request options containing tools and toolMode.
 */
export function convertToolsToOpenAI(options?: vscode.ProvideLanguageModelChatResponseOptions): {
	tools?: OpenAIFunctionToolDef[];
	tool_choice?: "auto" | { type: "function"; function: { name: string } };
} {
	const tools = options?.tools ?? [];
	if (!tools || tools.length === 0) {
		return {};
	}

	const toolDefs: OpenAIFunctionToolDef[] = tools
		.filter((t) => t && typeof t === "object")
		.map((t) => {
			const name = t.name;
			const description = typeof t.description === "string" ? t.description : "";
			const params = t.inputSchema ?? { type: "object", properties: {} };
			return {
				type: "function" as const,
				function: {
					name,
					description,
					parameters: params,
				},
			} satisfies OpenAIFunctionToolDef;
		});

	let tool_choice: "auto" | { type: "function"; function: { name: string } } = "auto";
	if (options?.toolMode === vscode.LanguageModelChatToolMode.Required) {
		if (tools.length !== 1) {
			console.error("[OAI Compatible Model Provider] ToolMode.Required but multiple tools:", tools.length);
			throw new Error("LanguageModelChatToolMode.Required is not supported with more than one tool");
		}
		tool_choice = { type: "function", function: { name: tools[0].name } };
	}

	return { tools: toolDefs, tool_choice };
}

export interface OpenAIResponsesFunctionToolDef {
	type: "function";
	name: string;
	description?: string;
	parameters?: object;
}

export type OpenAIResponsesToolChoice = "auto" | { type: "function"; name: string };

/**
 * Convert VS Code tool definitions to OpenAI Responses API tool definitions.
 * Responses uses `{ type:"function", name, description, parameters }` (no nested `function` object).
 */
export function convertToolsToOpenAIResponses(options?: vscode.ProvideLanguageModelChatResponseOptions): {
	tools?: OpenAIResponsesFunctionToolDef[];
	tool_choice?: OpenAIResponsesToolChoice;
} {
	const toolConfig = convertToolsToOpenAI(options);
	if (!toolConfig.tools || toolConfig.tools.length === 0) {
		return {};
	}

	const tools: OpenAIResponsesFunctionToolDef[] = toolConfig.tools.map((t) => {
		const out: OpenAIResponsesFunctionToolDef = {
			type: "function",
			name: t.function.name,
		};
		if (t.function.description) {
			out.description = t.function.description;
		}
		if (t.function.parameters) {
			out.parameters = t.function.parameters;
		}
		return out;
	});

	let tool_choice: OpenAIResponsesToolChoice | undefined;
	if (toolConfig.tool_choice === "auto") {
		tool_choice = "auto";
	} else if (toolConfig.tool_choice?.type === "function") {
		tool_choice = { type: "function", name: toolConfig.tool_choice.function.name };
	}

	return { tools, tool_choice };
}

/**
 * 检查是否为图片MIME类型
 */
export function isImageMimeType(mimeType: string): boolean {
	return mimeType.startsWith("image/") && ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(mimeType);
}

/**
 * 创建图片的data URL
 */
export function createDataUrl(dataPart: vscode.LanguageModelDataPart): string {
	const base64Data = Buffer.from(dataPart.data).toString("base64");
	return `data:${dataPart.mimeType};base64,${base64Data}`;
}

export function getImageMimeTypeFromPath(filePath: string | undefined): string | undefined {
	const lower = String(filePath || "").toLowerCase();
	if (lower.endsWith(".png")) {
		return "image/png";
	}
	if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) {
		return "image/jpeg";
	}
	if (lower.endsWith(".gif")) {
		return "image/gif";
	}
	if (lower.endsWith(".webp")) {
		return "image/webp";
	}
	return undefined;
}

function normalizeToolInput(input: unknown): unknown {
	if (typeof input === "string") {
		try {
			const parsed = JSON.parse(input);
			return parsed && typeof parsed === "object" ? parsed : {};
		} catch {
			return {};
		}
	}
	return typeof input === "object" ? input : {};
}

function collectCandidateImagePaths(input: unknown, seen = new Set<object>()): string[] {
	const out: string[] = [];
	const visit = (value: unknown, keyHint?: string) => {
		if (value === undefined || value === null) {
			return;
		}
		if (typeof value === "string") {
			const key = String(keyHint || "").toLowerCase();
			if (/^(file|filepath|path|image|imagepath|uri|url|filename)$/.test(key) || /path|image|file|uri|url/.test(key)) {
				const candidate = normalizeImagePathLikeString(value);
				if (getImageMimeTypeFromPath(candidate)) {
					out.push(candidate);
				}
			}
			return;
		}
		if (Array.isArray(value)) {
			for (const item of value) {
				visit(item, keyHint);
			}
			return;
		}
		if (typeof value === "object") {
			if (seen.has(value)) {
				return;
			}
			seen.add(value);
			for (const [key, nested] of Object.entries(value)) {
				visit(nested, key);
			}
		}
	};
	visit(normalizeToolInput(input), "");
	return [...new Set(out)];
}

export function createDataUrlFromImageInfo(imageInfo: ImageInfo): string {
	return imageInfo.dataUrl ?? `data:${imageInfo.mimeType};base64,${imageInfo.base64Data}`;
}

function normalizeImagePathLikeString(value: string): string {
	let normalized = String(value || "").trim();
	normalized = normalized.replace(/^["'`“”‘’「『《\[\(（<]+|["'`“”‘’」』》\]\)）>]+$/g, "");
	normalized = normalized.replace(/[),.;，。；）]+$/g, "");
	if (normalized.startsWith("file://")) {
		try {
			normalized = decodeURIComponent(new URL(normalized).pathname);
			if (/^\/[a-zA-Z]:\//.test(normalized)) {
				normalized = normalized.slice(1);
			}
			normalized = normalized.replace(/\//g, path.sep);
		} catch {
			/* ignore invalid file URLs */
		}
	}
	return normalized;
}

function getWorkspaceRootPaths(): string[] {
	const folders = vscode.workspace?.workspaceFolders;
	if (!Array.isArray(folders)) {
		return [];
	}
	return folders.map((folder) => folder?.uri?.fsPath).filter((fsPath): fsPath is string => typeof fsPath === "string" && !!fsPath.trim());
}

function resolveImagePathCandidates(filePath: string): string[] {
	const normalized = normalizeImagePathLikeString(filePath);
	if (!normalized) {
		return [];
	}
	if (path.isAbsolute(normalized)) {
		return [normalized];
	}
	const candidates: string[] = [];
	for (const root of getWorkspaceRootPaths()) {
		candidates.push(path.resolve(root, normalized));
	}
	candidates.push(path.resolve(normalized));
	return [...new Set(candidates)];
}

function readImageInfoFromPathLikeString(value: string): ImageInfo | undefined {
	for (const filePath of resolveImagePathCandidates(value)) {
		const mimeType = getImageMimeTypeFromPath(filePath);
		if (!mimeType || !isImageMimeType(mimeType) || !fs.existsSync(filePath)) {
			continue;
		}
		const base64Data = fs.readFileSync(filePath).toString("base64");
		return { filePath, mimeType, base64Data, dataUrl: `data:${mimeType};base64,${base64Data}` };
	}
	return undefined;
}

export function readImageInfosFromText(text: string): ImageInfo[] {
	const source = String(text || "");
	const candidates: string[] = [];
	const quoted = /["'`“”‘’「『《\[\(（<]([^"'`“”‘’」』》\]\)）>]+?\.(?:png|jpe?g|gif|webp))["'`“”‘’」』》\]\)）>]?/gi;
	let match: RegExpExecArray | null;
	while ((match = quoted.exec(source)) !== null) {
		candidates.push(match[1]);
	}
	const unquoted = /(?:file:\/\/[^\s"'`<>]+?\.(?:png|jpe?g|gif|webp)|[a-zA-Z]:[\\/][^\s"'`<>]+?\.(?:png|jpe?g|gif|webp)|\/[^\s"'`<>]+?\.(?:png|jpe?g|gif|webp)|(?:\.\.?[\\/])+[^\s"'`<>]+?\.(?:png|jpe?g|gif|webp)|[^\s"'`<>]+[\\/][^\s"'`<>]+?\.(?:png|jpe?g|gif|webp)|[^\s"'`<>]+?\.(?:png|jpe?g|gif|webp))/gi;
	while ((match = unquoted.exec(source)) !== null) {
		candidates.push(match[0]);
	}

	const out: ImageInfo[] = [];
	const seen = new Set<string>();
	for (const candidate of candidates) {
		try {
			const info = readImageInfoFromPathLikeString(candidate);
			if (info?.filePath && !seen.has(info.filePath)) {
				seen.add(info.filePath);
				out.push(info);
			}
		} catch (error) {
			logger.warn("text-image.read-failed", {
				filePath: candidate,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return out;
}

function readImageInfosFromToolInput(input: unknown): ImageInfo[] {
	const infos: ImageInfo[] = [];
	for (const filePath of collectCandidateImagePaths(input)) {
		try {
			if (!fs.existsSync(filePath)) {
				continue;
			}
			const mimeType = getImageMimeTypeFromPath(filePath);
			if (!mimeType || !isImageMimeType(mimeType)) {
				continue;
			}
			const base64Data = fs.readFileSync(filePath).toString("base64");
			infos.push({ filePath, mimeType, base64Data, dataUrl: `data:${mimeType};base64,${base64Data}` });
		} catch (error) {
			logger.warn("tool-result.image.read-failed", {
				filePath,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return infos;
}

/**
 * Type guard for LanguageModelToolResultPart-like values.
 * @param value Unknown value to test.
 */
export function isToolResultPart(value: unknown): value is { callId: string; content?: ReadonlyArray<unknown> } {
	if (!value || typeof value !== "object") {
		return false;
	}
	const obj = value as Record<string, unknown>;
	const hasCallId = typeof obj.callId === "string";
	const hasContent = "content" in obj;
	return hasCallId && hasContent;
}

/**
 * Concatenate tool result content into a single text string.
 * @param pr Tool result-like object with content array.
 */
export function collectToolResultText(pr: { content?: ReadonlyArray<unknown> }): string {
	return collectToolResultContent(pr).text;
}

export function collectToolResultContent(
	pr: { content?: ReadonlyArray<unknown> },
	toolInput?: unknown
): { text: string; images: ImageInfo[] } {
	let text = "";
	const images: ImageInfo[] = [];
	for (const c of pr.content ?? []) {
		if (c instanceof vscode.LanguageModelTextPart) {
			text += c.value;
		} else if (typeof c === "string") {
			text += c;
		} else if (c instanceof vscode.LanguageModelDataPart && c.mimeType === "cache_control") {
			/* ignore */
		} else if (c instanceof vscode.LanguageModelDataPart && isImageMimeType(c.mimeType)) {
			const base64Data = Buffer.from(c.data).toString("base64");
			images.push({ mimeType: c.mimeType, base64Data, dataUrl: `data:${c.mimeType};base64,${base64Data}` });
		} else {
			try {
				text += JSON.stringify(c);
			} catch {
				/* ignore */
			}
		}
	}
	if (images.length === 0 && toolInput) {
		const fromFiles = readImageInfosFromToolInput(toolInput);
		images.push(...fromFiles);
		for (const image of fromFiles) {
			if (image.filePath) {
				text += `${text ? "\n" : ""}[OAICopilot attached image from tool input path: ${image.filePath}]`;
			}
		}
	}
	if (images.length === 0 && /vscode-chat-response-resource:\/\//.test(text)) {
		text += `${text ? "\n" : ""}[OAICopilot note: the tool result contained a VS Code internal image resource URI but no transferable image bytes. If the original tool call included a local image path, OAICopilot will attach it automatically; otherwise attach the image directly.]`;
	}
	return { text, images };
}

/**
 * Try to parse a JSON object from a string.
 * @param text The input string.
 * @returns Parsed object or ok:false.
 */
export function tryParseJSONObject(text: string): { ok: true; value: Record<string, unknown> } | { ok: false } {
	try {
		if (!text || !/[{]/.test(text)) {
			return { ok: false };
		}
		const value = JSON.parse(text);
		if (value && typeof value === "object" && !Array.isArray(value)) {
			return { ok: true, value };
		}
		return { ok: false };
	} catch {
		return { ok: false };
	}
}

/**
 * Create retry configuration from VS Code workspace settings.
 * @returns Retry configuration with default values.
 */
export function createRetryConfig(): RetryConfig {
	const config = vscode.workspace.getConfiguration();
	const retryConfig = config.get<RetryConfig>("oaicopilot.retry", {
		enabled: true,
		max_attempts: RETRY_MAX_ATTEMPTS,
		interval_ms: RETRY_INTERVAL_MS,
	});

	return {
		enabled: retryConfig.enabled ?? true,
		max_attempts: retryConfig.max_attempts ?? RETRY_MAX_ATTEMPTS,
		interval_ms: retryConfig.interval_ms ?? RETRY_INTERVAL_MS,
		status_codes: retryConfig.status_codes,
	};
}

/**
 * Execute a function with retry logic for rate limiting.
 * @param fn The async function to execute
 * @param retryConfig Retry configuration
 * @param token Cancellation token
 * @returns Result of the function execution
 */
export async function executeWithRetry<T>(fn: () => Promise<T>, retryConfig: RetryConfig): Promise<T> {
	if (!retryConfig.enabled) {
		return await fn();
	}

	const maxAttempts = retryConfig.max_attempts ?? RETRY_MAX_ATTEMPTS;
	const baseIntervalMs = retryConfig.interval_ms ?? RETRY_INTERVAL_MS;
	// Merge user-configured status codes with default ones, removing duplicates
	const retryableStatusCodes = retryConfig.status_codes
		? [...new Set([...RETRYABLE_STATUS_CODES, ...retryConfig.status_codes])]
		: RETRYABLE_STATUS_CODES;
	let lastError: Error | undefined;

	for (let attempt = 0; attempt <= maxAttempts; attempt++) {
		try {
			return await fn();
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));

			// Check if error is retryable based on status codes
			const isRetryableStatusError = retryableStatusCodes.some((code) => lastError?.message.includes(`[${code}]`));
			// Check if error is retryable based on network error patterns
			const isRetryableNetworkError = networkErrorPatterns.some((pattern) => lastError?.message.includes(pattern));
			const isRetryableError = isRetryableStatusError || isRetryableNetworkError;

			if (!isRetryableError || attempt === maxAttempts) {
				throw lastError;
			}

			// Exponential backoff: interval doubles each attempt, capped at 60s
			const delayMs = Math.min(baseIntervalMs * Math.pow(RETRY_BACKOFF_FACTOR, attempt), RETRY_MAX_INTERVAL_MS);

			logger.warn("retry.attempt", {
				attempt: attempt + 1,
				maxAttempts,
				delayMs,
				errorName: lastError.name,
				errorMessage: lastError.message,
			});

			console.error(
				`[OAI Compatible Model Provider] Retryable error detected, retrying in ${delayMs}ms (attempt ${attempt + 1}/${maxAttempts}). Error:`,
				lastError instanceof Error ? { name: lastError.name, message: lastError.message } : String(lastError)
			);

			// Wait for the calculated interval before retrying
			await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
		}
	}

	// This should never be reached, but TypeScript needs it
	logger.error("retry.exhausted", {
		maxAttempts,
		lastError: lastError ? { name: lastError.name, message: lastError.message } : String(lastError),
	});
	throw lastError || new Error("Retry failed");
}
