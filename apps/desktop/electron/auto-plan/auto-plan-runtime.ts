import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory,
  InputEvent,
} from "@earendil-works/pi-coding-agent";

/**
 * Auto plan: before pi starts on a message, a small model decides whether the task needs a plan.
 * When it does, the run gets hidden instructions to explore, write the plan as a table and then
 * implement it without waiting, and the thread's extension dock shows "Plan" until the run settles.
 *
 * Only providers with a known small model are checked. Custom endpoints and local models send
 * as usual instead of running the thread's own, possibly slow or costly, model twice.
 */

/** Dock status shown while an auto-planned run is going. */
export const AUTO_PLAN_STATUS_KEY = "auto-plan";
export const AUTO_PLAN_STATUS_TEXT = "Plan";
/** customType of the hidden message that hands the plan instructions to the model. */
export const AUTO_PLAN_MESSAGE_TYPE = "pi-gui-auto-plan";
/** A decision slower than this counts as "no plan", so a message is never held up for long. */
export const AUTO_PLAN_DECISION_TIMEOUT_MS = 6_000;

export const AUTO_PLAN_INSTRUCTIONS = [
  "[pi-gui auto plan] A quick check found that this request needs a plan before implementation.",
  "",
  "1. Explore first: read the code and context you need to plan well. Do not change files yet.",
  '2. Write the plan in your reply under a "### Plan" heading, as a Markdown table with the columns #, Step, Files and Check. Use one row per concrete step and keep cells short.',
  "3. Then implement the plan right away, step by step, without waiting for approval. If another active mode forbids changing files, follow that mode instead.",
  '4. When you are done, add a "### Result" heading with a Markdown table with the columns #, Step and Status. Mark each step ✅ done, ⚠️ partly done or ❌ not done, with a short note where it helps.',
].join("\n");

/** The small model that decides for each provider, so the check uses the thread's credentials. */
export const AUTO_PLAN_DECIDER_MODELS: Readonly<Record<string, string>> = {
  anthropic: "claude-haiku-4-5",
  openai: "gpt-4.1-mini",
  "openai-codex": "gpt-5.3-codex-spark",
  google: "gemini-2.5-flash-lite",
  "github-copilot": "claude-haiku-4.5",
  openrouter: "anthropic/claude-haiku-4.5",
};

const DECIDER_SYSTEM_PROMPT = [
  "You route requests for a coding agent. Decide whether the user's latest message needs an implementation plan before the agent starts working.",
  "",
  "Answer PLAN when the message asks the agent to build, change, fix or refactor something that takes several steps or touches several files or parts of the system: a new feature, a refactor, a migration, a multi-part bug fix, or a change whose approach must first be worked out.",
  "",
  'Answer DIRECT for everything else: questions and explanations, reviews, reading or searching code, a small or single-step edit, running a command, confirmations and short follow-ups such as "yes", "go on" or "do it", feedback on earlier work, and conversation.',
  "",
  "Reply with one word: PLAN or DIRECT.",
].join("\n");

const MAX_MESSAGE_CHARS = 6_000;
const MAX_PREVIOUS_REPLY_CHARS = 2_000;
const DECIDER_MAX_TOKENS = 256;

export type AutoPlanDecision = "plan" | "direct";

export interface AutoPlanRequest {
  readonly message: string;
  /** The assistant's previous reply, so short follow-ups are read in context. */
  readonly previousReply?: string;
}

export type AutoPlanDecider = (
  request: AutoPlanRequest,
  ctx: ExtensionContext,
  signal: AbortSignal,
) => Promise<AutoPlanDecision>;

export interface AutoPlanExtensionOptions {
  readonly decide?: AutoPlanDecider;
  readonly timeoutMs?: number;
}

type ChatModel = NonNullable<ExtensionContext["model"]>;
type DeciderReply = Awaited<
  ReturnType<ReturnType<ExtensionContext["modelRegistry"]["streamSimple"]>["result"]>
>;

export function createAutoPlanExtension(options: AutoPlanExtensionOptions = {}): ExtensionFactory {
  const decide = options.decide ?? decideWithModel;
  const timeoutMs = options.timeoutMs ?? AUTO_PLAN_DECISION_TIMEOUT_MS;
  return (pi: ExtensionAPI) => {
    // pi emits `input` and then `before_agent_start` inside the same prompt() call, so the
    // decision always belongs to the run that call starts; every prompt resets it first.
    let planNextRun = false;
    let planRunActive = false;

    pi.on("input", async (event, ctx) => {
      planNextRun = false;
      if (!shouldCheckInput(event)) return;
      const request = autoPlanRequest(event.text, ctx.sessionManager.getBranch());
      planNextRun = (await decideWithin(decide, request, ctx, timeoutMs)) === "plan";
    });

    pi.on("before_agent_start", (_event, ctx) => {
      if (!planNextRun) return;
      planNextRun = false;
      planRunActive = true;
      ctx.ui.setStatus(AUTO_PLAN_STATUS_KEY, AUTO_PLAN_STATUS_TEXT);
      return {
        message: {
          customType: AUTO_PLAN_MESSAGE_TYPE,
          content: AUTO_PLAN_INSTRUCTIONS,
          display: false,
        },
      };
    });

    pi.on("agent_settled", (_event, ctx) => {
      if (!planRunActive) return;
      planRunActive = false;
      ctx.ui.setStatus(AUTO_PLAN_STATUS_KEY, undefined);
    });
  };
}

