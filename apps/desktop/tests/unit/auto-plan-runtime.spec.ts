import { expect, test } from "@playwright/test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";
import { AUTO_PLAN_EXTENSION_NAME, AUTO_PLAN_EXTENSION_PATH } from "../../contracts/auto-plan";
import {
  AUTO_PLAN_DECIDER_MODELS,
  AUTO_PLAN_INSTRUCTIONS,
  AUTO_PLAN_MESSAGE_TYPE,
  AUTO_PLAN_STATUS_KEY,
  AUTO_PLAN_STATUS_TEXT,
  autoPlanRequest,
  createAutoPlanExtension,
  parseAutoPlanDecision,
  pickDeciderModel,
  shouldCheckInput,
  type AutoPlanDecider,
  type AutoPlanRequest,
} from "../../electron/auto-plan/auto-plan-runtime";

// The desktop Playwright harness uses CommonJS; pi's and the driver's entries are ESM-only.
const jiti = createJiti(__filename);

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

/** The extension loaded into a stand-in for pi that records handlers and dock statuses. */
function loadAutoPlan(
  decide: AutoPlanDecider | undefined,
  options: { timeoutMs?: number } = {},
  context: { model?: unknown; modelRegistry?: unknown } = {},
) {
  const handlers = new Map<string, Handler>();
  const pi = {
    on: (name: string, handler: Handler) => {
      handlers.set(name, handler);
      return () => handlers.delete(name);
    },
  } as unknown as ExtensionAPI;
  void createAutoPlanExtension({ ...(decide ? { decide } : {}), ...options })(pi);
  const statuses = new Map<string, string>();
  let branch: readonly unknown[] = [];
  const ctx = {
    ui: {
      setStatus: (key: string, text: string | undefined) => {
        if (text === undefined) statuses.delete(key);
        else statuses.set(key, text);
      },
    },
    sessionManager: { getBranch: () => branch },
    ...context,
  } as unknown as ExtensionContext;
  const emit = async (name: string, event: object) =>
    handlers.get(name)?.({ type: name, ...event }, ctx);
  return {
    statuses,
    setBranch: (entries: readonly unknown[]) => {
      branch = entries;
    },
    input: (text: string, extra: object = {}) => emit("input", { text, source: "interactive", ...extra }),
    /** pi's order inside prompt(): input, then before_agent_start for the run it starts. */
    prompt: async (text: string, extra: object = {}) => {
      await emit("input", { text, source: "interactive", ...extra });
      return emit("before_agent_start", { prompt: text, systemPrompt: "", systemPromptOptions: {} });
    },
    settle: () => emit("agent_settled", { outcome: "completed" }),
  };
}

function assistant(...content: object[]) {
  return { type: "message", message: { role: "assistant", content } };
}

test("a message that needs a plan starts its run with hidden instructions and shows Plan until it settles", async () => {
  const autoPlan = loadAutoPlan(async () => "plan");

  const result = await autoPlan.prompt("Add an auto plan switch to Settings and wire it to main");

  expect(result).toEqual({
    message: { customType: AUTO_PLAN_MESSAGE_TYPE, content: AUTO_PLAN_INSTRUCTIONS, display: false },
  });
  expect(autoPlan.statuses.get(AUTO_PLAN_STATUS_KEY)).toBe(AUTO_PLAN_STATUS_TEXT);
  await autoPlan.settle();
  expect(autoPlan.statuses.has(AUTO_PLAN_STATUS_KEY)).toBe(false);
});

test("the plan instructions ask for a plan table, implementation without approval and a result table", () => {
  expect(AUTO_PLAN_INSTRUCTIONS).toContain('"### Plan"');
  expect(AUTO_PLAN_INSTRUCTIONS).toContain("#, Step, Files and Check");
  expect(AUTO_PLAN_INSTRUCTIONS).toContain("without waiting for approval");
  expect(AUTO_PLAN_INSTRUCTIONS).toContain('"### Result"');
});

test("a message that needs no plan runs unchanged and shows no status", async () => {
  const autoPlan = loadAutoPlan(async () => "direct");

  expect(await autoPlan.prompt("What does isLeaseDead do?")).toBeUndefined();
  expect(autoPlan.statuses.size).toBe(0);
});

