export const TOPIC_DEFINITIONS = [
  { id: "ai-eng", name: "AI 模型与研究", description: "模型能力、评测、安全与研究前沿" },
  { id: "ai-agent", name: "AI 智能体", description: "Agent、多智能体与工作流自动化" },
  { id: "biz", name: "创业与商业", description: "创业案例、商业模式与资本逻辑" },
  { id: "growth", name: "个人成长", description: "认知、习惯、关系与人生方法" },
  { id: "ai-dev", name: "AI 开发与工具", description: "AI 编程、开发工具与本地部署" },
  { id: "enterprise", name: "企业数字化", description: "企业 AI、业务系统与数字化转型" },
  { id: "pm", name: "产品与创新", description: "产品策略、用户需求与创新实践" },
  { id: "marketing", name: "营销与增长", description: "品牌、销售、电商与用户增长" },
  { id: "industry", name: "科技与趋势", description: "产业变化、科技前沿与市场观察" },
  { id: "career", name: "职场与管理", description: "职业发展、团队协作与组织管理" },
  { id: "edu", name: "教育与学习", description: "教育方法、学习策略与知识体系" },
  { id: "health", name: "健康与生活", description: "健身、营养、医疗与身心健康" },
  { id: "humanities", name: "历史与人文", description: "历史、文化、社会与人物故事" },
  { id: "design", name: "设计与创意", description: "视觉设计、审美与创意表达" },
  { id: "creator", name: "内容创作", description: "写作、视频、媒体与内容传播" },
  { id: "other", name: "其他", description: "暂未进入受控主题的内容" }
] as const;

export type TopicId = (typeof TOPIC_DEFINITIONS)[number]["id"];

export const TOPIC_IDS: readonly TopicId[] = TOPIC_DEFINITIONS.map((topic) => topic.id);

const TOPIC_ID_SET = new Set<string>(TOPIC_IDS);

export function isTopicId(value: string): value is TopicId {
  return TOPIC_ID_SET.has(value);
}

export function topicPromptCatalog(): string {
  return TOPIC_DEFINITIONS
    .map((topic) => `${topic.id}=${topic.name}（${topic.description}）`)
    .join("；");
}
