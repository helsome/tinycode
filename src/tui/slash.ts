import { CombinedAutocompleteProvider, type AutocompleteProvider } from "@earendil-works/pi-tui";
import type { ModelRegistry } from "../model/registry.js";
import type { McpManager } from "../mcp/manager.js";
import type { PermissionManager } from "../permissions/manager.js";
import type { SessionManager } from "../session/manager.js";
import type { SkillRegistry } from "../skills/registry.js";
import type { SubAgentManager } from "../agents/manager.js";
import type { TinyCodeRuntime } from "../agent/runtime.js";

/**
 * Everything a slash command may touch. Implemented by the TUI app so the
 * command layer stays pure logic (easy to test headlessly).
 */
export interface SlashContext {
  runtime: TinyCodeRuntime;
  models: ModelRegistry;
  permissions: PermissionManager;
  session: SessionManager | undefined;
  skills: SkillRegistry;
  mcp: McpManager | undefined;
  subAgents: SubAgentManager | undefined;
  projectRoot: string;
  /** Replace the live conversation with another session's history. */
  loadSession(id: string): Promise<string[]>;
  startNewSession(): string;
  requestExit(): void;
}

const HELP_LINES = [
  "/help            show this help",
  "/new             start a fresh session",
  "/clear           clear the current conversation context",
  "/resume [id]     resume a previous session (lists when no id given)",
  "/sessions        list saved sessions",
  "/model [ref]     switch model (provider/model); lists configured options",
  "/skills          list discovered skills",
  "/mcp             show MCP server status",
  "/agents          show sub-agent status",
  "/compact         summarize older turns to free context",
  "/status          show harness status",
  "/exit            quit TinyCode",
];

