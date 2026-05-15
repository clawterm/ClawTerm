/** Foreground process names that are safe to paste multi-line text into
 *  without the confirm dialog — they're interactive AI agent prompts,
 *  not shells about to execute each line as a command (see #508). */
export const TRUSTED_AGENT_PROCESSES: ReadonlySet<string> = new Set(["claude"]);

/** Pure trust-decision used by the paste gate.
 *
 *  Returns true iff `name` is a trusted agent, or any name in `ancestors`
 *  is a trusted agent. The ancestor check exists for cases where the
 *  agent (e.g. `claude`) spawned a subshell or helper that briefly
 *  became the pane's foreground — we still want to recognize that a
 *  trusted agent is the session driver. (#519) */
export function isTrustedAgentForeground(
  name: string,
  ancestors: ReadonlyArray<{ name: string }>,
): boolean {
  if (TRUSTED_AGENT_PROCESSES.has(name)) return true;
  return ancestors.some((node) => TRUSTED_AGENT_PROCESSES.has(node.name));
}
