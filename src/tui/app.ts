import {
  Editor,
  ProcessTerminal,
  ScrollView,
  TuiAltScreen,
  Text,
  VStack,
  matchesKey,
  type TUI,
} from "@earendil-works/pi-tui";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { TinyCodeRuntime } from "../agent/runtime.js";
import type { SubAgentManager } from "../agents/manager.js";
import type { ModelRegistry } from "../model/registry.js";
import type { McpManager } from "../mcp/manager.js";
import type { PermissionManager } from "../permissions/manager.js";
import type { SessionManager } from "../session/manager.js";
import type { SkillRegistry } from "../skills/registry.js";
import { fg, dim, bold } from "./theme.js";
import {
  TranscriptView,
  textOfMessage,
  type AssistantStreamHandle,
  type ToolEntryHandle,
} from "./transcript.js";
import { StatusBar } from "./status-bar.js";
import { showPermissionDialog } from "./permission-dialog.js";
import {
  executeSlashCommand,
  createSlashAutocompleteProvider,
  type SlashContext,
} from "./slash.js";

export interface TuiAppDeps {
  models: ModelRegistry;
  permissions: PermissionManager;
  session?: SessionManager;
  skills: SkillRegistry;
  mcp?: McpManager;
  subAgents?: SubAgentManager;
  projectRoot: string;
  /** Shown when launch fell back to mock mode because no provider key exists. */
  onboarding?: string;
}

const BANNER = [
  "TinyCode v1.0 — a minimal Coding Agent built on Pi",
  `${fg.gray("Type a task, or /help for commands. Ctrl+C aborts/exits.")}`,
];

/**
 * TuiApp assembles the full-screen experience:
 *
 * ┌──────────────────────────────┐
 * │ transcript (scroll view)     │
 * ├──────────────────────────────┤
 * │ > input (Editor)             │
 * │ status bar                   │
 * └──────────────────────────────┘
 */
export class TuiApp implements SlashContext {
  readonly tui: TUI;
  readonly transcript = new TranscriptView();
  readonly editor: Editor;
  readonly statusBar = new StatusBar();

  private streamHandle?: AssistantStreamHandle;
  private toolEntries = new Map<string, ToolEntryHandle>();
  private exitRequested = false;
  private lastCtrlCAt = 0;
  private resolveRun?: () => void;

  constructor(
    readonly runtimeImport: TinyCodeRuntime,
    readonly deps: TuiAppDeps,
  ) {
    this.tui = new TuiAltScreen(new ProcessTerminal());
    this.editor = new Editor(this.tui, {
      borderColor: (text) => (this.editor.focused ? fg.brightBlue(text) : fg.gray(text)),
      selectList: {
        selectedPrefix: (text) => text,
        selectedText: fg.brightGreen,
        description: fg.gray,
        scrollInfo: fg.gray,
        noMatch: fg.gray,
      },
    });

    const transcriptScroll = new ScrollView(this.transcript.container, {
      follow: "end",
      primary: true,
      overscroll: "chain",
    });
    const bottomStack = new VStack([], {});
    bottomStack.addChild(new LoaderHost(this));
    bottomStack.addChild(this.editor);
    bottomStack.addChild(this.statusBar.component);

    if (this.tui.mode === "fullscreen") {
      (this.tui as TuiAltScreen).setLayoutRoot(
        new VStack(
          [
            { component: transcriptScroll, basis: 0, grow: 1, minSize: 1 },
            { component: bottomStack, basis: "auto", shrink: 1, minSize: 3 },
          ],
          {},
        ),
      );
    }

    // Slash-command autocomplete.
    this.editor.setAutocompleteProvider(createSlashAutocompleteProvider(this.deps.projectRoot));

    this.deps.permissions.setPrompt((request) => showPermissionDialog(this.tui, request));
    this.runtimeImport.agent.subscribe(async (event: AgentEvent) => this.handleAgentEvent(event));

    this.tui.addInputListener((data) => this.handleGlobalKeys(data));
    this.editor.onSubmit = (text) => {
      void this.submit(text);
    };
  }

