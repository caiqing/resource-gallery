import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/gallery.css";
import "./styles/admin.css";
import { api, coverUrl, priceLabel, type Listing, type User, type Account } from "./lib/api";

const appEl = document.getElementById("app")!;
const headerEl = document.getElementById("site-header")!;
const footerEl = document.getElementById("site-footer")!;

type State = {
  theme: string;
  user: User | null;
  account: Account | null;
  meTab: "owned" | "liked" | "ledger" | "profile";
  rankMetric: "likes" | "downloads";
  rankPeriod: "day" | "week" | "all";
  toastTimer?: number;
};

const state: State = {
  theme: localStorage.getItem("rg-theme") || "light",
  user: null,
  account: null,
  meTab: "owned",
  rankMetric: "likes",
  rankPeriod: "week"
};

document.documentElement.setAttribute("data-theme", state.theme);

function parseRoute() {
  const raw = location.hash.replace(/^#/, "") || "/";
  const [pathPart, queryPart = ""] = raw.split("?");
  const path = pathPart.startsWith("/") ? pathPart : `/${pathPart}`;
  const query = Object.fromEntries(new URLSearchParams(queryPart));
  const parts = path.split("/").filter(Boolean);
  return { path, parts, query };
}

function navigate(hash: string) {
  location.hash = hash.startsWith("#") ? hash.slice(1) : hash;
}

function toast(msg: string) {
  let el = document.querySelector(".toast") as HTMLDivElement | null;
  if (!el) {
    el = document.createElement("div");
    el.className = "toast";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  window.clearTimeout(state.toastTimer);
  state.toastTimer = window.setTimeout(() => el?.remove(), 2200);
}

function esc(s: unknown) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function workCard(w: Listing) {
  const chips = (w.tags || []).slice(0, 2).map((t) => `<span class="chip">${esc(t)}</span>`).join("");
  const more =
    (w.tags || []).length > 2
      ? `<span class="chip is-more">+${w.tags.length - 2}</span>`
      : "";
  const cover = coverUrl(w);
  return `
    <a class="work-card" href="#/work/${w.id}">
      <div class="cover-wrap" data-ratio="landscape">
        ${cover ? `<img class="cover-art" src="${cover}" alt="${esc(w.title)}封面" loading="lazy" />` : `<div class="cover-art" style="background:var(--surface-2)"></div>`}
      </div>
      <div class="card-body">
        <h3 class="card-title">${esc(w.title)}</h3>
        <p class="card-summary">${esc(w.summary)}</p>
        <div class="card-meta">
          <div class="chips">${chips}${more}</div>
          <div class="price num">${esc(priceLabel(w.price_credits))}</div>
        </div>
      </div>
    </a>`;
}

function empty(text: string, actionLabel?: string, href?: string) {
  return `<div class="empty-state"><h3>暂无内容</h3><p>${esc(text)}</p>${
    actionLabel && href ? `<a class="btn btn-ghost" href="${href}">${esc(actionLabel)}</a>` : ""
  }</div>`;
}

function pager(
  pagination: { page: number; pages: number; total: number },
  hrefForPage: (page: number) => string
) {
  if (pagination.pages <= 1) return "";
  return `<nav class="pager" aria-label="分页">
    <a class="btn btn-ghost btn-sm ${pagination.page <= 1 ? "is-disabled" : ""}" href="${
      pagination.page > 1 ? hrefForPage(pagination.page - 1) : "#"
    }" aria-disabled="${pagination.page <= 1}">上一页</a>
    <span>第 ${pagination.page} / ${pagination.pages} 页 · 共 ${pagination.total} 项</span>
    <a class="btn btn-ghost btn-sm ${pagination.page >= pagination.pages ? "is-disabled" : ""}" href="${
      pagination.page < pagination.pages ? hrefForPage(pagination.page + 1) : "#"
    }" aria-disabled="${pagination.page >= pagination.pages}">下一页</a>
  </nav>`;
}

async function refreshSession() {
  try {
    const me = await api.me();
    state.user = me.user;
    state.account = me.account;
  } catch {
    state.user = null;
    state.account = null;
  }
}

function renderHeader(route: ReturnType<typeof parseRoute>) {
  const admin = route.parts[0] === "admin";
  document.body.classList.toggle("is-admin", admin);
  document.body.classList.toggle("admin-shell", admin);
  const who = state.user?.display_name ?? "登录";
  if (admin) {
    headerEl.innerHTML = `
      <a class="brand" href="#/admin"><span class="brand-mark"></span><span class="brand-name">RG Admin</span><span class="brand-sub">Utility</span></a>
      <nav class="nav-links">
        <a href="#/admin" class="${route.path === "/admin" ? "is-active" : ""}">总览</a>
        <a href="#/admin/import" class="${route.path.includes("/import") ? "is-active" : ""}">导入</a>
        <a href="#/admin/listings" class="${route.path.includes("/listings") ? "is-active" : ""}">上架</a>
      </nav>
      <div class="header-actions">
        <button class="icon-btn" type="button" data-theme aria-label="${state.theme === "light" ? "切换到深色主题" : "切换到浅色主题"}" title="${state.theme === "light" ? "深色主题" : "浅色主题"}">${state.theme === "light" ? "☾" : "☀"}</button>
        <a class="btn btn-ghost btn-sm" href="#/">返回画廊</a>
      </div>`;
  } else {
    headerEl.innerHTML = `
      <a class="brand" href="#/"><span class="brand-mark"></span><span class="brand-name">Resource Gallery</span><span class="brand-sub">Editorial</span></a>
      <nav class="nav-links">
        <a href="#/" class="${route.path === "/" ? "is-active" : ""}">探索</a>
        <a href="#/topics" class="${route.path.startsWith("/topics") ? "is-active" : ""}">主题</a>
        <a href="#/rank" class="${route.path.startsWith("/rank") ? "is-active" : ""}">排行</a>
        <a href="#/search" class="${route.path.startsWith("/search") ? "is-active" : ""}">搜索</a>
      </nav>
      <div class="header-actions">
        <button class="icon-btn" type="button" data-theme aria-label="${state.theme === "light" ? "切换到深色主题" : "切换到浅色主题"}" title="${state.theme === "light" ? "深色主题" : "浅色主题"}">${state.theme === "light" ? "☾" : "☀"}</button>
        <a class="btn btn-ghost btn-sm" href="#/me">${esc(who)}</a>
        ${state.user?.role === "admin" ? `<a class="btn btn-quiet btn-sm" href="#/admin">运营</a>` : ""}
      </div>`;
  }
  footerEl.innerHTML = admin
    ? `<div class="container"><span>Admin Utility · 一期无 C 端发布</span><span>与 Video2PPT 分仓分部署</span></div>`
    : `<div class="container"><span>Resource Gallery · 精选知识资产画廊</span><span><a href="#/terms">用户协议</a> · <a href="#/copyright">侵权下架</a> · Generated with Video2PPT（弱关联）</span></div>`;
}

async function pageHome() {
  const { listings } = await api.listings();
  const { topics } = await api.topics();
  return `
    <div class="container page">
      <section class="hero">
        <div class="hero-kicker">Editorial Gallery</div>
        <h1>把一次优质生成，陈列成可复用的知识资产</h1>
        <p class="hero-lead">浏览主题化的演示文稿、信息图与结构化文稿。Credits 只是安静的获取方式。</p>
        <form class="search-bar" data-search>
          <input name="q" placeholder="搜索标题、标签或主题…" />
          <button class="btn btn-primary btn-sm" type="submit">搜索</button>
        </form>
      </section>
      <div class="section-head"><div><h2>主题墙</h2><p>受控主题，少而准</p></div><a class="btn btn-quiet" href="#/topics">全部主题</a></div>
      <div class="topic-grid">
        ${topics.slice(0, 4).map((t) => `
          <a class="topic-card" href="#/topics/${t.id}"><h3>${esc(t.name)}</h3><p>${esc(t.description)}</p></a>
        `).join("")}
      </div>
      <div class="section-head"><div><h2>精选</h2><p>封面优先的作品网格</p></div><a class="btn btn-quiet" href="#/rank">查看榜单</a></div>
      ${listings.length ? `<div class="work-grid">${listings.map(workCard).join("")}</div>` : empty("还没有已发布作品。运营可在后台导入上架。", "运营台", "#/admin")}
    </div>`;
}

async function pageTopics(id?: string, page = 1) {
  const { topics } = await api.topics();
  if (!id) {
    return `<div class="container page">
      <div class="section-head"><div><h2>主题墙</h2><p>一级受控主题</p></div></div>
      <div class="topic-grid">${topics.map((t) => `
        <a class="topic-card" href="#/topics/${t.id}"><h3>${esc(t.name)}</h3><p>${esc(t.description)}</p></a>
      `).join("")}</div></div>`;
  }
  const topic = topics.find((t) => t.id === id);
  const { listings, pagination } = await api.listings({ topic: id, page });
  return `<div class="container page">
    <div class="section-head"><div><h2>${esc(topic?.name || id)}</h2><p>${esc(topic?.description || "")}</p></div>
      <a class="btn btn-ghost btn-sm" href="#/topics">全部主题</a></div>
    ${listings.length ? `<div class="work-grid">${listings.map(workCard).join("")}</div>${pager(pagination, (next) => `#/topics/${encodeURIComponent(id)}?page=${next}`)}` : empty("该主题暂无作品")}
  </div>`;
}

async function pageSearch(q: string, page = 1) {
  const result = q ? await api.listings({ q, page }) : null;
  const listings = result?.listings ?? [];
  return `<div class="container page">
    <div class="section-head"><div><h2>搜索</h2><p>标题、摘要、标签</p></div></div>
    <form class="search-bar" data-search style="margin-bottom:24px">
      <input name="q" value="${esc(q)}" placeholder="试试关键词" />
      <button class="btn btn-primary btn-sm" type="submit">搜索</button>
    </form>
    ${!q ? empty("输入关键词开始定位作品") : listings.length ? `<div class="work-grid">${listings.map(workCard).join("")}</div>${pager(result!.pagination, (next) => `#/search?q=${encodeURIComponent(q)}&page=${next}`)}` : empty("没有匹配结果", "回首页", "#/")}
  </div>`;
}

async function pageRank() {
  const { items } = await api.rank(state.rankMetric, state.rankPeriod);
  return `<div class="container page">
    <div class="section-head">
      <div><h2>榜单</h2><p>杂志感排序</p></div>
      <div class="rank-tabs">
        <button type="button" data-rank="likes" class="${state.rankMetric === "likes" ? "is-active" : ""}">点赞</button>
        <button type="button" data-rank="downloads" class="${state.rankMetric === "downloads" ? "is-active" : ""}">下载</button>
      </div>
    </div>
    <div class="seg-tabs" aria-label="榜单周期">
      ${(["day", "week", "all"] as const).map((period) => `<button type="button" data-rank-period="${period}" class="${state.rankPeriod === period ? "is-active" : ""}">${period === "day" ? "日榜" : period === "week" ? "周榜" : "总榜"}</button>`).join("")}
    </div>
    <div class="rank-list">
      ${items.map((w: any, i: number) => `
        <a class="rank-item" href="#/work/${w.id}">
          <div class="rank-no num">${String(i + 1).padStart(2, "0")}</div>
          <div class="rank-thumb">${w.cover_path ? `<img class="cover-art" src="/api/downloads/${w.id}/cover" alt="${esc(w.title)}封面" loading="lazy" />` : ""}</div>
          <div><h3 class="rank-title">${esc(w.title)}</h3><p class="rank-meta">${esc(w.author_name || "")}</p></div>
          <div class="price num">${w.rank_count} ${state.rankMetric === "likes" ? "赞" : "次"}</div>
        </a>`).join("")}
    </div>
  </div>`;
}

async function pageDetail(id: string, checkout = false) {
  const { listing, files } = await api.listing(id);
  const balance = state.account?.balance ?? 0;
  let owned = false;
  if (state.user) {
    try {
      const ents = await api.entitlements();
      owned = ents.entitlements.some((e: any) => e.listing_id === id) || listing.price_credits === 0;
    } catch {
      owned = listing.price_credits === 0;
    }
  } else {
    owned = false;
  }
  const primary = owned
    ? `<button class="btn btn-primary btn-block" type="button" data-download="${listing.id}">下载</button>`
    : `<button class="btn btn-primary btn-block" type="button" data-open-checkout="${listing.id}">使用 ${listing.price_credits} credits 获取</button>`;

  const sheet =
    checkout && !owned && listing.price_credits > 0
      ? `<div class="sheet-backdrop" data-close-checkout>
          <div class="sheet" role="dialog" aria-modal="true">
            <h2>确认获取</h2>
            <p style="margin:0;color:var(--muted)">一次确认，冷静交易</p>
            <div class="sheet-row"><span>作品</span><strong>${esc(listing.title)}</strong></div>
            <div class="sheet-row"><span>价格</span><strong class="num">${listing.price_credits} credits</strong></div>
            <div class="sheet-row"><span>余额</span><strong class="num">${balance} → ${balance - listing.price_credits}</strong></div>
            <div class="buy-actions">
              <button class="btn btn-primary" type="button" data-checkout="${listing.id}">确认支付</button>
              <button class="btn btn-ghost" type="button" data-close-checkout>取消</button>
            </div>
          </div>
        </div>`
      : "";

  return `<div class="container page">
    <div class="detail-layout">
      <section class="preview-stage">
        ${listing.cover_path ? `<img class="cover-art" src="${coverUrl(listing)}" alt="" />` : ""}
        <div class="preview-caption"><span>未购可预览封面与摘要</span></div>
      </section>
      <aside class="buy-rail">
        <div class="chips">${(listing.tags || []).map((t) => `<span class="chip">${esc(t)}</span>`).join("")}</div>
        <h1>${esc(listing.title)}</h1>
        <p class="buy-summary">${esc(listing.summary)}</p>
        <div class="buy-price">
          <div><div style="color:var(--muted);font-size:0.82rem">价格</div><div class="amount num">${esc(priceLabel(listing.price_credits))}</div></div>
          <div style="text-align:right;color:var(--muted);font-size:0.85rem">
            <div>余额 <span class="num">${balance}</span></div>
            <div>${listing.like_count} 赞 · ${listing.download_count} 次获取</div>
          </div>
        </div>
        <div class="buy-actions">
          ${primary}
          <div class="buy-secondary">
            <button class="btn btn-ghost" type="button" data-like="${listing.id}">点赞</button>
            <button class="btn btn-ghost" type="button" data-share="${listing.id}">分享</button>
          </div>
        </div>
        <ul class="file-list">
          ${files.map((f: any) => `<li><span>${esc(f.filename)}</span><span class="kind">${esc(f.kind)}</span></li>`).join("")}
        </ul>
        <div class="source-note">作者 ${esc(listing.author_name || "")} · Generated with Video2PPT · <a href="#/copyright">授权与下架说明</a></div>
        ${state.user ? `<details class="report-disclosure"><summary>举报此资源</summary>
          <form class="report-form" data-report="${listing.id}">
            <select name="reason" aria-label="举报原因"><option value="copyright">版权或授权</option><option value="unsafe">不安全内容</option><option value="misleading">误导信息</option><option value="other">其他</option></select>
            <textarea name="detail" maxlength="1000" placeholder="补充说明" required></textarea>
            <button class="btn btn-ghost btn-sm" type="submit">提交举报</button>
          </form></details>` : ""}
      </aside>
    </div>
  </div>${sheet}`;
}

async function pageMe() {
  if (!state.user) {
    return `<div class="container page">
      <div class="panel" style="max-width:420px;margin:40px auto">
        <h2>登录 / 注册</h2>
        <form data-auth style="display:grid;gap:12px">
          <label>邮箱<input name="email" type="email" required placeholder="user@gallery.local" style="width:100%;padding:10px;border-radius:8px;border:1px solid var(--line);background:var(--surface)" /></label>
          <label>密码<input name="password" type="password" required minlength="8" style="width:100%;padding:10px;border-radius:8px;border:1px solid var(--line);background:var(--surface)" /></label>
          <div style="display:flex;gap:8px">
            <button class="btn btn-primary" name="mode" value="login" type="submit">登录</button>
            <button class="btn btn-ghost" name="mode" value="register" type="submit">注册</button>
          </div>
          <p class="source-note">注册即表示同意<a href="#/terms">用户协议</a>与<a href="#/copyright">侵权下架规则</a>。</p>
        </form>
      </div>
    </div>`;
  }
  let body = "";
  if (state.meTab === "owned") {
    const { entitlements } = await api.entitlements();
    body = entitlements.length
      ? `<div class="work-grid">${entitlements
          .map(
            (e: any) =>
              workCard({
                id: e.listing_id,
                title: e.title,
                summary: "",
                cover_path: e.cover_path,
                price_tier: "standard",
                price_credits: e.price_credits,
                status: "published",
                like_count: 0,
                download_count: 0,
                tags: []
              })
          )
          .join("")}</div>`
      : empty("还没有已获取作品", "去探索", "#/");
  } else if (state.meTab === "liked") {
    const { likes } = await api.likes();
    body = likes.length
      ? `<div class="work-grid">${likes
          .map(
            (w: any) =>
              workCard({
                id: w.id,
                title: w.title,
                summary: w.summary,
                cover_path: w.cover_path,
                price_tier: "standard",
                price_credits: w.price_credits,
                status: "published",
                like_count: w.like_count,
                download_count: 0,
                tags: []
              })
          )
          .join("")}</div>`
      : empty("还没有点赞");
  } else if (state.meTab === "ledger") {
    const { entries } = await api.ledger();
    body = `<table class="ledger-table"><thead><tr><th>时间</th><th>说明</th><th>变动</th><th>余额</th></tr></thead><tbody>
      ${entries
        .map(
          (r: any) =>
            `<tr><td class="num">${esc(r.created_at)}</td><td>${esc(r.note)}</td><td class="num">${r.amount > 0 ? "+" : ""}${r.amount}</td><td class="num">${r.balance_after}</td></tr>`
        )
        .join("")}
    </tbody></table>
    <p class="source-note" style="margin-top:12px">pending_earnings（作者应收）= ${state.account?.pending_earnings ?? 0} · 暂不可兑现</p>`;
  } else {
    body = `<form class="admin-form profile-form" data-profile>
      <label>邮箱<input value="${esc(state.user.email)}" disabled /></label>
      <label>昵称<input name="display_name" value="${esc(state.user.display_name)}" maxlength="60" required /></label>
      <button class="btn btn-primary" type="submit">保存资料</button>
    </form>`;
  }
  return `<div class="container page"><div class="me-layout">
    <aside class="me-side">
      <div>
        <div style="font-family:var(--font-display);font-size:1.2rem;font-weight:600">${esc(state.user.display_name)}</div>
        <div style="color:var(--muted);font-size:0.88rem">${state.user.role === "admin" ? "管理员" : "注册用户 · 无发布权限"}</div>
      </div>
      <div class="balance-card"><div class="label">可用余额</div><div class="value num">${state.account?.balance ?? 0}</div><div class="label" style="margin-top:8px">credits</div></div>
      <nav class="me-nav">
        <button type="button" data-me-tab="owned" class="${state.meTab === "owned" ? "is-active" : ""}">已购</button>
        <button type="button" data-me-tab="liked" class="${state.meTab === "liked" ? "is-active" : ""}">点赞</button>
        <button type="button" data-me-tab="ledger" class="${state.meTab === "ledger" ? "is-active" : ""}">流水</button>
        <button type="button" data-me-tab="profile" class="${state.meTab === "profile" ? "is-active" : ""}">资料</button>
      </nav>
      <button class="btn btn-ghost btn-sm" type="button" data-logout>退出登录</button>
    </aside>
    <section class="panel"><h2>${state.meTab === "owned" ? "已购" : state.meTab === "liked" ? "点赞" : state.meTab === "ledger" ? "流水" : "资料"}</h2>${body}</section>
  </div></div>`;
}

async function pageShare(slug: string) {
  const { share } = await api.shareGet(slug);
  return `<div class="container page">
    <div class="section-head"><div><h2>分享预览</h2><p>未登录可看摘要与封面</p></div>
      <a class="btn btn-ghost btn-sm" href="#/work/${share.listing_id}">查看详情</a></div>
    <article class="share-card">
      ${share.cover_path ? `<img class="cover-art" src="/api/downloads/${share.listing_id}/cover" alt="" />` : ""}
      <div class="share-body">
        <div class="hero-kicker">Resource Gallery</div>
        <h1>${esc(share.title)}</h1>
        <p style="margin:0;color:var(--muted)">${esc(share.summary)}</p>
        <div class="price num">${esc(priceLabel(share.price_credits))}</div>
      </div>
    </article>
  </div>`;
}

function adminNav(active: string) {
  return `<nav class="admin-nav">
    <a href="#/admin" class="${active === "home" ? "is-active" : ""}">总览</a>
    <a href="#/admin/import" class="${active === "import" ? "is-active" : ""}">导入 Job</a>
    <a href="#/admin/listings" class="${active === "listings" ? "is-active" : ""}">Listing 策展</a>
    <a href="#/admin/grant" class="${active === "grant" ? "is-active" : ""}">调账赠送</a>
    <a href="#/admin/governance" class="${active === "governance" ? "is-active" : ""}">用户与治理</a>
    <a href="#/admin/config" class="${active === "config" ? "is-active" : ""}">交易配置</a>
    <a href="#/">← C 端画廊</a>
  </nav>`;
}

async function pageAdminHome() {
  if (state.user?.role !== "admin") return `<div class="container page">${empty("需要管理员登录", "去登录", "#/me")}</div>`;
  const o = await api.adminOverview();
  return `<div class="admin-layout">${adminNav("home")}<div class="admin-main">
    <div class="kpi-row">
      <div class="kpi"><div class="label">已发布</div><div class="value">${o.published}</div></div>
      <div class="kpi"><div class="label">草稿</div><div class="value">${o.draft}</div></div>
      <div class="kpi"><div class="label">导入 Job</div><div class="value">${o.import_jobs}</div></div>
      <div class="kpi"><div class="label">用户</div><div class="value">${o.users}</div></div>
      <div class="kpi"><div class="label">待处理举报</div><div class="value">${o.open_reports}</div></div>
      <div class="kpi"><div class="label">失败导入</div><div class="value">${o.failed_imports}</div></div>
    </div>
    <section class="admin-card">
      <h1>运营台</h1>
      <p class="lead">Utility 皮肤。一期仅运营导入，C 端无发布入口。</p>
      <div class="admin-actions">
        <a class="btn-admin" href="#/admin/import">导入导出包</a>
        <a class="btn-admin-ghost" href="#/admin/listings">管理 Listing</a>
      </div>
    </section>
  </div></div>`;
}

async function pageAdminImport() {
  if (state.user?.role !== "admin") return `<div class="container page">${empty("需要管理员登录", "去登录", "#/me")}</div>`;
  const { jobs } = await api.adminJobs();
  return `<div class="admin-layout">${adminNav("import")}<div class="admin-main">
    <section class="admin-card">
      <h1>导入 resource-gallery.export/v1</h1>
      <p class="lead">仅管理员。自动剥离 video/auth；失败不留下 published 半成品。</p>
      <label class="dropzone">
        <strong>选择 zip 上传</strong>
        <span>manifest.json + task_meta.json + run_meta.json + files/</span>
        <input type="file" accept=".zip" data-import-file hidden />
      </label>
      <div class="job-list">
        ${jobs
          .map(
            (j: any) => `<div class="job-item">
            <div><div>${esc(j.filename)}</div><div style="color:var(--admin-muted);font-size:0.82rem">${esc(j.message)} · ${esc(j.created_at)}</div></div>
            <span class="badge ${j.status === "succeeded" ? "ok" : j.status === "failed" ? "danger" : "warn"}">${esc(j.status)}</span>
            ${j.listing_id ? `<a class="btn-admin-ghost" href="#/admin/listings/${j.listing_id}">策展</a>` : "<span></span>"}
          </div>`
          )
          .join("")}
      </div>
    </section>
  </div></div>`;
}

async function pageAdminListings(id?: string) {
  if (state.user?.role !== "admin") return `<div class="container page">${empty("需要管理员登录", "去登录", "#/me")}</div>`;
  if (!id) {
    const { listings } = await api.adminListings();
    return `<div class="admin-layout">${adminNav("listings")}<div class="admin-main">
      <section class="admin-card"><h1>Listing</h1>
        <table class="admin-table"><thead><tr><th>标题</th><th>状态</th><th>档位</th><th>来源</th><th></th></tr></thead>
        <tbody>${listings
          .map(
            (l: any) => `<tr>
            <td>${esc(l.title)}</td><td><span class="badge ${l.status === "published" ? "ok" : "warn"}">${esc(l.status)}</span></td>
            <td>${esc(l.price_tier)} / ${l.price_credits}</td>
            <td class="num" style="font-size:0.8rem">${esc(l.source_task_id || "")}</td>
            <td><a href="#/admin/listings/${l.id}">打开</a></td>
          </tr>`
          )
          .join("")}</tbody></table>
      </section></div></div>`;
  }
  const data = await api.adminListing(id);
  const l = data.listing;
  const tags = (data.tags || []).map((t: any) => t.tag).join(", ");
  return `<div class="admin-layout">${adminNav("listings")}<div class="admin-main">
    <section class="admin-card">
      <h1>策展 · ${esc(l.title)}</h1>
      <form class="admin-form" data-curate="${l.id}">
        <label>标题<input name="title" value="${esc(l.title)}" /></label>
        <label>摘要<textarea name="summary">${esc(l.summary)}</textarea></label>
        <label>价格档位
          <select name="price_tier">
            ${["free", "standard", "premium"]
              .map((t) => `<option value="${t}" ${l.price_tier === t ? "selected" : ""}>${t}</option>`)
              .join("")}
          </select>
        </label>
        <label>标签<input name="tags" value="${esc(tags)}" /></label>
        <div class="file-check">
          ${(data.files || [])
            .map(
              (f: any) => `<label class="${f.stripped ? "is-locked" : ""}">
              <input type="checkbox" name="file" value="${f.id}" ${f.included && !f.stripped ? "checked" : ""} ${f.stripped ? "disabled" : ""} />
              <span>${esc(f.filename)} <span class="badge">${esc(f.kind)}</span> ${f.stripped ? "已剥离" : ""}</span>
            </label>`
            )
            .join("")}
        </div>
        <div class="admin-actions">
          <button class="btn-admin" type="submit">保存</button>
          <button class="btn-admin" type="button" data-publish="${l.id}">发布</button>
          <button class="btn-admin-ghost" type="button" data-status="taken_down">下架</button>
          <a class="btn-admin-ghost" href="#/admin/listings">返回</a>
        </div>
      </form>
    </section>
  </div></div>`;
}

async function pageAdminGrant() {
  if (state.user?.role !== "admin") return `<div class="container page">${empty("需要管理员登录", "去登录", "#/me")}</div>`;
  return `<div class="admin-layout">${adminNav("grant")}<div class="admin-main">
    <section class="admin-card">
      <h1>Credits 调账 / 赠送</h1>
      <p class="lead">写入不可变流水与审计日志。</p>
      <form class="admin-form" data-grant>
        <label>用户邮箱<input name="email" value="user@gallery.local" /></label>
        <label>数量（可为负）<input name="amount" type="number" value="50" /></label>
        <label>备注<input name="note" value="运营赠送" /></label>
        <button class="btn-admin" type="submit">提交</button>
      </form>
    </section>
  </div></div>`;
}

async function pageAdminGovernance() {
  if (state.user?.role !== "admin") return `<div class="container page">${empty("需要管理员登录", "去登录", "#/me")}</div>`;
  const [{ users }, { reports }, { logs }] = await Promise.all([
    api.adminUsers(),
    api.adminReports("all"),
    api.adminAudits()
  ]);
  return `<div class="admin-layout">${adminNav("governance")}<div class="admin-main">
    <section class="admin-card"><h1>举报与下架</h1><p class="lead">处理结果与下架动作写入审计日志；已购权益保留。</p>
      <div class="admin-table-wrap"><table class="admin-table"><thead><tr><th>资源</th><th>举报人</th><th>原因</th><th>状态</th><th>操作</th></tr></thead><tbody>
      ${reports.map((report: any) => `<tr><td>${esc(report.listing_title)}</td><td>${esc(report.reporter_email)}</td><td>${esc(report.reason)}<br><span class="muted-cell">${esc(report.detail)}</span></td><td><span class="badge ${report.status === "open" ? "warn" : "ok"}">${esc(report.status)}</span></td><td>${report.status === "open" ? `<div class="admin-actions"><button class="btn-admin-ghost" data-resolve-report="${report.id}" data-take-down="false">驳回</button><button class="btn-admin" data-resolve-report="${report.id}" data-take-down="true">下架并结案</button></div>` : esc(report.resolution)}</td></tr>`).join("")}
      </tbody></table></div>
    </section>
    <section class="admin-card"><h2>用户</h2><div class="admin-table-wrap"><table class="admin-table"><thead><tr><th>用户</th><th>角色</th><th>余额</th><th>作者应收</th><th>订单</th></tr></thead><tbody>
      ${users.map((user: any) => `<tr><td>${esc(user.display_name)}<br><span class="muted-cell">${esc(user.email)}</span></td><td>${esc(user.role)}</td><td class="num">${user.balance}</td><td class="num">${user.pending_earnings}</td><td class="num">${user.order_count}</td></tr>`).join("")}
    </tbody></table></div></section>
    <section class="admin-card"><h2>最近审计</h2><div class="admin-table-wrap"><table class="admin-table"><thead><tr><th>时间</th><th>操作人</th><th>动作</th><th>目标</th></tr></thead><tbody>
      ${logs.slice(0, 50).map((log: any) => `<tr><td class="num">${esc(log.created_at)}</td><td>${esc(log.actor_email || "system")}</td><td>${esc(log.action)}</td><td>${esc(log.target_type)} / ${esc(log.target_id || "")}</td></tr>`).join("")}
    </tbody></table></div></section>
  </div></div>`;
}

async function pageAdminConfig() {
  if (state.user?.role !== "admin") return `<div class="container page">${empty("需要管理员登录", "去登录", "#/me")}</div>`;
  const [{ tiers }, { configs }] = await Promise.all([
    api.adminPriceTiers(),
    api.adminRevenueShares()
  ]);
  return `<div class="admin-layout">${adminNav("config")}<div class="admin-main">
    <section class="admin-card"><h1>统一定价档位</h1><p class="lead">更新档位只影响后续保存到 Listing 的价格，不改历史订单。</p>
      <div class="config-grid">${tiers.map((tier: any) => `<form class="admin-form" data-price-tier="${tier.id}"><label>档位<input value="${esc(tier.id)}" disabled /></label><label>显示名<input name="label" value="${esc(tier.label)}" required /></label><label>Credits<input name="credits" type="number" min="0" value="${tier.credits}" required /></label><button class="btn-admin" type="submit">保存</button></form>`).join("")}</div>
    </section>
    <section class="admin-card"><h2>分成版本</h2><p class="lead">新订单使用最新版本，历史 Order 快照不变。</p>
      <form class="admin-form inline-admin-form" data-revenue-share><label>作者 bps<input name="author" type="number" min="0" max="10000" value="7000" required /></label><label>平台 bps<input name="platform" type="number" min="0" max="10000" value="3000" required /></label><button class="btn-admin" type="submit">创建新版本</button></form>
      <div class="admin-table-wrap"><table class="admin-table"><thead><tr><th>版本</th><th>作者</th><th>平台</th><th>生效时间</th></tr></thead><tbody>${configs.map((config: any) => `<tr><td>v${config.version}</td><td class="num">${config.author_share_bps}</td><td class="num">${config.platform_share_bps}</td><td class="num">${esc(config.effective_at)}</td></tr>`).join("")}</tbody></table></div>
    </section>
  </div></div>`;
}

function pageTerms(kind: "terms" | "copyright") {
  if (kind === "terms") {
    return `<div class="container page legal-page"><h1>用户协议</h1><p>本站分发运营审核后的知识资产导出包。注册用户仅可在授权范围内浏览、点赞与下载，不得绕过权限、转售认证材料或利用本站传播违法内容。</p><h2>Credits</h2><p>Credits 是站内获取额度，不对应法币，不支持提现。订单与账户变动记录在不可变流水中。</p><h2>内容边界</h2><p>一期仅由运营导入与上架，注册用户没有发布入口。资源来源说明不代表来源平台对衍生内容背书。</p></div>`;
  }
  return `<div class="container page legal-page"><h1>授权与侵权下架</h1><p>导入包默认剥离源视频、cookies 与认证材料。运营发布前需确认内容授权范围和可分发文件清单。</p><h2>提交举报</h2><p>登录后可在资源详情提交版权、危险内容或误导信息举报。运营会记录处理结果，并可将资源下架；既有购买权益按一期策略保留。</p><h2>必要信息</h2><p>举报说明应包含资源名称、权利基础、争议范围及可联系信息。请勿在说明中提交账号密码、cookies 或其他认证材料。</p></div>`;
}

async function render() {
  const route = parseRoute();
  renderHeader(route);
  appEl.innerHTML = `<div class="container page"><p style="color:var(--muted)">加载中…</p></div>`;
  try {
    let html = "";
    const p = route.parts;
    if (p[0] === "admin") {
      if (p[1] === "import") html = await pageAdminImport();
      else if (p[1] === "listings") html = await pageAdminListings(p[2]);
      else if (p[1] === "grant") html = await pageAdminGrant();
      else if (p[1] === "governance") html = await pageAdminGovernance();
      else if (p[1] === "config") html = await pageAdminConfig();
      else html = await pageAdminHome();
    } else if (p[0] === "topics") html = await pageTopics(p[1], Number(route.query.page) || 1);
    else if (p[0] === "search") html = await pageSearch(route.query.q || "", Number(route.query.page) || 1);
    else if (p[0] === "rank") html = await pageRank();
    else if (p[0] === "work" && p[2] === "checkout") html = await pageDetail(p[1], true);
    else if (p[0] === "work") html = await pageDetail(p[1]);
    else if (p[0] === "share") html = await pageShare(p[1]);
    else if (p[0] === "me") html = await pageMe();
    else if (p[0] === "terms") html = pageTerms("terms");
    else if (p[0] === "copyright") html = pageTerms("copyright");
    else html = await pageHome();
    appEl.innerHTML = html;
    bind();
  } catch (e) {
    appEl.innerHTML = `<div class="container page">${empty(e instanceof Error ? e.message : "加载失败")}</div>`;
    bind();
  }
}

function bind() {
  document.querySelectorAll("button[data-theme]").forEach((el) =>
    el.addEventListener("click", () => {
      state.theme = state.theme === "light" ? "dark" : "light";
      localStorage.setItem("rg-theme", state.theme);
      document.documentElement.setAttribute("data-theme", state.theme);
      render();
    })
  );

  document.querySelectorAll("form[data-search]").forEach((form) => {
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const q = new FormData(form as HTMLFormElement).get("q") || "";
      navigate(`/search?q=${encodeURIComponent(String(q))}`);
    });
  });

  document.querySelectorAll("[data-rank]").forEach((btn) =>
    btn.addEventListener("click", () => {
      state.rankMetric = (btn.getAttribute("data-rank") as any) || "likes";
      render();
    })
  );

  document.querySelectorAll("[data-rank-period]").forEach((btn) =>
    btn.addEventListener("click", () => {
      state.rankPeriod = (btn.getAttribute("data-rank-period") as State["rankPeriod"]) || "week";
      render();
    })
  );

  document.querySelectorAll("[data-like]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      if (!state.user) return toast("请先登录");
      try {
        const r = await api.toggleLike(btn.getAttribute("data-like")!);
        toast(r.liked ? "已点赞" : "已取消点赞");
        render();
      } catch (e) {
        toast(e instanceof Error ? e.message : "失败");
      }
    })
  );

  document.querySelectorAll("[data-open-checkout]").forEach((btn) =>
    btn.addEventListener("click", () => {
      if (!state.user) {
        toast("请先登录");
        navigate("/me");
        return;
      }
      navigate(`/work/${btn.getAttribute("data-open-checkout")}/checkout`);
    })
  );

  document.querySelectorAll("[data-checkout]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      try {
        const r = await api.checkout(btn.getAttribute("data-checkout")!);
        await refreshSession();
        toast(r.alreadyOwned ? "已拥有" : r.free ? "已获取" : `已支付 ${r.price} credits`);
        navigate(`/work/${btn.getAttribute("data-checkout")}`);
      } catch (e) {
        toast(e instanceof Error ? e.message : "支付失败");
      }
    })
  );

  document.querySelectorAll("[data-close-checkout]").forEach((el) =>
    el.addEventListener("click", (e) => {
      if (e.target === el) {
        const id = parseRoute().parts[1];
        navigate(`/work/${id}`);
      }
    })
  );

  document.querySelectorAll("[data-download]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      try {
        const r = await api.downloadToken(btn.getAttribute("data-download")!);
        window.open(r.url, "_blank");
      } catch (e) {
        toast(e instanceof Error ? e.message : "下载失败");
      }
    })
  );

  document.querySelectorAll("[data-share]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      if (!state.user) return toast("请先登录");
      try {
        const r = await api.share(btn.getAttribute("data-share")!);
        navigator.clipboard?.writeText(`${location.origin}${r.public_path}`).catch(() => undefined);
        toast("公开链接已生成");
        navigate(r.path);
      } catch (e) {
        toast(e instanceof Error ? e.message : "分享失败");
      }
    })
  );

  document.querySelectorAll("[data-me-tab]").forEach((btn) =>
    btn.addEventListener("click", () => {
      state.meTab = btn.getAttribute("data-me-tab") as any;
      render();
    })
  );

  document.querySelectorAll("[data-logout]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      await api.logout();
      await refreshSession();
      toast("已退出");
      render();
    })
  );

  document.querySelectorAll("form[data-auth]").forEach((form) => {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const submitter = (e as SubmitEvent).submitter as HTMLButtonElement | null;
      const mode = submitter?.value || "login";
      const fd = new FormData(form as HTMLFormElement);
      const email = String(fd.get("email") || "");
      const password = String(fd.get("password") || "");
      try {
        if (mode === "register") await api.register(email, password);
        else await api.login(email, password);
        await refreshSession();
        toast("登录成功");
        render();
      } catch (err) {
        toast(err instanceof Error ? err.message : "失败");
      }
    });
  });

  document.querySelectorAll("form[data-profile]").forEach((form) => {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const displayName = String(new FormData(form as HTMLFormElement).get("display_name") || "");
      try {
        const result = await api.updateProfile(displayName);
        state.user = result.user;
        toast("资料已更新");
        render();
      } catch (error) {
        toast(error instanceof Error ? error.message : "更新失败");
      }
    });
  });

  document.querySelectorAll("form[data-report]").forEach((form) => {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const id = form.getAttribute("data-report")!;
      const data = new FormData(form as HTMLFormElement);
      try {
        await api.report(id, String(data.get("reason")), String(data.get("detail")));
        toast("举报已提交");
        (form.closest("details") as HTMLDetailsElement | null)?.removeAttribute("open");
      } catch (error) {
        toast(error instanceof Error ? error.message : "提交失败");
      }
    });
  });

  const fileInput = document.querySelector("[data-import-file]") as HTMLInputElement | null;
  if (fileInput) {
    const zone = fileInput.closest(".dropzone");
    zone?.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      try {
        toast("导入中…");
        const r = await api.adminImport(file);
        toast(r.job.status === "succeeded" ? "导入成功" : `导入${r.job.status}`);
        render();
      } catch (e) {
        toast(e instanceof Error ? e.message : "导入失败");
      }
    });
  }

  document.querySelectorAll("form[data-curate]").forEach((form) => {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const id = form.getAttribute("data-curate")!;
      const fd = new FormData(form as HTMLFormElement);
      const included = [...(form as HTMLFormElement).querySelectorAll('input[name="file"]:checked')].map(
        (x) => (x as HTMLInputElement).value
      );
      try {
        await api.adminPatchListing(id, {
          title: fd.get("title"),
          summary: fd.get("summary"),
          price_tier: fd.get("price_tier"),
          tags: String(fd.get("tags") || "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
          included_file_ids: included
        });
        toast("已保存");
        render();
      } catch (err) {
        toast(err instanceof Error ? err.message : "保存失败");
      }
    });
  });

  document.querySelectorAll("[data-publish]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      try {
        await api.adminPublish(btn.getAttribute("data-publish")!);
        toast("已发布");
        render();
      } catch (e) {
        toast(e instanceof Error ? e.message : "发布失败");
      }
    })
  );

  document.querySelectorAll("[data-status]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const form = btn.closest("form[data-curate]");
      const id = form?.getAttribute("data-curate");
      if (!id) return;
      try {
        await api.adminPatchListing(id, { status: btn.getAttribute("data-status") });
        toast("状态已更新");
        render();
      } catch (e) {
        toast(e instanceof Error ? e.message : "失败");
      }
    })
  );

  document.querySelectorAll("form[data-grant]").forEach((form) => {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(form as HTMLFormElement);
      try {
        const r = await api.adminGrant(
          String(fd.get("email")),
          Number(fd.get("amount")),
          String(fd.get("note") || "")
        );
        toast(`完成，余额 ${r.balance}`);
      } catch (err) {
        toast(err instanceof Error ? err.message : "失败");
      }
    });
  });

  document.querySelectorAll("[data-resolve-report]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-resolve-report")!;
      const takeDown = btn.getAttribute("data-take-down") === "true";
      try {
        await api.adminResolveReport(id, {
          status: takeDown ? "resolved" : "dismissed",
          resolution: takeDown ? "运营复核后下架" : "运营复核后驳回",
          take_down: takeDown
        });
        toast("举报已处理");
        render();
      } catch (error) {
        toast(error instanceof Error ? error.message : "处理失败");
      }
    })
  );

  document.querySelectorAll("form[data-price-tier]").forEach((form) => {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const id = form.getAttribute("data-price-tier")!;
      const data = new FormData(form as HTMLFormElement);
      try {
        await api.adminPatchPriceTier(id, String(data.get("label")), Number(data.get("credits")));
        toast("档位已更新");
        render();
      } catch (error) {
        toast(error instanceof Error ? error.message : "更新失败");
      }
    });
  });

  document.querySelectorAll("form[data-revenue-share]").forEach((form) => {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const data = new FormData(form as HTMLFormElement);
      try {
        await api.adminCreateRevenueShare(Number(data.get("author")), Number(data.get("platform")));
        toast("分成版本已创建");
        render();
      } catch (error) {
        toast(error instanceof Error ? error.message : "创建失败");
      }
    });
  });
}

window.addEventListener("hashchange", () => {
  render();
});

refreshSession().then(render);
