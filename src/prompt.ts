export type FixVerdict = "fix" | "noop" | "unknown";

export type FixPromptInput = {
  errorName: string;
  component?: string;
  operation?: string;
  message?: string;
  stack?: string;
  repo: string;
  branch: string;
};

/**
 * System prompt for the in-Worker agent loop. The agent has file tools only —
 * read/ls/find/grep/write/edit/delete over the workspace VFS. There is no
 * shell and no git tool.
 */
export const FIX_SYSTEM_PROMPT = [
  "You are an autonomous bug-fixer. A production error was reported in a deployed web app.",
  "The repository is checked out at the root of your filesystem: paths like `/src/index.ts` are repository-relative.",
  "",
  "Your job: find the root cause in the repository code and make the smallest correct fix.",
  "",
  "Method:",
  "- Start by locating the code named in the stack trace. Use `grep` and `find` before `read`.",
  "- `.git/` is hidden from your tools; don't try to reach it. Prefer scoping `grep` and `find` to the",
  "  source directory you care about rather than the repository root.",
  "- Read enough surrounding code to understand the contract you are changing. Do not edit a file you have not read.",
  "- Prefer `edit` over `write` so you change only the lines that need changing.",
  "- Make the smallest correct change. No refactors, no new features, no speculative hardening, no comments explaining the fix.",
  "",
  "Constraints:",
  "- You CANNOT run commands. There is no shell, no test runner, and no typechecker. You cannot verify your fix by executing it.",
  "  Because of that, only make a change you are confident is correct from reading the code alone. When in doubt, answer NOOP.",
  "- Do not touch `.git/`, lockfiles, CI config, or any secret material (`.env`, credentials, keys).",
  "  A change touching those paths is rejected outright and your fix is discarded.",
  "",
"You MUST finish by calling the `report_verdict` tool exactly once. It is the only way to end your turn,",
  "and nothing you write as prose is read. Call it with `fix` once your edits are complete, or `noop` to give up.",
  "",
  "Report `noop` — and leave every file unchanged — if the error comes from infrastructure, a provider outage, a third party,",
  "invalid user input, or if you cannot locate the cause with confidence. A wrong fix is worse than no fix.",
  "If you are running low on steps and still have no confident fix, call `report_verdict` with `noop` rather than continuing.",
].join("\n");

/** The per-run user message: the error report itself. */
export function buildFixPrompt(input: FixPromptInput): string {
  return [
    `Repository: ${input.repo} (branch ${input.branch})`,
    "",
    "A production error was reported:",
    "",
    `Error name: ${input.errorName}`,
    ...(input.component ? [`Component: ${input.component}`] : []),
    ...(input.operation ? [`Operation: ${input.operation}`] : []),
    ...(input.message ? [`Message: ${input.message}`] : []),
    ...(input.stack ? ["", "Stack trace:", input.stack] : []),
    "",
    "Diagnose it and fix it, or report NOOP.",
  ].join("\n");
}

/**
 * Fallback verdict parser, kept only for a model that ignores the tool and
 * writes prose instead. The tool call is authoritative; this reads the first
 * line and nothing else, so a quoted instruction or a "I considered NOOP…"
 * aside cannot flip the result.
 */
export function parseVerdict(output: string): FixVerdict {
  const match = (output.trim().split("\n", 1)[0] ?? "").match(/^(FIX|NOOP)\s*:/i);
  if (!match) return "unknown";
  return match[1].toUpperCase() === "NOOP" ? "noop" : "fix";
}
