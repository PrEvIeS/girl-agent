import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import type { ProfileConfig } from "../types.js";
import {
  withFreshToken,
  wrapForLazy401Retry,
  OAUTH_BETA_HEADER,
  type SaveCallback
} from "./oauth.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: ChatContent;
}

export type ChatContent = string | ChatContentPart[];

export type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string };

export interface LLMOptions {
  temperature?: number;
  maxTokens?: number;
  json?: boolean;
}

export interface LLMClient {
  chat(messages: ChatMessage[], opts?: LLMOptions): Promise<string>;
}

export interface MakeLLMOptions {
  /** Required when `cfg.authMethod === "oauth"` — same ref Runtime holds, so refresh-mutation propagates. */
  profile?: ProfileConfig;
  /** Defaults to `{ kind: "persist", slug: profile.slug }` when omitted and `profile` is provided. */
  save?: SaveCallback;
}

class OpenAILike implements LLMClient {
  private client: OpenAI;
  constructor(private cfg: ProfileConfig["llm"]) {
    this.client = new OpenAI({
      apiKey: cfg.apiKey,
      baseURL: cfg.baseURL || undefined
    });
  }
  async chat(messages: ChatMessage[], opts: LLMOptions = {}): Promise<string> {
    const res = await this.client.chat.completions.create({
      model: this.cfg.model,
      messages: messages.map(m => ({
        role: m.role,
        content: typeof m.content === "string"
          ? m.content
          : m.content.map(p => p.type === "text"
            ? { type: "text" as const, text: p.text }
            : { type: "image_url" as const, image_url: { url: `data:${p.mimeType};base64,${p.data}` } })
      })) as any,
      temperature: opts.temperature ?? 0.85,
      max_tokens: opts.maxTokens ?? 600,
      response_format: opts.json ? { type: "json_object" } : undefined
    });
    return res.choices[0]?.message?.content?.trim() ?? "";
  }
}

class AnthropicLike implements LLMClient {
  private client: Anthropic;
  private currentAccessToken: string | null;
  // MAJOR-2 race resolution: the `profile` ref here is the same one Runtime holds.
  // `persistOAuth` (called inside `withFreshToken` via `save = { kind: "persist", ... }`)
  // mutates it in-place BEFORE resolving. Subsequent `writeConfig(this.cfg)` calls
  // in runtime.ts:152, 511, 757, 776 see the fresh oauth and don't roll back.
  constructor(
    private cfg: ProfileConfig["llm"],
    private profile?: ProfileConfig,
    private save?: SaveCallback
  ) {
    if (cfg.authMethod === "oauth") {
      if (!cfg.oauth) throw new Error("AnthropicLike: authMethod=oauth but llm.oauth missing");
      this.currentAccessToken = cfg.oauth.accessToken;
      this.client = buildOAuthClient(cfg, cfg.oauth.accessToken);
    } else {
      this.currentAccessToken = null;
      this.client = new Anthropic({
        apiKey: cfg.apiKey,
        baseURL: cfg.baseURL || undefined
      });
    }
  }
  async chat(messages: ChatMessage[], opts: LLMOptions = {}): Promise<string> {
    if (this.cfg.authMethod === "oauth") {
      if (!this.profile) throw new Error("AnthropicLike: authMethod=oauth requires `profile` in MakeLLMOptions");
      const save: SaveCallback = this.save ?? { kind: "persist", slug: this.profile.slug };
      const fresh = await withFreshToken(this.profile, save);
      if (fresh !== this.currentAccessToken) {
        this.currentAccessToken = fresh;
        this.client = buildOAuthClient(this.cfg, fresh);
      }
      return wrapForLazy401Retry(
        () => this.callMessages(messages, opts),
        async () => {
          // Force a refresh: clear the access token so withFreshToken treats it as expired.
          // We rely on withFreshToken's single-flight to coalesce concurrent refreshes.
          if (!this.profile) return;
          if (this.profile.llm.oauth) {
            this.profile.llm.oauth = { ...this.profile.llm.oauth, expiresAt: 0 };
          }
          const refreshed = await withFreshToken(this.profile, save);
          this.currentAccessToken = refreshed;
          this.client = buildOAuthClient(this.cfg, refreshed);
        },
        this.profile.slug
      );
    }
    return this.callMessages(messages, opts);
  }
  private async callMessages(messages: ChatMessage[], opts: LLMOptions): Promise<string> {
    const system = messages.filter(m => m.role === "system").map(m => contentToText(m.content)).join("\n\n");
    const rest = messages
      .filter(m => m.role !== "system")
      .filter(m => contentToText(m.content).trim().length > 0)
      .map(m => ({
        role: (m.role === "assistant" ? "assistant" : "user") as "assistant" | "user",
        content: m.content
      }));

    // Anthropic требует чередование ролей и старт с user — мерджим подряд одинаковые
    const merged: { role: "user" | "assistant"; content: ChatContent }[] = [];
    for (const m of rest) {
      const last = merged[merged.length - 1];
      if (last && last.role === m.role) {
        last.content = mergeContent(last.content, m.content);
      } else {
        merged.push({ ...m });
      }
    }
    // Должно начинаться с user
    if (merged.length === 0 || merged[0]!.role !== "user") {
      merged.unshift({ role: "user", content: "(продолжай)" });
    }
    // Должно заканчиваться на user
    if (merged[merged.length - 1]!.role !== "user") {
      merged.push({ role: "user", content: "(продолжай)" });
    }

    const res = await this.client.messages.create({
      model: this.cfg.model,
      system: system || undefined,
      max_tokens: opts.maxTokens ?? 600,
      temperature: opts.temperature ?? 0.85,
      messages: merged.map(m => ({ role: m.role, content: anthropicContent(m.content) })) as any
    });
    const block = res.content.find(c => c.type === "text");
    return block && "text" in block ? block.text.trim() : "";
  }
}

function buildOAuthClient(cfg: ProfileConfig["llm"], accessToken: string): Anthropic {
  return new Anthropic({
    apiKey: "",
    baseURL: cfg.baseURL || undefined,
    defaultHeaders: {
      Authorization: `Bearer ${accessToken}`,
      "anthropic-beta": OAUTH_BETA_HEADER
    }
  });
}

function contentToText(content: ChatContent): string {
  if (typeof content === "string") return content;
  return content.map(p => p.type === "text" ? p.text : `[image:${p.mimeType}]`).join("\n");
}

function mergeContent(a: ChatContent, b: ChatContent): ChatContent {
  if (typeof a === "string" && typeof b === "string") return a + "\n" + b;
  const aa: ChatContentPart[] = typeof a === "string" ? [{ type: "text", text: a }] : a;
  const bb: ChatContentPart[] = typeof b === "string" ? [{ type: "text", text: b }] : b;
  return [...aa, ...bb];
}

function anthropicContent(content: ChatContent): any {
  if (typeof content === "string") return content;
  return content.map(p => p.type === "text"
    ? { type: "text", text: p.text }
    : {
      type: "image",
      source: {
        type: "base64",
        media_type: p.mimeType,
        data: p.data
      }
    });
}

export function makeLLM(cfg: ProfileConfig["llm"], opts: MakeLLMOptions = {}): LLMClient {
  if (cfg.proto === "anthropic") return new AnthropicLike(cfg, opts.profile, opts.save);
  return new OpenAILike(cfg);
}
