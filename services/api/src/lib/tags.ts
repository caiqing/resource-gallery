const TOPIC_RULES: Array<{ topicId: string; patterns: RegExp[] }> = [
  { topicId: "ai-eng", patterns: [/agent/i, /llm/i, /模型/, /评测/, /rag/i, /prompt/i] },
  { topicId: "pm", patterns: [/产品/, /冷启动/, /roadmap/i, /需求/, /信息架构/] },
  { topicId: "biz", patterns: [/商业/, /credits/i, /定价/, /增长/, /模式/] },
  { topicId: "edu", patterns: [/教育/, /培训/, /陪练/, /课程/] },
  { topicId: "industry", patterns: [/行业/, /观察/, /周报/] },
  { topicId: "growth", patterns: [/成长/, /复盘/, /习惯/] },
  { topicId: "design", patterns: [/设计/, /信息图/, /视觉/, /token/i, /排版/] }
];

export function inferTopicAndTags(input: {
  title: string;
  summary?: string;
  filenames?: string[];
}): { topicId: string; tags: string[]; confidence: "high" | "low" } {
  const bag = [input.title, input.summary ?? "", ...(input.filenames ?? [])].join("\n");
  for (const rule of TOPIC_RULES) {
    if (rule.patterns.some((p) => p.test(bag))) {
      const tags = rule.patterns
        .filter((p) => p.test(bag))
        .slice(0, 3)
        .map((p) => p.source.replace(/\\/g, "").replace(/i$/, "").slice(0, 12));
      return {
        topicId: rule.topicId,
        tags: tags.length ? tags : [rule.topicId],
        confidence: "high"
      };
    }
  }
  return { topicId: "other", tags: ["待确认"], confidence: "low" };
}