test("a plan decision belongs only to the run its own prompt starts", async () => {
  const decisions: ("plan" | "direct")[] = ["plan", "direct"];
  const autoPlan = loadAutoPlan(async () => decisions.shift() ?? "direct");

  // The first prompt never reaches a run (another extension handled its input)...
  await autoPlan.input("Refactor the composer into three modules");
  // ...so the next prompt decides afresh and its run gets nothing.
  expect(await autoPlan.prompt("thanks")).toBeUndefined();
  expect(autoPlan.statuses.size).toBe(0);
});

test("steering, follow-ups, extension messages and slash commands are not checked", async () => {
  const checked: AutoPlanRequest[] = [];
  const autoPlan = loadAutoPlan(async (request) => {
    checked.push(request);
    return "plan";
  });

  for (const [text, extra] of [
    ["Also update the docs", { streamingBehavior: "steer" }],
    ["Then run the tests", { streamingBehavior: "followUp" }],
    ["Implement the plan.", { source: "extension" }],
    ["/plan build the importer", {}],
    ["/skill:review the diff", {}],
    ["   ", {}],
  ] as const) {
    expect(await autoPlan.prompt(text, extra)).toBeUndefined();
  }
  expect(checked).toEqual([]);
  expect(shouldCheckInput({ text: "Build an importer", source: "interactive" })).toBe(true);
  expect(shouldCheckInput({ text: "Build an importer", source: "rpc" })).toBe(true);
});

test("a decision that fails sends the message without a plan", async () => {
  const autoPlan = loadAutoPlan(async () => {
    throw new Error("provider unavailable");
  });

  expect(await autoPlan.prompt("Build an importer with tests")).toBeUndefined();
  expect(autoPlan.statuses.size).toBe(0);
});

test("a decision that never arrives is cut off, aborted and sends the message without a plan", async () => {
  let deciderSignal: AbortSignal | undefined;
  // This decider never answers, so only the timeout can let the prompt continue.
  const autoPlan = loadAutoPlan(
    (_request, _ctx, signal) => {
      deciderSignal = signal;
      return new Promise(() => undefined);
    },
    { timeoutMs: 5 },
  );

  expect(await autoPlan.prompt("Build an importer with tests")).toBeUndefined();
  expect(deciderSignal?.aborted).toBe(true);
});

test("the decider gets the latest assistant text on the branch as context", async () => {
  const checked: AutoPlanRequest[] = [];
  const autoPlan = loadAutoPlan(async (request) => {
    checked.push(request);
    return "direct";
  });
  autoPlan.setBranch([
    assistant({ type: "text", text: "Older reply" }),
    { type: "message", message: { role: "user", content: [{ type: "text", text: "go" }] } },
    assistant({ type: "text", text: "Want me to build it?" }),
    // A reply that only called tools has no text to read.
    assistant({ type: "toolCall", id: "t1", name: "bash", arguments: {} }),
    { type: "custom", customType: "note", data: {} },
  ]);

  await autoPlan.prompt("yes, do it");

  expect(checked).toEqual([{ message: "yes, do it", previousReply: "Want me to build it?" }]);
  expect(autoPlanRequest("hi", [])).toEqual({ message: "hi" });
});

test("the first word of the decider's reply decides", () => {
  expect(parseAutoPlanDecision("PLAN")).toBe("plan");
  expect(parseAutoPlanDecision(" plan.")).toBe("plan");
  expect(parseAutoPlanDecision("Plan — touches several files")).toBe("plan");
  expect(parseAutoPlanDecision("DIRECT")).toBe("direct");
  expect(parseAutoPlanDecision("PLANNING")).toBe("direct");
  expect(parseAutoPlanDecision("")).toBe("direct");
});

const haiku = { provider: "anthropic", id: "claude-haiku-4-5" };
const opus = { provider: "anthropic", id: "claude-opus-5-5" };

