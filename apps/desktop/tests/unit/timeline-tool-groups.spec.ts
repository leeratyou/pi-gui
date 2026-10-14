import { expect, test } from "@playwright/test";
import type {
  DisplayTimelineItem,
  TimelineToolCall,
  TimelineToolStatus,
  TranscriptMessage,
} from "../../contracts/timeline-types";
import {
  groupToolRuns,
  summarizeToolGroup,
} from "../../src/features/conversation/timeline-tool-groups";

const createdAt = "2026-10-14T12:00:00.000Z";

function message(id: string, role: "user" | "assistant"): TranscriptMessage {
  return { kind: "message", id, role, text: id, createdAt };
}

function tool(
  callId: string,
  toolName = "bash",
  input: unknown = undefined,
  status: TimelineToolStatus = "success",
): TimelineToolCall {
  return {
    kind: "tool",
    id: `row:${callId}`,
    callId,
    toolName,
    status,
    label: callId,
    createdAt,
    input,
  };
}

const read = (callId: string, path: string) => tool(callId, "read", { path });

function shape(items: readonly DisplayTimelineItem[]): string[] {
  return items.map((item) =>
    item.kind === "tool-group"
      ? `${item.id}[${item.tools.map((member) => member.callId).join(",")}]`
      : item.id,
  );
}

test("a run of consecutive tool calls folds into one group; a lone call keeps its row", () => {
  const rows = groupToolRuns([
    message("u1", "user"),
    tool("t1"),
    message("a1", "assistant"),
    tool("t2"),
    tool("t3"),
    tool("t4"),
    { kind: "turn-marker", id: "turn-marker:u1", durationMs: 4_000 },
    message("a2", "assistant"),
    tool("t5"),
    tool("t6"),
  ]);
  expect(shape(rows)).toEqual([
    "u1",
    "row:t1",
    "a1",
    "tool-group:t2[t2,t3,t4]",
    "turn-marker:u1",
    "a2",
    "tool-group:t5[t5,t6]",
  ]);
});

test("a streaming run stays the same group row while calls append to it", () => {
  const head = [message("u1", "user"), tool("t1"), tool("t2")];
  const before = groupToolRuns(head);
  const after = groupToolRuns([...head, tool("t3", "read", { path: "a.ts" }, "running")]);
  expect(shape(before)).toEqual(["u1", "tool-group:t1[t1,t2]"]);
  expect(shape(after)).toEqual(["u1", "tool-group:t1[t1,t2,t3]"]);
});

test("reads and searches summarize as exploration, counting distinct files", () => {
  const tools = [
    read("r1", "src/a.ts"),
    read("r2", "src/b.ts"),
    // The same file read again in another chunk is still one file.
    tool("r3", "read", { path: "src/a.ts", offset: 200 }),
    tool("g1", "grep", { pattern: "foo" }),
    tool("f1", "find", { pattern: "*.ts" }),
    tool("l1", "ls", { path: "src" }),
  ];
  expect(summarizeToolGroup(tools).label).toBe("Explored 2 files, 2 searches, 1 list");
  expect(summarizeToolGroup([read("r1", "a.ts"), read("r2", "b.ts")]).label).toBe(
    "Explored 2 files",
  );
  expect(summarizeToolGroup([tool("g1", "grep"), tool("g2", "grep")]).label).toBe(
    "Explored 2 searches",
  );
});

test("a mixed run names commands, edits, reads, searches and other tools in that order", () => {
  const tools = [
    tool("b1"),
    read("r1", "a.ts"),
    tool("b2"),
    tool("e1", "edit", { path: "a.ts" }),
    tool("w1", "write", { path: "b.ts" }),
    tool("e2", "edit", { path: "a.ts" }),
    tool("g1", "grep"),
    tool("m1", "mcp"),
  ];
  expect(summarizeToolGroup(tools).label).toBe(
    "Ran 2 commands, edited 2 files, read 1 file, 1 search, used 1 tool",
  );
  expect(summarizeToolGroup([tool("b1"), read("r1", "a.ts"), read("r2", "b.ts")]).label).toBe(
    "Ran 1 command, read 2 files",
  );
  expect(summarizeToolGroup([tool("m1", "mcp"), tool("m2", "subagent")]).label).toBe(
    "Used 2 tools",
  );
});

test("an extension's tool counts as a tool whatever its name says", () => {
  const labels = new Map([["read_ticket", "Look up ticket"]]);
  const tools = [tool("x1", "read_ticket"), read("r1", "a.ts")];
  expect(summarizeToolGroup(tools, labels).label).toBe("Read 1 file, used 1 tool");
});

test("a running call keeps the group running, failures are counted, and the latest running call is named", () => {
  const done = summarizeToolGroup([tool("b1"), tool("b2")]);
  expect(done).toMatchObject({ status: "success", failed: 0 });
  expect(done.running).toBeUndefined();

  const failed = summarizeToolGroup([tool("b1", "bash", undefined, "error"), tool("b2")]);
  expect(failed).toMatchObject({ status: "error", failed: 1 });

  const running = summarizeToolGroup([
    tool("b1", "bash", undefined, "error"),
    tool("b2", "bash", undefined, "running"),
    tool("b3", "bash", undefined, "running"),
  ]);
  expect(running).toMatchObject({ status: "running", failed: 1 });
  expect(running.running?.callId).toBe("b3");
});