  get projectRoot(): string {
    return this.deps.projectRoot;
  }
  get models() {
    return this.deps.models;
  }
  get permissions() {
    return this.deps.permissions;
  }
  get session() {
    return this.deps.session;
  }
  get skills() {
    return this.deps.skills;
  }
  get mcp() {
    return this.deps.mcp;
  }
  get subAgents() {
    return this.deps.subAgents;
  }
  get runtime() {
    return this.runtimeImport;
  }

  requestExit(): void {
    this.exitRequested = true;
  }

  async loadSession(id: string): Promise<string[]> {
    const session = this.deps.session;
    if (!session) throw new Error("Sessions are not enabled.");
    const model = this.runtimeImport.agent.state.model;
    const loaded = session.attach(id, this.deps.projectRoot, `${model.provider}/${model.id}`);
    const current = [...this.runtimeImport.agent.state.messages];
    current.splice(0, current.length, ...loaded.messages);
    this.runtimeImport.agent.state.messages = current;
    return [`Resumed session ${id.slice(0, 8)} (${loaded.messages.length} messages).`];
  }

  startNewSession(): string {
    const model = this.runtimeImport.agent.state.model;
    if (!this.deps.session) throw new Error("Sessions are not enabled.");
    return this.deps.session.start(this.deps.projectRoot, `${model.provider}/${model.id}`);
  }

  start(): void {
    this.transcript.addInfo(BANNER.join("\n"));
    if (this.deps.onboarding) this.showOnboarding(this.deps.onboarding);
    this.refreshStatusBar();
    this.tui.start();
    this.tui.setFocus(this.editor);
  }

  /**
   * First-run guidance when no provider key is configured: explain that the
   * scripted mock model answers until a key exists, and give exact steps.
   */
  private showOnboarding(detail: string): void {
    const lines = [
      fg.brightYellow(bold("⚙  Setup required — currently in MOCK mode")),
      dim("    Replies come from a scripted offline model, not a real LLM."),
      "",
      "To enable real models:",
      "  1. Get an API key (openrouter.ai, anthropic.com, platform.openai.com, …)",
      "  2. Add it to your shell profile, e.g.:",
      '       export OPENROUTER_API_KEY="sk-or-v1-…"',
      "     Other accepted names: ANTHROPIC_API_KEY, OPENAI_API_KEY, GROQ_API_KEY, …",
      "  3. Restart tinycode — or run `tinycode --list-models` to verify.",
      "",
      dim("Startup detail:"),
      ...detail.split("\n").map((line) => dim(`  ${line}`)),
    ];
    this.transcript.addInfo(lines.join("\n"));
  }

  /** Run until the user exits; resolves after the TUI is torn down. */
  run(): Promise<void> {
    this.start();
    return new Promise<void>((resolve) => {
      this.resolveRun = () => resolve();
      const poll = setInterval(() => {
        if (this.exitRequested && !this.runtimeImport.busy) {
          clearInterval(poll);
          this.teardown();
        }
      }, 100);
    });
  }

  async teardown(): Promise<void> {
    try {
      await this.deps.mcp?.shutdown();
      await this.deps.subAgents?.shutdown();
    } finally {
      this.tui.stop();
      this.resolveRun?.();
    }
  }

  private refreshStatusBar(): void {
    const state = this.runtimeImport.agent.state;
    this.statusBar.update({
      model: `${state.model.provider}/${state.model.id}`,
      tokens: this.runtimeImport.options.contextManager.estimate(state.messages),
      agentsRunning: this.deps.subAgents?.runningCount ?? 0,
      agentsMax: 3,
      sessionId: this.deps.session?.id,
      busy: state.isStreaming,
      cwd: this.deps.projectRoot,
    });
    this.tui.requestRender();
  }

  private async submit(text: string): Promise<void> {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    this.editor.addToHistory(trimmed);
    this.editor.setText("");

    if (trimmed.startsWith("/")) {
      let lines: string[];
      try {
        lines = await executeSlashCommand(trimmed, this);
      } catch (error) {
        lines = [(error as Error).message];
      }
      this.transcript.addInfo(lines.join("\n"));
      this.tui.requestRender();
      if (this.exitRequested) await this.teardown();
      return;
    }

    if (this.runtimeImport.busy) {
      this.transcript.addInfo("Still working — wait for the current task to finish.");
      this.tui.requestRender();
      return;
    }
    await this.runPrompt(() => this.runtimeImport.prompt(trimmed));
  }