/**
 * Every message that starts a run is checked. Steering and follow-ups join the run that is
 * going, another extension's message belongs to that extension's workflow, and slash
 * commands, skills and prompt templates already say what to do.
 */
export function shouldCheckInput(
  event: Pick<InputEvent, "text" | "source" | "streamingBehavior">,
): boolean {
  if (event.streamingBehavior || event.source === "extension") return false;
  const text = event.text.trim();
  return text.length > 0 && !text.startsWith("/");
}

/** The message to decide on, plus the latest assistant reply on the branch for context. */
export function autoPlanRequest(message: string, branch: readonly unknown[]): AutoPlanRequest {
  const previousReply = latestAssistantText(branch);
  return { message, ...(previousReply ? { previousReply } : {}) };
}

/** First word wins, so "PLAN", "plan." and "Plan — several files" all mean plan. */
export function parseAutoPlanDecision(text: string): AutoPlanDecision {
  const firstWord = text.trim().split(/\s+/, 1)[0] ?? "";
  return firstWord.replace(/[^a-z]/gi, "").toUpperCase() === "PLAN" ? "plan" : "direct";
}

/** The thread's provider's small model, when pi knows it and the provider has credentials. */
export function pickDeciderModel(
  ctx: Pick<ExtensionContext, "model" | "modelRegistry">,
): ChatModel | undefined {
  const provider = ctx.model?.provider;
  const modelId = provider ? AUTO_PLAN_DECIDER_MODELS[provider] : undefined;
  const model = provider && modelId ? ctx.modelRegistry.find(provider, modelId) : undefined;
  return model && ctx.modelRegistry.hasConfiguredAuth(model) ? model : undefined;
}

async function decideWithin(
  decide: AutoPlanDecider,
  request: AutoPlanRequest,
  ctx: ExtensionContext,
  timeoutMs: number,
): Promise<AutoPlanDecision> {
  const controller = new AbortController();
  const timedOut = new Promise<AutoPlanDecision>((resolve) => {
    controller.signal.addEventListener("abort", () => resolve("direct"), { once: true });
  });
  const timer = setTimeout(() => {
    console.warn(`[auto-plan] no decision within ${timeoutMs} ms; sending without a plan`);
    controller.abort();
  }, timeoutMs);
  try {
    return await Promise.race([decide(request, ctx, controller.signal), timedOut]);
  } catch (error) {
    console.warn("[auto-plan] decision failed; sending without a plan:", error);
    return "direct";
  } finally {
    clearTimeout(timer);
    // Stops a decider that is still working after a timeout or failure.
    controller.abort();
  }
}

async function decideWithModel(
  request: AutoPlanRequest,
  ctx: ExtensionContext,
  signal: AbortSignal,
): Promise<AutoPlanDecision> {
  const model = pickDeciderModel(ctx);
  if (!model) return "direct";
  const reply = await ctx.modelRegistry
    .streamSimple(
      model,
      {
        systemPrompt: DECIDER_SYSTEM_PROMPT,
        messages: [{ role: "user", content: deciderPrompt(request), timestamp: Date.now() }],
      },
      { maxTokens: DECIDER_MAX_TOKENS, signal },
    )
    .result();
  if (reply.stopReason === "error") {
    console.warn(
      `[auto-plan] ${model.provider}/${model.id} could not decide; sending without a plan:`,
      reply.errorMessage,
    );
    return "direct";
  }
  return reply.stopReason === "aborted" ? "direct" : parseAutoPlanDecision(replyText(reply));
}

function deciderPrompt(request: AutoPlanRequest): string {
  const message = request.message.trim().slice(0, MAX_MESSAGE_CHARS);
  const previousReply = request.previousReply?.trim().slice(-MAX_PREVIOUS_REPLY_CHARS);
  return [
    ...(previousReply
      ? ["Previous assistant reply (context only):", "<<<", previousReply, ">>>", ""]
      : []),
    "Latest user message:",
    "<<<",
    message,
    ">>>",
  ].join("\n");
}

function replyText(reply: DeciderReply): string {
  return reply.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("")
    .trim();
}

function latestAssistantText(branch: readonly unknown[]): string | undefined {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) continue;
    if (entry.message.role !== "assistant" || !Array.isArray(entry.message.content)) continue;
    const text = entry.message.content
      .flatMap((part: unknown) =>
        isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : [],
      )
      .join("")
      .trim();
    if (text) return text;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
