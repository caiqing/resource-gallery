import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateListingTags, inferTopicAndTags } from "./lib/tags.js";
import { TOPIC_DEFINITIONS, TOPIC_IDS } from "./lib/topics.js";

function mockLlm(content: string, seen: string[]) {
  return {
    enabled: true,
    baseUrl: "https://llm.example/v1",
    apiKey: "test-key",
    model: "tag-model",
    fallbackModels: [],
    timeoutMs: 1_000,
    fetchImpl: async (_input: URL | RequestInfo, init?: RequestInit) => {
      seen.push(String(init?.body ?? ""));
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
    }
  } as any;
}

describe("semantic listing tags", () => {
  it("keeps the controlled topic catalog unique and practically scoped", () => {
    assert.equal(TOPIC_DEFINITIONS.length, 16);
    assert.equal(new Set(TOPIC_IDS).size, TOPIC_IDS.length);
    assert.ok(TOPIC_IDS.includes("health"));
    assert.ok(TOPIC_IDS.includes("humanities"));
    assert.ok(TOPIC_IDS.includes("enterprise"));
    assert.ok(TOPIC_IDS.includes("creator"));
  });

  it("does not derive a topic tag from internal prompt filenames", () => {
    const result = inferTopicAndTags({
      title: "个人成长与职场效率",
      summary: "讨论如何建立可持续的工作习惯和复盘机制。"
    });
    assert.deepEqual(result.tags, ["个人成长"]);
    assert.notEqual(result.tags[0], "prompt");
  });

  it("classifies AI and Codex content instead of leaving it pending", () => {
    const result = inferTopicAndTags({
      title: "Codex自制轻量ERP，AI编程非玩具",
      summary: "一位非程序员利用 AI 编程工具 Codex 开发多平台网店 ERP。"
    });
    assert.equal(result.topicId, "enterprise");
    assert.deepEqual(result.tags, ["企业数字化"]);
    assert.notDeepEqual(result.tags, ["待确认"]);
  });

  it("routes health and humanities content out of the generic fallback", () => {
    assert.equal(inferTopicAndTags({
      title: "三个经典的居家抗阻训练",
      summary: "讲解力量训练动作和日常健身方法。"
    }).topicId, "health");
    assert.equal(inferTopicAndTags({
      title: "秦统一六国的历史经验",
      summary: "从历史与地缘政治角度分析秦朝崛起。"
    }).topicId, "humanities");
  });

  it("keeps common AI research names out of the pending fallback", () => {
    assert.equal(inferTopicAndTags({ title: "Karpathy 的研究方法" }).topicId, "ai-eng");
    assert.equal(inferTopicAndTags({ title: "第四种黑猩猩 · AGI" }).topicId, "ai-eng");
  });

  it("uses the configured model with content, not asset filenames", async () => {
    const requests: string[] = [];
    const result = await generateListingTags({
      title: "独立开发者的产品冷启动",
      summary: "围绕早期用户验证、需求取舍与增长路径展开。",
      files: [
        { kind: "content", name: "content.md", sha256: "a", content: "产品冷启动需要先验证真实需求。" },
        { kind: "prompt", name: "产品-prompt.md", sha256: "b", content: "这是一份内部提示词，不应成为主题标签。" }
      ],
      llm: mockLlm('{"topic_id":"pm","tags":["产品冷启动","用户验证"],"confidence":0.92}', requests)
    });
    assert.equal(result.origin, "llm");
    assert.equal(result.topicId, "pm");
    assert.deepEqual(result.tags, ["产品冷启动", "用户验证"]);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].includes("产品-prompt.md"), false);
    assert.equal(requests[0].includes("内部提示词"), false);
  });

  it("falls back deterministically when the configured model returns invalid tags", async () => {
    const result = await generateListingTags({
      title: "AI 模型评测方法",
      summary: "比较不同模型的能力和评测指标。",
      files: [{ kind: "content", name: "content.md", sha256: "a", content: "模型评测指标。" }],
      llm: mockLlm('{"topic_id":"ai-eng","tags":["prompt","PPT"],"confidence":0.99}', [])
    });
    assert.equal(result.origin, "fallback");
    assert.equal(result.topicId, "ai-eng");
    assert.deepEqual(result.tags, ["AI模型研究"]);
  });
});