/** Execute one `/command`; returns transcript lines to display. */
export async function executeSlashCommand(rawInput: string, ctx: SlashContext): Promise<string[]> {
  const trimmed = rawInput.trim();
  const [command, ...rest] = trimmed.split(/\s+/);
  const argument = rest.join(" ");

  switch ((command ?? "").toLowerCase()) {
    case "/help":
      return HELP_LINES;
    case "/exit":
      ctx.requestExit();
      return ["Bye."];
    case "/new": {
      const id = ctx.startNewSession();
      ctx.runtime.agent.reset();
      return [`Started new session ${id.slice(0, 8)}.`];
    }
    case "/clear": {
      ctx.runtime.agent.reset();
      return ["Conversation cleared."];
    }
    case "/sessions": {
      const list = ctx.session?.list() ?? [];
      if (list.length === 0) return ["No saved sessions yet."];
      return list
        .slice(0, 20)
        .map(
          (session) =>
            `${session.id}  ${session.modifiedAt.slice(0, 16).replace("T", " ")}  ${session.title ?? "(no title)"} (${session.messageCount} msgs)`,
        );
    }
    case "/resume": {
      if (!argument) {
        const list = ctx.session?.list().slice(0, 10) ?? [];
        if (list.length === 0) return ["No saved sessions yet."];
        return ["Usage: /resume <session-id>", ...list.map((s) => `${s.id}  ${s.title ?? ""}`)];
      }
      try {
        return await ctx.loadSession(argument);
      } catch (error) {
        return [(error as Error).message];
      }
    }
    case "/model": {
      if (!argument) {
        const available = await ctx.models.availableWithAuth();
        const current = ctx.runtime.agent.state.model;
        const lines = [
          `current: ${current.provider}/${current.id}`,
          ...(available.length > 0
            ? ["available (auth configured):", ...available.slice(0, 15).map((m) => `  ${m.provider}/${m.id}`)]
            : ["no providers have API keys configured"]),
        ];
        return lines;
      }
      const [providerId, ...modelParts] = argument.split("/");
      try {
        const model =
          providerId && modelParts.length > 0
            ? await ctx.models.resolve({ provider: providerId, model: modelParts.join("/") })
            : await ctx.models.resolve({ model: argument });
        ctx.runtime.setModel(model);
        return [`Model switched to ${model.provider}/${model.id}`];
      } catch (error) {
        return [(error as Error).message];
      }
    }
    case "/skills": {
      const skills = ctx.skills.list();
      if (skills.length === 0) return ["No skills found (.tinycode/skills/<name>/SKILL.md)."];
      return [
        `${skills.length} skill(s):`,
        ...skills.map((skill) => `- ${skill.name}: ${skill.description || "(no description)"}`),
      ];
    }
    case "/mcp": {
      if (!ctx.mcp || ctx.mcp.size === 0) return ["MCP is not configured (.tinycode/config.json → mcpServers)."];
      return ctx.mcp.statuses().map((server) => {
        const statusIcon =
          server.status === "connected" ? "✓" : server.status === "error" ? "✗" : "…";
        const errorSuffix = server.error ? ` — ${server.error}` : "";
        return `${statusIcon} ${server.name}: ${server.status}, ${server.toolCount} tool(s)${errorSuffix}`;
      });
    }
    case "/agents": {
      if (!ctx.subAgents) return ["Sub-agents are not enabled in this session."];
      const reports = ctx.subAgents.reports();
      if (reports.length === 0) return [`${ctx.subAgents.statusLine()} (none spawned)`];
      return [
        ctx.subAgents.statusLine(),
        ...reports.map((r) => `${r.name} [${r.id}] ${r.status} — ${r.task}`),
      ];
    }
    case "/compact":
      return [await ctx.runtime.compactNow()];
    case "/status": {
      const agentState = ctx.runtime.agent.state;
      const estimated = ctx.runtime.options.contextManager.estimate(agentState.messages);
      const model = agentState.model;
      return [
        `project root : ${ctx.projectRoot}`,
        `model        : ${model.provider}/${model.id}`,
        `context      : ~${estimated} tokens (est.)`,
        `messages     : ${agentState.messages.length}`,
        `permissions  : mode=${ctx.permissions.mode}, remembered patterns=${ctx.permissions.listPatterns().length}`,
        `tools        : ${ctx.runtime.options.tools.names().join(", ")}`,
        `session      : ${ctx.session?.id ?? "(not persisted)"}`,
        `skills       : ${ctx.skills.size}`,
        `mcp servers  : ${ctx.mcp?.size ?? 0}`,
      ];
    }
    default:
      return [`Unknown command "${command}". Type /help for available commands.`];
  }
}

export const SLASH_COMMAND_NAMES = HELP_LINES.map((line) => line.split(/\s+/)[0]!);

/**
 * Build the editor's slash-command autocomplete provider.
 *
 * pi-tui applies completions by prepending "/" itself, so the value inserted
 * into the editor must NOT carry the leading slash — a slashed value would
 * rewrite "/he" as "//help". The label shown in the picker keeps the "/" so
 * the menu reads like real commands (/help, /new, …).
 */
export function createSlashAutocompleteProvider(projectRoot: string): AutocompleteProvider {
  const inner = new CombinedAutocompleteProvider(
    SLASH_COMMAND_NAMES.map((name) => ({ name: name.replace(/^\//, ""), description: "" })),
    projectRoot,
    null,
  );
  return {
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      const suggestions = await inner.getSuggestions(lines, cursorLine, cursorCol, options);
      if (!suggestions) return null;
      const textBeforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
      const isCommandNameContext =
        !options.force &&
        textBeforeCursor.startsWith("/") &&
        !textBeforeCursor.includes(" ");
      if (!isCommandNameContext) return suggestions;
      // Display "/help" while inserting "help" (pi-tui adds the slash back).
      return {
        items: suggestions.items.map((item) => ({ ...item, label: `/${item.value}` })),
        prefix: suggestions.prefix,
      };
    },
    applyCompletion: (lines, cursorLine, cursorCol, item, prefix) =>
      inner.applyCompletion(lines, cursorLine, cursorCol, item, prefix),
  };
}
