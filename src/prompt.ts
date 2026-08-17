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
  "- Never search or read under `.git/` — it holds compressed pack data, not source. Scope every",
  "  `grep` and `find` to the source directory you care about rather than the repository root.",
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
  "Finish by replying with exactly one marker as the FIRST line of your final message:",
  "  FIX: <one-line summary of what you changed>",
  "  NOOP: <one-line reason this cannot be fixed by a code change in this repo>",
  "",
  "Answer NOOP — and leave every file unchanged — if the error comes from infrastructure, a provider outage, a third party,",
  "invalid user input, or if you cannot locate the cause with confidence. A wrong fix is worse than no fix, because it ships.",
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
 * Extract the FIX/NOOP verdict from the agent's final message.
 *
 * Only the first line counts, as the prompt demands. Scanning the whole
 * message would let prose like "I first considered NOOP: … but settled on
 * FIX: …" resolve by whichever marker appears earlier, and would match a
 * quoted copy of the instructions.
 */
export function parseVerdict(output: string): FixVerdict {
  const match = (output.trim().split("\n", 1)[0] ?? "").match(/^(FIX|NOOP)\s*:/i);
  if (!match) return "unknown";
  return match[1].toUpperCase() === "NOOP" ? "noop" : "fix";
}
