import { expect, test, type Page } from "@playwright/test";
import type { SessionDriverEvent, SessionRef } from "@pi-gui/session-driver";
import {
  createNamedThread,
  emitTestSessionEvents,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  waitForTimelineLayout,
  waitForWorkspaceByPath,
} from "../helpers/electron-app";

async function selectedSessionRef(window: Page): Promise<SessionRef> {
  const state = await getDesktopState(window);
  if (!state.selectedWorkspaceId || !state.selectedSessionId) {
    throw new Error("Expected a selected session");
  }
  return { workspaceId: state.selectedWorkspaceId, sessionId: state.selectedSessionId };
}

test("consecutive tool calls fold into one row that expands to the ordinary tool rows", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("tool-groups-workspace");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    await createNamedThread(window, "Tool groups");
    const sessionRef = await selectedSessionRef(window);
    const timestamp = new Date().toISOString();
    const started = (callId: string, toolName: string, input: unknown): SessionDriverEvent => ({
      type: "toolStarted",
      sessionRef,
      timestamp,
      toolName,
      callId,
      input,
    });
    const finished = (callId: string, success: boolean, output: string): SessionDriverEvent => ({
      type: "toolFinished",
      sessionRef,
      timestamp,
      callId,
      success,
      output,
    });
    const transcript = window.getByTestId("transcript");
    const toolRows = transcript.locator(".timeline-tool");
    const group = transcript.getByTestId("timeline-tool-group");
    const groupHeader = group.locator(".timeline-tool-group__header");
    const toolRow = (label: string) => toolRows.filter({ hasText: label });

    // A lone call keeps its own row; open its output to read it.
    await emitTestSessionEvents(harness, [
      started("call-b1", "bash", { command: "npm test" }),
      finished("call-b1", true, "B1_OUTPUT"),
    ]);
    await expect(toolRows).toHaveCount(1);
    await expect(group).toHaveCount(0);
    await waitForTimelineLayout(window);
    await toolRow("npm test").locator(".timeline-tool__header").click();
    await expect(toolRow("npm test").locator(".timeline-tool__body")).toContainText("B1_OUTPUT");

    // The next call turns the run into a group, which stays open around the output being read.
    await emitTestSessionEvents(harness, [started("call-r1", "read", { path: "src/a.ts" })]);
    await expect(group).toHaveCount(1);
    await expect(groupHeader).toHaveAttribute("aria-expanded", "true");
    await expect(toolRow("npm test").locator(".timeline-tool__body")).toContainText("B1_OUTPUT");

    // Collapsed, the run is one summary row that names the call still running.
    await waitForTimelineLayout(window);
    await groupHeader.click();
    await expect(groupHeader).toHaveAttribute("aria-expanded", "false");
    await expect(toolRows).toHaveCount(0);
    await expect(group.locator(".timeline-tool-group__label")).toHaveText(
      "Ran 1 command, read 1 file",
    );
    await expect(group.locator(".timeline-tool-group__running")).toHaveText("Read src/a.ts");
    await expect(group.locator(".timeline-tool-group__meta")).toHaveText("2 tools · running");
    await expect(group).toHaveClass(/timeline-tool-group--running/);
    await waitForTimelineLayout(window);
    const runningBox = await groupHeader.boundingBox();

    // More calls stream in, one of them failing: the same row updates in place, at the same size,
    // and the failure shows while the run is still going.
    await emitTestSessionEvents(harness, [
      finished("call-r1", true, "contents of a"),
      started("call-g1", "grep", { pattern: "TODO" }),
      finished("call-g1", false, "grep: no matches"),
      started("call-r2", "read", { path: "src/b.ts" }),
    ]);
    await expect(group.locator(".timeline-tool-group__meta")).toHaveText(
      "4 tools · running · 1 failed",
    );
    await expect(group.locator(".timeline-tool-group__failed")).toBeVisible();
    await expect(group).toHaveClass(/timeline-tool-group--running/);
    await waitForTimelineLayout(window);
    expect(await groupHeader.boundingBox()).toEqual(runningBox);
    await emitTestSessionEvents(harness, [finished("call-r2", true, "R2_OUTPUT")]);
    await expect(group.locator(".timeline-tool-group__label")).toHaveText(
      "Ran 1 command, read 2 files, 1 search",
    );
    await expect(group.locator(".timeline-tool-group__meta")).toHaveText("4 tools · 1 failed");
    await expect(group).toHaveClass(/timeline-tool-group--error/);
    await expect(group.locator(".timeline-tool-group__running")).toHaveCount(0);
    await expect(groupHeader).toHaveAttribute("aria-expanded", "false");
    await expect(transcript.locator("[data-message-id]")).toHaveCount(1);
    await expect(transcript.locator('[data-message-id="tool-group:call-b1"]')).toHaveCount(1);
    await waitForTimelineLayout(window);
    expect(await groupHeader.boundingBox()).toEqual(runningBox);

    // Expanded, each call is the ordinary row, and its output opens on its own.
    await groupHeader.click();
    await expect(toolRows).toHaveCount(4);
    await expect(toolRow("no matches")).toHaveClass(/timeline-tool--error/);
    await waitForTimelineLayout(window);
    await toolRow("src/b.ts").locator(".timeline-tool__header").click();
    await expect(toolRow("src/b.ts").locator(".timeline-tool__body")).toContainText("R2_OUTPUT");

    // A call streaming into the open group neither folds it nor closes the open output.
    await emitTestSessionEvents(harness, [started("call-b2", "bash", { command: "echo done" })]);
    await expect(toolRows).toHaveCount(5);
    await expect(groupHeader).toHaveAttribute("aria-expanded", "true");
    await expect(toolRow("src/b.ts").locator(".timeline-tool__body")).toContainText("R2_OUTPUT");
    await expect(toolRow("echo done")).toHaveClass(/timeline-tool--running/);

    // Folding hides the calls; opening again brings back the output that was open.
    await waitForTimelineLayout(window);
    await groupHeader.click();
    await expect(toolRows).toHaveCount(0);
    await groupHeader.click();
    await expect(toolRow("src/b.ts").locator(".timeline-tool__body")).toContainText("R2_OUTPUT");
  } finally {
    await harness.close();
  }
});
