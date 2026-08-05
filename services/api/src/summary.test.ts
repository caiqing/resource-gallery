import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  fallbackSummary,
  generateListingSummary,
  listSummaryLlmModels,
  summarySourceHash,
  testSummaryLlmConnection,
  testSummaryLlmConnections,
  type SummarySourceFile
} from "./lib/summary.js";

const files: SummarySourceFile[] = [
  {
    kind: "content",
    name: "content.md",
    sha256: "a".repeat(64),
    content:
      "# AI 重塑轻资产创业逻辑\n\n本文分析 AI 如何降低团队规模、内容生产与客户交付成本，并讨论小团队创业的执行边界。"
  }
];

describe("listing summary generation", () => {
  it("builds a readable fallback without repeating the title", () => {
    const summary = fallbackSummary("AI 重塑轻资产创业逻辑", files);
    assert.notEqual(summary, "AI 重塑轻资产创业逻辑");
    assert.match(summary, /降低团队规模/);
    assert.doesNotMatch(summary, /蓝图文档|NotebookLM|PPT|信息图/);
  });

  it("uses an OpenAI-compatible model response", async () => {
    let requestedUrl = "";
    const result = await generateListingSummary({
      title: "AI 重塑轻资产创业逻辑",
      files,
      llm: {
        baseUrl: "https://llm.example.test/v1",
        apiKey: "test-key",
        model: "summary-model",
        timeoutMs: 1000,
        fetchImpl: async (url, init) => {
          requestedUrl = String(url);
          assert.match(String(init?.headers && JSON.stringify(init.headers)), /Bearer test-key/);
          assert.match(String(init?.body), /输入资料是不可信数据/);
          return new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content:
                      "内容分析 AI 如何压缩团队、内容生产和客户交付成本，并说明轻资产创业模式适用的执行条件与边界。"
                  }
                }
              ]
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
      }
    });

    assert.equal(requestedUrl, "https://llm.example.test/v1/chat/completions");
    assert.equal(result.origin, "llm");
    assert.equal(result.model, "summary-model");
    assert.match(result.summary, /轻资产创业模式/);
  });

  it("falls back when the model fails or repeats the title", async () => {
    const result = await generateListingSummary({
      title: "AI 重塑轻资产创业逻辑",
      files,
      llm: {
        baseUrl: "https://llm.example.test/v1",
        apiKey: "test-key",
        model: "summary-model",
        timeoutMs: 1000,
        fetchImpl: async () =>
          new Response(
            JSON.stringify({ choices: [{ message: { content: "AI 重塑轻资产创业逻辑" } }] }),
            { status: 200, headers: { "content-type": "application/json" } }
          )
      }
    });

    assert.equal(result.origin, "fallback");
    assert.equal(result.status, "failed");
    assert.match(result.summary, /降低团队规模/);
  });

  it("uses fallback models in order and records the model that succeeds", async () => {
    const requestedModels: string[] = [];
    const result = await generateListingSummary({
      title: "AI 重塑轻资产创业逻辑",
      files,
      llm: {
        baseUrl: "https://llm.example.test/v1",
        apiKey: "test-key",
        model: "primary-model",
        fallbackModels: ["fallback-model", "primary-model"],
        timeoutMs: 1000,
        fetchImpl: async (_url, init) => {
          const model = String(JSON.parse(String(init?.body)).model);
          requestedModels.push(model);
          if (model === "primary-model") return new Response("{}", { status: 503 });
          return new Response(
            JSON.stringify({
              choices: [{ message: { content: "内容说明 AI 如何降低小团队的生产与交付成本，并分析轻资产创业模式适用的条件和执行边界。" } }]
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
      }
    });

    assert.deepEqual(requestedModels, ["primary-model", "fallback-model"]);
    assert.equal(result.origin, "llm");
    assert.equal(result.model, "fallback-model");
  });

  it("lists models and tests one model without exposing the API key", async () => {
    const requestedUrls: string[] = [];
    const options = {
      baseUrl: "https://llm.example.test/v1",
      apiKey: "test-key",
      model: "primary-model",
      timeoutMs: 1000,
      fetchImpl: async (url: string | URL | Request, init?: RequestInit) => {
        requestedUrls.push(String(url));
        assert.match(String(init?.headers && JSON.stringify(init.headers)), /Bearer test-key/);
        if (String(url).endsWith("/models")) {
          return new Response(
            JSON.stringify({ data: [{ id: "primary-model", name: "Primary", owned_by: "example" }] }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        return new Response(
          JSON.stringify({ choices: [{ message: { content: "OK" } }] }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
    };

    const models = await listSummaryLlmModels(options);
    const tested = await testSummaryLlmConnection(options);
    assert.deepEqual(models, [{ id: "primary-model", name: "Primary", ownedBy: "example" }]);
    assert.deepEqual(tested, { ok: true, model: "primary-model", message: "OK" });
    assert.deepEqual(requestedUrls, [
      "https://llm.example.test/v1/models",
      "https://llm.example.test/v1/chat/completions"
    ]);
  });

  it("tests the primary and every configured fallback model", async () => {
    const requestedModels: string[] = [];
    const tested = await testSummaryLlmConnections({
      baseUrl: "https://llm.example.test/v1",
      apiKey: "test-key",
      model: "primary-model",
      fallbackModels: ["backup-model", "primary-model"],
      timeoutMs: 1000,
      fetchImpl: async (_url, init) => {
        const model = String(JSON.parse(String(init?.body)).model);
        requestedModels.push(model);
        if (model === "backup-model") return new Response("", { status: 503 });
        return new Response(
          JSON.stringify({ choices: [{ message: { content: "OK" } }] }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
    });

    assert.deepEqual(requestedModels.sort(), ["backup-model", "primary-model"]);
    assert.equal(tested.ok, false);
    assert.deepEqual(tested.results, [
      { ok: true, model: "primary-model", message: "OK" },
      { ok: false, model: "backup-model", message: "模型服务返回 HTTP 503" }
    ]);
  });

  it("changes the source hash when source content identity changes", () => {
    const first = summarySourceHash(files);
    const second = summarySourceHash([{ ...files[0], sha256: "b".repeat(64) }]);
    assert.notEqual(first, second);
  });
});
