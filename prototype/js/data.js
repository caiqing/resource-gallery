/* Mock catalog for high-fidelity prototype — not production data */
window.RG = window.RG || {};

RG.topics = [
  { id: "ai-eng", name: "AI 工程", desc: "模型、评测与落地系统", count: 4 },
  { id: "pm", name: "产品管理", desc: "路径、取舍与验证", count: 3 },
  { id: "biz", name: "商业模式", desc: "增长与交易结构", count: 2 },
  { id: "edu", name: "教育培训", desc: "课程与陪练资产", count: 2 },
  { id: "industry", name: "行业观察", desc: "趋势与案例拆解", count: 2 },
  { id: "growth", name: "个人成长", desc: "方法与复盘", count: 1 },
  { id: "design", name: "设计创意", desc: "系统与表达", count: 2 },
  { id: "other", name: "其他", desc: "尚未归类的精选", count: 1 }
];

RG.user = {
  name: "青木",
  role: "user",
  balance: 40,
  pendingEarnings: 0,
  likedIds: ["w2"],
  ownedIds: ["w1"]
};

RG.ledger = [
  { id: "l1", at: "2026-07-18 21:12", title: "获取《信息图叙事十法》", delta: -12, balance: 40 },
  { id: "l2", at: "2026-07-16 10:04", title: "运营赠送体验 credits", delta: +50, balance: 52 },
  { id: "l3", at: "2026-07-15 19:40", title: "获取《冷启动主题墙》", delta: -8, balance: 2 }
];

