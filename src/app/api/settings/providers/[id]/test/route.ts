import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { decryptSecret } from "@/lib/crypto/secret";
import { enforceRateLimit } from "@/lib/ratelimit";

export const runtime = "nodejs";

/** 连通性测试发送的最小提示词：让模型回一句话即可，不约束结构化输出（最大化兼容第三方网关）。 */
const PING_PROMPT = "hi";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const limited = enforceRateLimit(request, "provider-test", 10, 60_000);
  if (limited) return limited;

  const { id } = await params;
  const provider = await prisma.aiProviderConfig.findUnique({ where: { id } });
  if (!provider) {
    return NextResponse.json({ error: "Provider not found" }, { status: 404 });
  }
  if (!provider.apiKey?.trim()) {
    return NextResponse.json({ error: "Provider API key is empty" }, { status: 400 });
  }
  const body = await request.json().catch(() => ({}));
  const modelId = String(body.modelId ?? "").trim();
  if (!modelId) {
    return NextResponse.json({ error: "modelId is required" }, { status: 400 });
  }
  const model = await prisma.aiProviderModel.findFirst({
    where: { providerId: provider.id, modelId },
  });
  if (!model) {
    return NextResponse.json({ error: "Provider model not found" }, { status: 404 });
  }
  if (!model.enabled) {
    return NextResponse.json({ error: "Provider model is disabled" }, { status: 400 });
  }

  const apiKey = decryptSecret(provider.apiKey);
  const started = Date.now();
  try {
    let reply = "";
    if (provider.protocol === "openai_responses") {
      const client = new OpenAI({ apiKey, baseURL: provider.baseUrl || undefined });
      const response = await client.responses.create({
        model: model.modelId,
        input: PING_PROMPT,
        max_output_tokens: 256,
      });
      reply = response.output_text?.trim() ?? "";
    } else if (provider.protocol === "anthropic_messages") {
      const client = new Anthropic({ apiKey, baseURL: provider.baseUrl || undefined });
      const response = await client.messages.create({
        model: model.modelId,
        max_tokens: 256,
        messages: [{ role: "user", content: PING_PROMPT }],
      });
      reply = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("")
        .trim();
    } else {
      throw new Error(`Unsupported protocol: ${provider.protocol}`);
    }
    // 拿到 200 响应即视为连通；reply 为空也算连通（部分模型可能空回），但回传出去让用户自行判断。
    return NextResponse.json({ ok: true, latencyMs: Date.now() - started, prompt: PING_PROMPT, reply });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error), latencyMs: Date.now() - started },
      { status: 400 },
    );
  }
}
