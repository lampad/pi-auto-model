export type ToolFailureKind = "validation" | "environment" | "execution" | "unknown";

/** Conservative hints, not proof of task failure or model quality. */
export function classifyToolFailure(toolName: string, result: unknown): ToolFailureKind {
	const content = (result as { content?: Array<{ type?: string; text?: string }> } | undefined)?.content;
	const text = (Array.isArray(content) ? content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n") : "").slice(0, 4096);
	if (/EACCES|EPERM|ENOENT|ENOSPC|ECONNREFUSED|ENOTFOUND|permission denied|command not found|not recognized as|no space left|network unreachable/i.test(text)) return "environment";
	if (/AssertionError|tests? failed|failing tests?|test suite failed|FAIL\s+\S|assertion failed/i.test(text)) return "validation";
	if ((toolName === "edit" && /could not find|not found|multiple matches|not unique|oldText|old text|exact match/i.test(text)) ||
		/invalid (?:arguments?|parameters?|input)|schema validation|required (?:field|parameter).*missing/i.test(text)) return "execution";
	return "unknown";
}