  private async runPrompt(run: () => Promise<void>): Promise<void> {
    this.refreshStatusBar();
    try {
      await run();
    } catch (error) {
      this.transcript.addError((error as Error).message);
    }
    this.streamHandle = undefined;
    this.toolEntries.clear();
    const errorMessage = this.runtimeImport.agent.state.errorMessage;
    if (errorMessage) this.transcript.addError(errorMessage);
    this.refreshStatusBar();
    this.tui.setFocus(this.editor);
  }

  private handleAgentEvent(event: AgentEvent): void {
    switch (event.type) {
      case "message_start": {
        const role = (event.message as { role?: string }).role;
        if (role === "user") {
          const text = textOfMessage(event.message);
          if (text.length > 0 && !text.startsWith("<conversation-summary>")) {
            this.transcript.addUser(text);
          }
        } else if (role === "assistant") {
          this.streamHandle = this.transcript.startAssistant();
        }
        break;
      }
      case "message_update": {
        if (this.streamHandle) this.streamHandle.update(textOfMessage(event.message));
        break;
      }
      case "message_end": {
        const role = (event.message as { role?: string }).role;
        if (role === "assistant" && this.streamHandle) {
          const text = textOfMessage(event.message);
          if (text.length > 0) this.streamHandle.finalize(text);
          else this.streamHandle.update("");
          this.streamHandle = undefined;
        }
        break;
      }
      case "tool_execution_start": {
        const entry = this.transcript.addToolEntry(event.toolName, event.args);
        this.toolEntries.set(event.toolCallId, entry);
        break;
      }
      case "tool_execution_end": {
        const entry = this.toolEntries.get(event.toolCallId);
        const preview =
          event.result && typeof event.result === "object" && "content" in event.result
            ? ((event.result as { content?: { text?: string }[] }).content ?? [])
                .map((part) => part.text ?? "")
                .filter(Boolean)
            : undefined;
        entry?.complete(
          event.result && typeof event.result === "object" ? (event.result as { details?: unknown }).details : undefined,
          event.isError,
          preview,
        );
        this.toolEntries.delete(event.toolCallId);
        break;
      }
      case "turn_end":
      case "turn_start":
      case "agent_start":
      case "agent_end":
        this.refreshStatusBar();
        break;
    }
    this.refreshStatusBar();
  }

  private handleGlobalKeys(data: string): { consume?: boolean } | undefined {
    if (matchesKey(data, "ctrl+c")) {
      this.handleInterrupt();
      return { consume: true };
    }
    if (matchesKey(data, "ctrl+d")) {
      this.requestExit();
      void this.teardown();
      return { consume: true };
    }
    if (matchesKey(data, "escape") && this.runtimeImport.busy) {
      this.runtimeImport.abort();
      this.transcript.addInfo("Interrupted.");
      return { consume: true };
    }
    return undefined;
  }

  /**
   * Shared Ctrl+C / SIGINT behavior: abort a busy run, otherwise require a
   * second press within two seconds to quit. Terminals with ISIG deliver
   * Ctrl+C as SIGINT rather than a byte, so both paths must agree.
   */
  handleInterrupt(): void {
    if (this.runtimeImport.busy) {
      this.runtimeImport.abort();
      this.transcript.addInfo("Interrupted.");
    } else if (Date.now() - this.lastCtrlCAt < 2000) {
      this.requestExit();
      void this.teardown();
    } else {
      this.lastCtrlCAt = Date.now();
      this.transcript.addInfo(dim("(press Ctrl+C again to exit)"));
    }
    this.tui.requestRender();
  }
}


/** Renders a loader row only while the agent is streaming. */
class LoaderHost extends Text {
  constructor(private app: TuiApp) {
    super("");
  }
  invalidate(): void {
    super.invalidate();
  }
  render(width: number): string[] {
    const busy = this.app.runtimeImport.busy;
    const pending = this.app.runtimeImport.agent.state.pendingToolCalls.size;
    const label =
      pending > 0 ? `running ${pending} tool call(s)…` : busy ? "thinking…" : "";
    this.setText(label ? `${fg.brightYellow("◐")} ${label}` : "");
    return super.render(width);
  }
}
