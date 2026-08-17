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
 * The prompt handed to pi. The agent edits files in the checked-out repo but
 * must never commit/push (the orchestrator owns git and the GitHub token).
 * A single FIX/NOOP marker on the first line of the final reply is the verdict.
 */
export function buildFixPrompt(input: FixPromptInput): string {
  return [
    `You are an autonomous bug-fixer working inside the repository checked out at /tmp/repo (branch ${input.branch}).`,
    "A production error was reported. Diagnose the root cause in the repository code and make the smallest correct fix.",
    "",
    `Error name: ${input.errorName}`,
    ...(input.component ? [`Component: ${input.component}`] : []),
    ...(input.operation ? [`Operation: ${input.operation}`] : []),
    ...(input.message ? [`Message: ${input.message}`] : []),
    ...(input.stack ? ["Stack trace:", input.stack] : []),
    "",
    "Rules:",
    "- Read the repository first to understand the code before changing anything.",
    "- Make the smallest correct change. Do not add features, refactors, or speculative code.",
    "- You may run shell commands to verify (for example pnpm test, pnpm typecheck, pnpm lint).",
    "- Do NOT run git commit, git push, or any command that mutates git history. The pipeline handles commit and push.",
    "- Do NOT read or write secret files (.env, credentials, keys).",
    "",
    "When finished, reply with exactly one marker as the FIRST line of your final message:",
    "  FIX: <one-line summary of what you changed>",
    "  NOOP: <one-line reason this cannot be fixed by a code change in this repo>",
    "",
    "If the error is caused by infrastructure, a provider outage, invalid user input, a third party, or cannot be reproduced or understood, you MUST reply NOOP and leave the repository unchanged.",
  ].join("\n");
}

/** Extract the FIX/NOOP verdict from pi's printed output. */
export function parseVerdict(output: string): FixVerdict {
  const match = output.match(/^\s*(FIX|NOOP)\s*:/m);
  if (!match) return "unknown";
  return match[1].toUpperCase() === "NOOP" ? "noop" : "fix";
}