function coverSVG(seed, title, ratio) {
  const palettes = [
    ["#2F5D50", "#D7C4A3", "#1C1917"],
    ["#3F4A3C", "#E7D7C3", "#5C4033"],
    ["#4A5D73", "#E4E0D5", "#2C2A26"],
    ["#6B4F3A", "#F0E6D8", "#243028"],
    ["#355C5A", "#C9B8A0", "#1A1A1A"],
    ["#51483B", "#EFE7DA", "#2F5D50"]
  ];
  const p = palettes[seed % palettes.length];
  const w = ratio === "portrait" ? 900 : 1200;
  const h = ratio === "portrait" ? 1200 : 750;
  const safe = String(title).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${p[0]}"/>
      <stop offset="55%" stop-color="${p[1]}"/>
      <stop offset="100%" stop-color="${p[2]}"/>
    </linearGradient>
  </defs>
  <rect width="100%" height="100%" fill="url(#g)"/>
  <circle cx="${w * 0.78}" cy="${h * 0.22}" r="${Math.min(w, h) * 0.18}" fill="rgba(255,255,255,0.12)"/>
  <rect x="${w * 0.08}" y="${h * 0.72}" width="${w * 0.28}" height="8" rx="4" fill="rgba(255,255,255,0.45)"/>
  <rect x="${w * 0.08}" y="${h * 0.78}" width="${w * 0.48}" height="8" rx="4" fill="rgba(255,255,255,0.28)"/>
  <text x="${w * 0.08}" y="${h * 0.2}" fill="rgba(255,255,255,0.9)" font-size="${Math.round(w * 0.035)}" font-family="Georgia, serif">${safe.slice(0, 12)}</text>
</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

RG.works = [
  {
    id: "w1",
    title: "信息图叙事十法",
    summary: "把长文压缩成可扫读的一页结构，适合复盘与对外分享。",
    topic: "design",
    tags: ["信息图", "叙事", "结构"],
    price: 12,
    tier: "standard",
    likes: 186,
    downloads: 92,
    ratio: "portrait",
    versionLabel: "第 3 次生成",
    files: [
      { name: "infographic.png", kind: "infographic", included: true },
      { name: "slides.pdf", kind: "slide_pdf", included: true },
      { name: "content.md", kind: "content", included: true },
      { name: "blueprint.md", kind: "blueprint", included: true }
    ]
  },
  {
    id: "w2",
    title: "Agent 评测清单：从 Demo 到可上线",
    summary: "覆盖任务集、失败模式、回归与人工抽检的可执行清单。",
    topic: "ai-eng",
    tags: ["Agent", "评测", "上线"],
    price: 18,
    tier: "premium",
    likes: 240,
    downloads: 131,
    ratio: "landscape",
    versionLabel: "第 6 次生成",
    files: [
      { name: "deck.pdf", kind: "slide_pdf", included: true },
      { name: "checklist.md", kind: "content", included: true },
      { name: "prompt-pack.md", kind: "prompt", included: true }
    ]
  },
  {
    id: "w3",
    title: "冷启动主题墙怎么搭",
    summary: "用少量受控主题完成首屏策展，而不是标签海洋。",
    topic: "pm",
    tags: ["冷启动", "信息架构"],
    price: 0,
    tier: "free",
    likes: 97,
    downloads: 210,
    ratio: "landscape",
    versionLabel: "第 2 次生成",
    files: [
      { name: "overview.pdf", kind: "slide_pdf", included: true },
      { name: "ia-notes.md", kind: "content", included: true }
    ]
  },
  {
    id: "w4",
    title: "Credits 不是游戏币",
    summary: "站内价值单位的冷静设计：账本、分成快照与信任感交易。",
    topic: "biz",
    tags: ["Credits", "账本", "定价"],
    price: 12,
    tier: "standard",
    likes: 154,
    downloads: 77,
    ratio: "portrait",
    versionLabel: "第 4 次生成",
    files: [
      { name: "model.png", kind: "infographic", included: true },
      { name: "slides.pdf", kind: "slide_pdf", included: true }
    ]
  },
  {
    id: "w5",
    title: "21 天陪练：微动作编排",
    summary: "把成长目标拆成可完成的每日动作与反馈闭环。",
    topic: "edu",
    tags: ["陪练", "课程设计"],
    price: 8,
    tier: "standard",
    likes: 121,
    downloads: 64,
    ratio: "landscape",
    versionLabel: "第 5 次生成",
    files: [
      { name: "curriculum.pdf", kind: "slide_pdf", included: true },
      { name: "actions.md", kind: "content", included: true }
    ]
  },
  {
    id: "w6",
    title: "行业周报结构模板",
    summary: "固定栏目与证据层级，让观察稿可以持续生产。",
    topic: "industry",
    tags: ["周报", "模板"],
    price: 0,
    tier: "free",
    likes: 68,
    downloads: 143,
    ratio: "landscape",
    versionLabel: "第 1 次生成",
    files: [
      { name: "template.pdf", kind: "slide_pdf", included: true }
    ]
  },
  {
    id: "w7",
    title: "设计系统令牌分层",
    summary: "Gallery 与 Admin 双皮肤如何共享语义、分离气质。",
    topic: "design",
    tags: ["Design Token", "双皮肤"],
    price: 12,
    tier: "standard",
    likes: 88,
    downloads: 41,
    ratio: "portrait",
    versionLabel: "第 2 次生成",
    files: [
      { name: "tokens.png", kind: "infographic", included: true },
      { name: "guide.md", kind: "content", included: true }
    ]
  },
  {
    id: "w8",
    title: "运营导入 Runbook",
    summary: "从导出 zip 到上架的检查清单与失败回滚。",
    topic: "pm",
    tags: ["运营", "导入", "Runbook"],
    price: 8,
    tier: "standard",
    likes: 73,
    downloads: 55,
    ratio: "landscape",
    versionLabel: "第 3 次生成",
    files: [
      { name: "runbook.pdf", kind: "slide_pdf", included: true },
      { name: "checklist.md", kind: "content", included: true }
    ]
  }
].map((w, i) => ({
  ...w,
  cover: coverSVG(i, w.title, w.ratio),
  author: "Gallery 精选"
}));

RG.importJobs = [
  {
    id: "job_01",
    file: "ef0768__run_6f3a__v1.zip",
    status: "succeeded",
    note: "已生成草稿 w-draft-01",
    at: "2026-07-19 14:20"
  },
  {
    id: "job_02",
    file: "bad-path__run_x__v1.zip",
    status: "failed",
    note: "路径逃逸被拒",
    at: "2026-07-19 13:02"
  },
  {
    id: "job_03",
    file: "video-heavy__run_9__v1.zip",
    status: "succeeded",
    note: "已剥离 video；保留 4 个文件",
    at: "2026-07-19 11:48"
  }
];

RG.adminListings = [
  {
    id: "w-draft-01",
    title: "新导入：评测漏斗拆解",
    status: "draft",
    tier: "standard",
    tags: ["评测", "待确认"],
    files: [
      { name: "funnel.pdf", kind: "slide_pdf", included: true, locked: false },
      { name: "notes.md", kind: "content", included: true, locked: false },
      { name: "source.mp4", kind: "video", included: false, locked: true },
      { name: "cookies.txt", kind: "auth", included: false, locked: true }
    ]
  },
  {
    id: "w2",
    title: "Agent 评测清单：从 Demo 到可上线",
    status: "published",
    tier: "premium",
    tags: ["Agent", "评测"],
    files: []
  },
  {
    id: "w4",
    title: "Credits 不是游戏币",
    status: "published",
    tier: "standard",
    tags: ["Credits"],
    files: []
  },
  {
    id: "w6",
    title: "行业周报结构模板",
    status: "unlisted",
    tier: "free",
    tags: ["周报"],
    files: []
  }
];

RG.topicName = (id) => (RG.topics.find((t) => t.id === id) || {}).name || "其他";
RG.priceLabel = (n) => (n === 0 ? "免费" : `${n} credits`);
RG.getWork = (id) => RG.works.find((w) => w.id === id);