/** A model registry that knows Haiku and answers every request with `reply`. */
function registryReplying(
  reply: { stopReason: string; text?: string; errorMessage?: string },
  options: { authed?: boolean } = {},
) {
  const requests: { model: unknown; context: { messages: { content: unknown }[] } }[] = [];
  return {
    requests,
    modelRegistry: {
      find: (provider: string, id: string) =>
        provider === haiku.provider && id === haiku.id ? haiku : undefined,
      hasConfiguredAuth: () => options.authed ?? true,
      streamSimple: (model: unknown, context: { messages: { content: unknown }[] }) => {
        requests.push({ model, context });
        return {
          result: async () => ({
            stopReason: reply.stopReason,
            errorMessage: reply.errorMessage,
            content: reply.text ? [{ type: "text", text: reply.text }] : [],
          }),
        };
      },
    },
  };
}

test("the built-in decider asks the provider's small model and plans when it says PLAN", async () => {
  const registry = registryReplying({ stopReason: "stop", text: "PLAN" });
  const autoPlan = loadAutoPlan(undefined, {}, { model: opus, modelRegistry: registry.modelRegistry });

  expect(await autoPlan.prompt("Build an importer with tests")).toBeDefined();
  expect(registry.requests).toHaveLength(1);
  expect(registry.requests[0]?.model).toBe(haiku);
  expect(String(registry.requests[0]?.context.messages[0]?.content)).toContain(
    "Build an importer with tests",
  );
});

test("the built-in decider sends without a plan when the small model answers DIRECT or fails", async () => {
  for (const reply of [
    { stopReason: "stop", text: "DIRECT" },
    { stopReason: "error", errorMessage: "401 invalid x-api-key" },
  ]) {
    const registry = registryReplying(reply);
    const autoPlan = loadAutoPlan(undefined, {}, { model: opus, modelRegistry: registry.modelRegistry });
    expect(await autoPlan.prompt("Build an importer with tests")).toBeUndefined();
    expect(registry.requests).toHaveLength(1);
  }
});

test("without a known, signed-in small model the check asks no model at all", async () => {
  for (const [model, authed] of [
    // A custom endpoint or local model: running it twice per message would be slow or costly.
    [{ provider: "local-llama", id: "qwen" }, true],
    // pi knows Haiku, but the provider has no credentials.
    [opus, false],
    [undefined, true],
  ] as const) {
    const registry = registryReplying({ stopReason: "stop", text: "PLAN" }, { authed });
    const autoPlan = loadAutoPlan(undefined, {}, { model, modelRegistry: registry.modelRegistry });
    expect(await autoPlan.prompt("Build an importer with tests")).toBeUndefined();
    expect(registry.requests).toEqual([]);
  }
  const pick = (model: unknown) =>
    pickDeciderModel({
      model,
      modelRegistry: registryReplying({ stopReason: "stop" }).modelRegistry,
    } as unknown as Pick<ExtensionContext, "model" | "modelRegistry">);
  expect(pick(opus)).toBe(haiku);
  // OpenAI's small model is unknown to this registry.
  expect(pick({ provider: "openai", id: "gpt-5" })).toBeUndefined();
});

test("every small decider model is in pi's model catalog", async () => {
  const { ModelRegistry, ModelRuntime } = await jiti.import<
    typeof import("@earendil-works/pi-coding-agent")
  >("@earendil-works/pi-coding-agent");
  const dir = join(tmpdir(), `auto-plan-catalog-${process.pid}`);
  const runtime = await ModelRuntime.create({
    authPath: join(dir, "auth.json"),
    modelsPath: join(dir, "models.json"),
    refreshOnCreate: false,
  });
  const registry = new ModelRegistry(runtime);
  const missing = Object.entries(AUTO_PLAN_DECIDER_MODELS).filter(
    ([provider, id]) => !registry.find(provider, id),
  );
  expect(missing).toEqual([]);
});

test("the shared extension path is the one pi reports for the built-in", async () => {
  const { builtinExtensionPath } =
    await jiti.import<typeof import("@pi-gui/pi-sdk-driver")>("@pi-gui/pi-sdk-driver");
  expect(builtinExtensionPath(AUTO_PLAN_EXTENSION_NAME)).toBe(AUTO_PLAN_EXTENSION_PATH);
});
