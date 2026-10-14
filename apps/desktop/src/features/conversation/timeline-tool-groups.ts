import type {
  DisplayTimelineItem,
  TimelineToolCall,
  TimelineToolStatus,
} from "../../../contracts/timeline-types";
import type { ExtensionToolLabels } from "../../../contracts/tool-labels";

/** A lone tool call keeps its own row; a run of this many or more folds into one group. */
const MIN_GROUP_SIZE = 2;

export function toolGroupId(firstTool: TimelineToolCall): string {
  return `tool-group:${firstTool.callId}`;
}

/**
 * Fold each run of consecutive tool calls into one collapsible `tool-group` row (Codex-style).
 * Any other row ends a run. A group is keyed by its first call, so while a run streams in the
 * group stays the same row and only its summary changes.
 */
export function groupToolRuns(
  items: readonly DisplayTimelineItem[],
): readonly DisplayTimelineItem[] {
  const result: DisplayTimelineItem[] = [];
  let run: TimelineToolCall[] = [];
  const flush = () => {
    const first = run[0];
    if (first && run.length >= MIN_GROUP_SIZE) {
      result.push({ kind: "tool-group", id: toolGroupId(first), tools: run });
    } else {
      result.push(...run);
    }
    run = [];
  };
  for (const item of items) {
    if (item.kind === "tool") {
      run.push(item);
      continue;
    }
    flush();
    result.push(item);
  }
  flush();
  return result;
}

export interface ToolGroupCounts {
  readonly commands: number;
  readonly edits: number;
  readonly reads: number;
  readonly searches: number;
  readonly lists: number;
  readonly other: number;
}

export interface ToolGroupSummary {
  readonly label: string;
  readonly counts: ToolGroupCounts;
  /** Running wins over failed, so a group that is still working never looks finished. */
  readonly status: TimelineToolStatus;
  readonly failed: number;
  /** The latest call still running, named in the collapsed header. */
  readonly running?: TimelineToolCall;
}

/**
 * Summarize a group as "Explored 9 files, 6 searches" or "Ran 7 commands, read 9 files".
 * Reads and edits count distinct files when the input names one. An extension's tool counts as a
 * tool: its name says nothing about files or searches.
 */
export function summarizeToolGroup(
  tools: readonly TimelineToolCall[],
  extensionLabels: ExtensionToolLabels = new Map(),
): ToolGroupSummary {
  const readPaths = new Set<string>();
  const editPaths = new Set<string>();
  let commands = 0;
  let searches = 0;
  let lists = 0;
  let other = 0;
  let failed = 0;
  let running: TimelineToolCall | undefined;
  tools.forEach((tool, index) => {
    if (tool.status === "error") failed += 1;
    if (tool.status === "running") running = tool;
    const name = tool.toolName.toLowerCase();
    // Calls without a path still count once each.
    const path = toolInputPath(tool.input) || `#${index}`;
    if (extensionLabels.has(tool.toolName)) other += 1;
    else if (name === "bash") commands += 1;
    else if (name === "read") readPaths.add(path);
    else if (isWriteTool(name)) editPaths.add(path);
    else if (name === "grep" || name === "find" || name.includes("search")) searches += 1;
    else if (name === "ls") lists += 1;
    else other += 1;
  });
  const counts = {
    commands,
    edits: editPaths.size,
    reads: readPaths.size,
    searches,
    lists,
    other,
  };
  return {
    label: summaryLabel(counts),
    counts,
    status: running ? "running" : failed > 0 ? "error" : "success",
    failed,
    running,
  };
}

function summaryLabel(counts: ToolGroupCounts): string {
  const files = plural(counts.reads, "file");
  const searches = plural(counts.searches, "search", "searches");
  const lists = plural(counts.lists, "list");
  if (counts.commands + counts.edits + counts.other === 0) {
    return `Explored ${[files, searches, lists].filter(Boolean).join(", ")}`;
  }
  const parts = [
    counts.commands ? `ran ${plural(counts.commands, "command")}` : "",
    counts.edits ? `edited ${plural(counts.edits, "file")}` : "",
    counts.reads ? `read ${files}` : "",
    searches,
    lists,
    counts.other ? `used ${plural(counts.other, "tool")}` : "",
  ].filter(Boolean);
  const label = parts.join(", ");
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function plural(count: number, one: string, many = `${one}s`): string {
  return count === 0 ? "" : `${count} ${count === 1 ? one : many}`;
}

export function isWriteTool(toolName: string): boolean {
  return /write|edit|patch|apply/i.test(toolName);
}

/** The file a tool's input names, or "" when it names none. */
export function toolInputPath(input: unknown): string {
  if (typeof input === "object" && input !== null) {
    const record = input as Record<string, unknown>;
    const path = record.file_path ?? record.filePath ?? record.path ?? record.filename;
    if (typeof path === "string") {
      return path;
    }
  }
  return "";
}
