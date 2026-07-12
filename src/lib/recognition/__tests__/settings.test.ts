import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { prisma } from "@/lib/db/client";
import {
  deriveOpenAIModelsEndpoint,
  importProviderModels,
  parseOpenAICompatibleModelsResponse,
  resolveRecognitionProviders,
} from "../settings";

describe("provider model settings", () => {
  it("derives OpenAI-compatible models endpoint from base URL", () => {
    assert.equal(deriveOpenAIModelsEndpoint("https://api.example.com/v1"), "https://api.example.com/v1/models");
    assert.equal(deriveOpenAIModelsEndpoint("https://api.example.com"), "https://api.example.com/v1/models");
    assert.equal(deriveOpenAIModelsEndpoint("https://api.example.com/openai/v1/"), "https://api.example.com/openai/v1/models");
  });

  it("parses compatible model responses and rejects unsupported shapes", () => {
    const parsed = parseOpenAICompatibleModelsResponse({
      data: [{ id: "gpt-4.1", owned_by: "openai" }, "gpt-4.1-mini", { id: "gpt-4.1" }],
    });

    assert.deepEqual(parsed.map((model) => model.modelId), ["gpt-4.1", "gpt-4.1-mini"]);
    assert.throws(() => parseOpenAICompatibleModelsResponse({ models: [] }), /Unsupported models response shape/);
    assert.throws(() => parseOpenAICompatibleModelsResponse({ data: [] }), /did not contain model ids/);
  });

  it("imports models idempotently without removing manual models", async () => {
    const providerKey = "import-test";
    try {
      await cleanupProvider(providerKey);
      const provider = await prisma.aiProviderConfig.create({
        data: {
          providerKey,
          displayName: "Import Test",
          protocol: "openai_responses",
          baseUrl: "https://api.example.com/v1",
          apiKey: "test-key",
          enabled: true,
          models: {
            create: {
              modelId: "manual-only",
              displayName: "Manual",
              enabled: true,
              priority: 10,
              source: "manual",
              metadataJson: "{}",
            },
          },
        },
      });

      const fetcher = async () =>
        new Response(JSON.stringify({ data: [{ id: "gpt-4.1" }, { id: "manual-only" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });

      const first = await importProviderModels(provider.id, fetcher as typeof fetch);
      const second = await importProviderModels(provider.id, fetcher as typeof fetch);
      const models = await prisma.aiProviderModel.findMany({ where: { providerId: provider.id } });

      assert.equal(first.imported, 2);
      assert.equal(second.imported, 2);
      assert.equal(models.length, 2);
      assert.ok(models.some((model) => model.modelId === "manual-only" && model.enabled));
    } finally {
      await cleanupProvider(providerKey);
    }
  });

  it("resolves two enabled models from the same provider and falls back from missing models", async () => {
    const providerKey = "same-provider";
    try {
      await prisma.appSetting.deleteMany({ where: { key: "recognition.defaults" } });
      await cleanupProvider(providerKey);
      const provider = await prisma.aiProviderConfig.create({
        data: {
          providerKey,
          displayName: "Same Provider",
          protocol: "openai_responses",
          baseUrl: "https://api.example.com/v1",
          apiKey: "test-key",
          enabled: true,
          priority: 10,
          models: {
            create: [
              { modelId: "m1", displayName: "m1", enabled: true, priority: 10, source: "manual", metadataJson: "{}" },
              { modelId: "m2", displayName: "m2", enabled: true, priority: 20, source: "manual", metadataJson: "{}" },
            ],
          },
        },
      });
      await prisma.appSetting.upsert({
        where: { key: "recognition.defaults" },
        create: {
          key: "recognition.defaults",
          valueJson: JSON.stringify({
            primaryProviderKey: provider.providerKey,
            primaryModelId: "m1",
            secondaryProviderKey: provider.providerKey,
            secondaryModelId: "m2",
          }),
        },
        update: {
          valueJson: JSON.stringify({
            primaryProviderKey: provider.providerKey,
            primaryModelId: "missing",
            secondaryProviderKey: provider.providerKey,
            secondaryModelId: "m2",
          }),
        },
      });

      const resolved = await resolveRecognitionProviders({
        primaryProviderKey: provider.providerKey,
        primaryModelId: "m1",
        secondaryProviderKey: provider.providerKey,
        secondaryModelId: "m2",
      });
      assert.equal(resolved.primary.model.modelId, "m1");
      assert.equal(resolved.secondary.model.modelId, "m2");

      const fallback = await resolveRecognitionProviders({
        primaryProviderKey: provider.providerKey,
        primaryModelId: "missing",
      });
      assert.equal(fallback.primary.model.modelId, "m1");
    } finally {
      await prisma.appSetting.deleteMany({ where: { key: "recognition.defaults" } });
      await cleanupProvider(providerKey);
    }
  });
});

async function cleanupProvider(providerKey: string) {
  const provider = await prisma.aiProviderConfig.findUnique({ where: { providerKey } });
  if (!provider) return;
  await prisma.aiProviderModel.deleteMany({ where: { providerId: provider.id } });
  await prisma.aiProviderConfig.delete({ where: { id: provider.id } });
}
