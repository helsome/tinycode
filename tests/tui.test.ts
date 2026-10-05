import { describe, expect, it } from "vitest";
import { SelectList } from "@earendil-works/pi-tui";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { TranscriptView } from "../src/tui/transcript.js";
import { StatusBar } from "../src/tui/status-bar.js";
import { formatToolStart, formatToolResultLines } from "../src/tui/tool-view.js";
import { createSlashAutocompleteProvider } from "../src/tui/slash.js";

function plain(lines: string[]): string {
  return lines.map((line) => stripTerminalSequences(line)).join("\n");
}

describe("TranscriptView", () => {
  it("renders user messages", () => {
    const view = new TranscriptView();
    view.addUser("fix the login bug");
    const rendered = plain(view.container.render(80));
    expect(rendered).toContain("you");
    expect(rendered).toContain("fix the login bug");
  });

  it("streams assistant output into an updatable entry and finalizes", () => {
    const view = new TranscriptView();
    const handle = view.startAssistant();
    handle.update("partial ans");
    let rendered = plain(view.container.render(80));
    expect(rendered).toContain("partial ans");

    handle.update("partial answer with more text");
    rendered = plain(view.container.render(80));
    expect(rendered).toContain("more text");

    handle.finalize("**Done** with `code`");
    rendered = plain(view.container.render(80));
    expect(rendered).toContain("Done");
  });

  it("renders tool entries with result summaries", () => {
    const view = new TranscriptView();
    const entry = view.addToolEntry("bash", { command: "npm test" });
    let rendered = plain(view.container.render(80));
    expect(rendered).toContain("● bash npm test");

    entry.complete({ command: "npm test", exitCode: 0, durationMs: 2400 }, false);
    rendered = plain(view.container.render(80));
    expect(rendered).toContain("✓ exit 0 · 2.4s");
  });

  it("renders failed tool results distinctly", () => {
    const lines = plain(formatToolResultLines("bash", { exitCode: 1, durationMs: 3100 }, true));
    expect(lines).toContain("✗ exit 1 · 3.1s");
  });

  it("shows edit diffs with add/remove markers", () => {
    const rendered = plain(
      formatToolResultLines(
        "edit",
        { path: "a.ts", additions: 12, deletions: 3, replacements: 1, diff: "+ new line\n- old line" },
        false,
      ),
    );
    expect(rendered).toContain("+12 -3");
    expect(rendered).toContain("+ new line");
  });

  it("reports errors and info lines", () => {
    const view = new TranscriptView();
    view.addError("model unavailable");
    view.addInfo("hint text");
    const rendered = plain(view.container.render(80));
    expect(rendered).toContain("error model unavailable");
    expect(rendered).toContain("hint text");
  });
});

describe("StatusBar", () => {
  it("renders model, tokens, agents and session segments", () => {
    const bar = new StatusBar();
    bar.update({
      model: "anthropic/claude-sonnet-4",
      tokens: 12300,
      agentsRunning: 2,
      agentsMax: 3,
      sessionId: "abcdef1234567890",
      busy: true,
      cwd: "/work/tinycode",
    });
    const rendered = plain(bar.component.render(240));
    expect(rendered).toContain("anthropic/claude-sonnet-4");
    expect(rendered).toContain("ctx ~12.3k");
    expect(rendered).toContain("SUB-AGENTS 2/3 RUNNING");
    expect(rendered).toContain("session abcdef12");
  });

  it("hides agent segment when none are running", () => {
    const bar = new StatusBar();
    bar.update({ model: "mock/m", tokens: 5, agentsRunning: 0, agentsMax: 3, busy: false, cwd: "/" });
    const rendered = plain(bar.component.render(80));
    expect(rendered).not.toContain("SUB-AGENTS");
  });
});

describe("tool start formatting", () => {
  it("summarizes tool arguments compactly", () => {
    expect(plain([formatToolStart("read", { path: "src/index.ts" })])).toBe("● read src/index.ts");
    expect(plain([formatToolStart("grep", { pattern: "needle", include: "*.ts" })])).toContain("needle");
  });
});

describe("SelectList (permission dialog mechanics)", () => {
  function makeList(): { list: SelectList; picked: string[] } {
    const picked: string[] = [];
    const list = new SelectList(
      [
        { value: "once", label: "Allow once" },
        { value: "always", label: "Always allow this pattern" },
        { value: "deny", label: "Deny" },
      ],
      5,
      {
        selectedPrefix: (t) => t,
        selectedText: (t) => t,
        description: (t) => t,
        scrollInfo: (t) => t,
        noMatch: (t) => t,
      },
    );
    list.onSelect = (item) => picked.push(item.value);
    return { list, picked };
  }

  it("defaults to the first option and confirms with Enter", () => {
    const { list, picked } = makeList();
    list.handleInput("\r");
    expect(picked).toEqual(["once"]);
  });

  it("moves down with arrow keys before confirming", () => {
    const { list, picked } = makeList();
    list.handleInput("\x1b[B"); // down
    list.handleInput("\r");
    expect(picked).toEqual(["always"]);
  });

  it("supports two downs then enter for deny", () => {
    const { list, picked } = makeList();
    list.handleInput("\x1b[B");
    list.handleInput("\x1b[B");
    list.handleInput("\r");
    expect(picked).toEqual(["deny"]);
  });

  it("renders all three options", () => {
    const { list } = makeList();
    const rendered = plain(list.render(60));
    expect(rendered).toContain("Allow once");
    expect(rendered).toContain("Always allow this pattern");
    expect(rendered).toContain("Deny");
  });
});

describe("slash-command autocomplete", () => {
  it("completes a command without doubling the leading slash", async () => {
    const provider = createSlashAutocompleteProvider(process.cwd());
    const signal = new AbortController().signal;

    // Typing "/he" suggests help.
    const suggestions = await provider.getSuggestions(["/he"], 0, 3, { signal });
    expect(suggestions).not.toBeNull();
    const help = suggestions!.items.find((item) => item.value === "help");
    expect(help).toBeDefined();

    // The picker shows "/help"; the inserted value stays un-slashed because
    // pi-tui's applyCompletion prepends "/" itself.
    expect(help!.label).toBe("/help");

    // Regression: completing used to rewrite the line as "//help".
    const applied = provider.applyCompletion(["/he"], 0, 3, help!, suggestions!.prefix);
    expect(applied.lines[0]).toBe("/help ");
    expect(applied.lines[0]!.startsWith("//")).toBe(false);
  });

  it("lists every command with a slashed label but a plain value", async () => {
    const provider = createSlashAutocompleteProvider(process.cwd());
    const signal = new AbortController().signal;

    const all = await provider.getSuggestions(["/"], 0, 1, { signal });
    expect(all).not.toBeNull();
    expect(all!.items.map((item) => item.value)).toEqual(
      expect.arrayContaining(["help", "new", "exit", "model", "status"]),
    );
    expect(all!.items.map((item) => item.label)).toEqual(
      expect.arrayContaining(["/help", "/new", "/exit", "/model", "/status"]),
    );
  });
});
