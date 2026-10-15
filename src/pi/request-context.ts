import type { Context } from "@earendil-works/pi-ai";
import { calculateContextTokens, estimateTokens } from "@earendil-works/pi-coding-agent";

/** Use Pi's usage-plus-trailing-message estimate, not serialized transcript size. */
export function requestContextTokens(context: Context): number {
	let tokens = 0;
	let start = 0;
	for (let i = context.messages.length - 1; i >= 0; i--) {
		const message = context.messages[i];
		if (message.role === "assistant" && message.stopReason !== "error" && message.stopReason !== "aborted" &&
			message.usage && calculateContextTokens(message.usage) > 0) {
			tokens = calculateContextTokens(message.usage);
			start = i + 1;
			break;
		}
	}
	for (const message of context.messages.slice(start)) {
		// Older supported Pi versions do not recognize newer transcript roles.
		tokens += ["user", "assistant", "toolResult"].includes(message.role)
			? estimateTokens(message)
			: Math.max(estimateTokens(message), Math.ceil(JSON.stringify(message, (key, value) => key === "data" ? "" : value).length / 3));
	}
	// ponytail: legacy Context keeps system/tools outside messages; retain conservative
	// overhead even when prior usage includes it. Tokenizer-specific accounting can refine this.
	const { messages: _messages, ...overhead } = context;
	return tokens + Math.ceil(JSON.stringify(overhead).length / 3);
}
