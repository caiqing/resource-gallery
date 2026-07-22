(() => {
  const app = document.getElementById("app");
  const header = document.getElementById("site-header");
  const footer = document.getElementById("site-footer");

  const state = {
    theme: localStorage.getItem("rg-theme") || "light",
    meTab: "owned",
    rankMetric: "likes",
    rankRange: "week",
    toastTimer: null
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

  function navigate(to) {
    if (!to.startsWith("#")) location.hash = to;
    else location.hash = to.slice(1);
  }

  function toast(msg) {
    let el = document.querySelector(".toast");
    if (!el) {
      el = document.createElement("div");
      el.className = "toast";
      document.body.appendChild(el);
    }
    el.textContent = msg;
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => el.remove(), 2200);
  }

  function toggleTheme() {
    state.theme = state.theme === "light" ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", state.theme);
    localStorage.setItem("rg-theme", state.theme);
    render();
  }

  function isLiked(id) {
    return RG.user.likedIds.includes(id);
  }

  function isOwned(id) {
    return RG.user.ownedIds.includes(id);
  }

  function toggleLike(id) {
    const work = RG.getWork(id);
    if (!work) return;
    if (isLiked(id)) {
      RG.user.likedIds = RG.user.likedIds.filter((x) => x !== id);
      work.likes = Math.max(0, work.likes - 1);
      toast("已取消点赞");
    } else {
      RG.user.likedIds.push(id);
      work.likes += 1;
      toast("已点赞");
    }
    render();
  }

  function purchase(id) {
    const work = RG.getWork(id);
    if (!work) return;
    if (isOwned(id) || work.price === 0) {
      if (!isOwned(id)) RG.user.ownedIds.push(id);
      toast(work.price === 0 ? "已获取下载权" : "已拥有，可直接下载");
      navigate(`#/work/${id}`);
      return;
    }
    if (RG.user.balance < work.price) {
      toast("余额不足（原型演示可先到个人中心查看流水）");
      return;
    }
    RG.user.balance -= work.price;
    RG.user.ownedIds.push(id);
    work.downloads += 1;
    RG.ledger.unshift({
      id: `l_${Date.now()}`,
      at: new Date().toISOString().slice(0, 16).replace("T", " "),
      title: `获取《${work.title}》`,
      delta: -work.price,
      balance: RG.user.balance
    });
    toast(`已支付 ${work.price} credits`);
    navigate(`#/work/${id}`);
  }

  function workCard(w) {
    const chips = w.tags.slice(0, 2).map((t) => `<span class="chip">${escapeHtml(t)}</span>`).join("");
    const more = w.tags.length > 2 ? `<span class="chip is-more">+${w.tags.length - 2}</span>` : "";
    return `
      <a class="work-card" href="#/work/${w.id}" aria-label="${escapeHtml(w.title)}">
        <div class="cover-wrap" data-ratio="${w.ratio}">
          <img class="cover-art" src="${w.cover}" alt="" />
          <span class="cover-badge">${escapeHtml(RG.topicName(w.topic))}</span>
        </div>
        <div class="card-body">
          <h3 class="card-title">${escapeHtml(w.title)}</h3>
          <p class="card-summary">${escapeHtml(w.summary)}</p>
          <div class="card-meta">
            <div class="chips">${chips}${more}</div>
            <div class="price num">${escapeHtml(RG.priceLabel(w.price))}</div>
          </div>
        </div>
      </a>`;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function renderHeader(route) {
    const admin = route.parts[0] === "admin";
    document.body.classList.toggle("is-admin", admin);
    document.body.classList.toggle("admin-shell", admin);

    if (admin) {
      header.innerHTML = `
        <a class="brand" href="#/admin" aria-label="Resource Gallery Admin">
          <span class="brand-mark" aria-hidden="true"></span>
          <span class="brand-name">RG Admin</span>
          <span class="brand-sub">Utility</span>
        </a>
        <nav class="nav-links" aria-label="后台">
          <a href="#/admin" class="${route.path === "/admin" ? "is-active" : ""}">总览</a>
          <a href="#/admin/import" class="${route.path.startsWith("/admin/import") ? "is-active" : ""}">导入</a>
          <a href="#/admin/listings" class="${route.path.startsWith("/admin/listings") ? "is-active" : ""}">上架</a>
        </nav>
        <div class="header-actions">
          <button class="icon-btn" type="button" data-action="theme" aria-label="切换深浅色">${state.theme === "light" ? "深" : "浅"}</button>
          <a class="btn btn-ghost btn-sm" href="#/">返回画廊</a>
        </div>`;
      return;
    }

    const path = route.path;
    header.innerHTML = `
      <a class="brand" href="#/" aria-label="Resource Gallery 首页">
        <span class="brand-mark" aria-hidden="true"></span>
        <span class="brand-name">Resource Gallery</span>
        <span class="brand-sub">Editorial</span>
      </a>
      <nav class="nav-links" aria-label="主导航">
        <a href="#/" class="${path === "/" ? "is-active" : ""}">探索</a>
        <a href="#/topics" class="${path.startsWith("/topics") ? "is-active" : ""}">主题</a>
        <a href="#/rank" class="${path.startsWith("/rank") ? "is-active" : ""}">排行</a>
        <a href="#/search" class="${path.startsWith("/search") ? "is-active" : ""}">搜索</a>
      </nav>
      <div class="header-actions">
        <button class="icon-btn" type="button" data-action="theme" aria-label="切换深浅色">${state.theme === "light" ? "深色" : "浅色"}</button>
        <a class="btn btn-ghost btn-sm" href="#/me">${escapeHtml(RG.user.name)}</a>
        <a class="btn btn-quiet btn-sm" href="#/admin">运营</a>
      </div>`;
  }

  function renderFooter(route) {
    if (route.parts[0] === "admin") {
      footer.innerHTML = `<div class="container"><span>Admin Utility 皮肤 · 与 C 端 Gallery 分离</span><span>一期无 C 端发布</span></div>`;
      return;
    }
    footer.innerHTML = `
      <div class="container">
        <span>Resource Gallery · 精选知识资产画廊</span>
        <span>Generated with Video2PPT（弱关联） · 原型 v0.1</span>
      </div>`;
  }

  function pageHome() {
    const featured = [...RG.works].sort((a, b) => b.likes - a.likes).slice(0, 8);
    return `
      <div class="container page">
        <section class="hero">
          <div class="hero-kicker">Editorial Gallery</div>
          <h1>把一次优质生成，陈列成可复用的知识资产</h1>
          <p class="hero-lead">浏览主题化的演示文稿、信息图与结构化文稿。Credits 只是安静的获取方式，不是游戏币。</p>
          <form class="search-bar" data-search-form>
            <label class="sr-only" for="q-home">搜索资源</label>
            <input id="q-home" name="q" placeholder="搜索标题、标签或主题…" />
            <button class="btn btn-primary btn-sm" type="submit">搜索</button>
          </form>
        </section>

        <div class="section-head">
          <div>
            <h2>主题墙</h2>
            <p>受控主题，少而准</p>
          </div>
          <a class="btn btn-quiet" href="#/topics">全部主题</a>
        </div>
        <div class="topic-grid">
          ${RG.topics.slice(0, 4).map((t) => `
            <a class="topic-card" href="#/topics/${t.id}" style="--topic-art: linear-gradient(145deg, var(--surface-2), var(--accent-soft))">
              <h3>${escapeHtml(t.name)}</h3>
              <p>${escapeHtml(t.desc)}</p>
            </a>`).join("")}
        </div>

        <div class="section-head">
          <div>
            <h2>精选</h2>
            <p>封面优先的作品网格</p>
          </div>
          <a class="btn btn-quiet" href="#/rank">查看榜单</a>
        </div>
        <div class="work-grid">${featured.map(workCard).join("")}</div>
      </div>`;
  }

  function pageTopics(id) {
    if (!id) {
      return `
        <div class="container page">
          <div class="section-head"><div><h2>主题墙</h2><p>一级受控主题</p></div></div>
          <div class="topic-grid">
            ${RG.topics.map((t) => `
              <a class="topic-card" href="#/topics/${t.id}">
                <h3>${escapeHtml(t.name)}</h3>
                <p>${escapeHtml(t.desc)} · ${t.count}</p>
              </a>`).join("")}
          </div>
        </div>`;
    }
    const topic = RG.topics.find((t) => t.id === id);
    const list = RG.works.filter((w) => w.topic === id);
    return `
      <div class="container page">
        <div class="section-head">
          <div>
            <h2>${escapeHtml(topic ? topic.name : "主题")}</h2>
            <p>${escapeHtml(topic ? topic.desc : "")}</p>
          </div>
          <a class="btn btn-ghost btn-sm" href="#/topics">全部主题</a>
        </div>
        ${list.length ? `<div class="work-grid">${list.map(workCard).join("")}</div>` : empty("这座主题下还没有上架作品。", "去探索", "#/")}
      </div>`;
  }

  function pageSearch(q) {
    const query = (q || "").trim();
    const list = query
      ? RG.works.filter((w) => {
          const bag = [w.title, w.summary, w.tags.join(" "), RG.topicName(w.topic)].join(" ").toLowerCase();
          return bag.includes(query.toLowerCase());
        })
      : [];
    return `
      <div class="container page">
        <div class="section-head"><div><h2>搜索</h2><p>标题、摘要、标签、主题</p></div></div>
        <form class="search-bar" data-search-form style="margin-bottom:24px">
          <label class="sr-only" for="q-search">搜索</label>
          <input id="q-search" name="q" value="${escapeHtml(query)}" placeholder="试试「评测」或「Credits」" />
          <button class="btn btn-primary btn-sm" type="submit">搜索</button>
        </form>
        ${
          !query
            ? empty("输入关键词，开始在画廊里定位作品。")
            : list.length
              ? `<div class="work-grid">${list.map(workCard).join("")}</div>`
              : empty("没有与该词匹配的作品。", "查看精选", "#/")
        }
      </div>`;
  }

  function pageRank() {
    const metric = state.rankMetric;
    const sorted = [...RG.works].sort((a, b) => (metric === "likes" ? b.likes - a.likes : b.downloads - a.downloads));
    return `
      <div class="container page">
        <div class="section-head">
          <div>
            <h2>榜单</h2>
            <p>杂志感排序，不是游戏战绩</p>
          </div>
          <div class="rank-tabs" role="tablist" aria-label="榜单类型">
            <button type="button" data-rank-metric="likes" class="${metric === "likes" ? "is-active" : ""}">点赞</button>
            <button type="button" data-rank-metric="downloads" class="${metric === "downloads" ? "is-active" : ""}">下载</button>
          </div>
        </div>
        <div class="seg-tabs" aria-label="时间范围">
          ${["day", "week", "all"].map((r) => {
            const label = { day: "日", week: "周", all: "总" }[r];
            return `<button type="button" data-rank-range="${r}" class="${state.rankRange === r ? "is-active" : ""}">${label}</button>`;
          }).join("")}
        </div>
        <div class="rank-list">
          ${sorted.map((w, i) => `
            <a class="rank-item" href="#/work/${w.id}">
              <div class="rank-no num">${String(i + 1).padStart(2, "0")}</div>
              <div class="rank-thumb"><img class="cover-art" src="${w.cover}" alt="" /></div>
              <div>
                <h3 class="rank-title">${escapeHtml(w.title)}</h3>
                <p class="rank-meta">${escapeHtml(RG.topicName(w.topic))} · ${escapeHtml(w.versionLabel)}</p>
              </div>
              <div class="rank-count price num">${metric === "likes" ? `${w.likes} 赞` : `${w.downloads} 次`}</div>
            </a>`).join("")}
        </div>
      </div>`;
  }

  function pageDetail(id, withCheckout) {
    const w = RG.getWork(id);
    if (!w) return `<div class="container page">${empty("找不到这件作品。", "回首页", "#/")}</div>`;
    const owned = isOwned(w.id) || w.price === 0;
    const primaryLabel = owned ? "下载整包" : `使用 ${w.price} credits 获取`;
    const primaryAction = owned ? "download" : "open-checkout";

    const checkout = withCheckout && !owned && w.price > 0 ? `
      <div class="sheet-backdrop" data-close-checkout role="presentation">
        <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="checkout-title">
          <h2 id="checkout-title">确认获取</h2>
          <p style="margin:0;color:var(--muted)">像画廊购票一样完成一次确认。不做闪烁促销。</p>
          <div class="sheet-row"><span>作品</span><strong>${escapeHtml(w.title)}</strong></div>
          <div class="sheet-row"><span>价格</span><strong class="num">${w.price} credits</strong></div>
          <div class="sheet-row"><span>余额</span><strong class="num">${RG.user.balance} → ${RG.user.balance - w.price}</strong></div>
          <div class="buy-actions">
            <button class="btn btn-primary" type="button" data-purchase="${w.id}">确认支付</button>
            <button class="btn btn-ghost" type="button" data-close-checkout>取消</button>
          </div>
        </div>
      </div>` : "";

    return `
      <div class="container page">
        <div class="detail-layout">
          <section class="preview-stage" aria-label="作品预览">
            <img class="cover-art" src="${w.cover}" alt="${escapeHtml(w.title)} 预览" />
            <div class="preview-caption">
              <span>未购可预览封面与摘要 · PDF 前页策略见 PRD</span>
              <span>${escapeHtml(w.versionLabel)}</span>
            </div>
          </section>
          <aside class="buy-rail">
            <div class="chips"><span class="chip">${escapeHtml(RG.topicName(w.topic))}</span>${w.tags.map((t) => `<span class="chip">${escapeHtml(t)}</span>`).join("")}</div>
            <h1>${escapeHtml(w.title)}</h1>
            <p class="buy-summary">${escapeHtml(w.summary)}</p>
            <div class="buy-price">
              <div>
                <div class="label" style="color:var(--muted);font-size:0.82rem">价格</div>
                <div class="amount num">${escapeHtml(RG.priceLabel(w.price))}</div>
              </div>
              <div style="text-align:right;color:var(--muted);font-size:0.85rem">
                <div>余额 <span class="num">${RG.user.balance}</span></div>
                <div>${w.likes} 赞 · ${w.downloads} 次获取</div>
              </div>
            </div>
            <div class="buy-actions">
              <button class="btn btn-primary btn-block" type="button" data-action="${primaryAction}" data-id="${w.id}">${primaryLabel}</button>
              <div class="buy-secondary">
                <button class="btn btn-ghost ${isLiked(w.id) ? "is-liked" : ""}" type="button" data-like="${w.id}">${isLiked(w.id) ? "已点赞" : "点赞"}</button>
                <a class="btn btn-ghost" href="#/share/${w.id}">分享</a>
              </div>
            </div>
            <div>
              <div style="margin-bottom:8px;color:var(--muted);font-size:0.82rem">${owned ? "可下载文件" : "包含文件（获取后）"}</div>
              <ul class="file-list">
                ${w.files.filter((f) => f.included).map((f) => `<li><span>${escapeHtml(f.name)}</span><span class="kind">${escapeHtml(f.kind)}</span></li>`).join("")}
              </ul>
            </div>
            <div class="source-note">作者 ${escapeHtml(w.author)} · Generated with Video2PPT</div>
          </aside>
        </div>
      </div>
      ${checkout}`;
  }

  function pageShare(id) {
    const w = RG.getWork(id);
    if (!w) return `<div class="container page">${empty("分享目标不存在。", "回首页", "#/")}</div>`;
    return `
      <div class="container page">
        <div class="section-head"><div><h2>分享预览</h2><p>OG 大封面卡片（模拟）</p></div>
          <a class="btn btn-ghost btn-sm" href="#/work/${w.id}">返回详情</a>
        </div>
        <article class="share-card">
          <img class="cover-art" src="${w.cover}" alt="" />
          <div class="share-body">
            <div class="hero-kicker">Resource Gallery</div>
            <h1>${escapeHtml(w.title)}</h1>
            <p style="margin:0;color:var(--muted)">${escapeHtml(w.summary)}</p>
            <div class="card-meta">
              <span class="chip">${escapeHtml(RG.topicName(w.topic))}</span>
              <span class="price num">${escapeHtml(RG.priceLabel(w.price))}</span>
            </div>
          </div>
        </article>
        <p style="text-align:center;color:var(--muted);margin-top:18px">未登录访客可见摘要与封面，不可下载完整包。</p>
      </div>`;
  }

  function pageMe() {
    const tab = state.meTab;
    let body = "";
    if (tab === "owned") {
      const list = RG.works.filter((w) => isOwned(w.id));
      body = list.length ? `<div class="work-grid">${list.map(workCard).join("")}</div>` : empty("还没有已获取的作品。", "去探索", "#/");
    } else if (tab === "liked") {
      const list = RG.works.filter((w) => isLiked(w.id));
      body = list.length ? `<div class="work-grid">${list.map(workCard).join("")}</div>` : empty("还没有点赞。");
    } else {
      body = `
        <table class="ledger-table">
          <thead><tr><th>时间</th><th>说明</th><th>变动</th><th>余额</th></tr></thead>
          <tbody>
            ${RG.ledger.map((r) => `
              <tr>
                <td class="num">${escapeHtml(r.at)}</td>
                <td>${escapeHtml(r.title)}</td>
                <td class="num">${r.delta > 0 ? "+" : ""}${r.delta}</td>
                <td class="num">${r.balance}</td>
              </tr>`).join("")}
          </tbody>
        </table>
        <p class="source-note" style="margin-top:12px">作者 pending_earnings 在本原型买家视图中为 0；兑现不属于一期。</p>`;
    }

    return `
      <div class="container page">
        <div class="me-layout">
          <aside class="me-side">
            <div>
              <div style="font-family:var(--font-display);font-size:1.2rem;font-weight:600">${escapeHtml(RG.user.name)}</div>
              <div style="color:var(--muted);font-size:0.88rem">注册用户 · 无发布权限</div>
            </div>
            <div class="balance-card">
              <div class="label">可用余额</div>
              <div class="value num">${RG.user.balance}</div>
              <div class="label" style="margin-top:8px">credits</div>
            </div>
            <nav class="me-nav" aria-label="个人中心分区">
              <button type="button" data-me-tab="owned" class="${tab === "owned" ? "is-active" : ""}">已购</button>
              <button type="button" data-me-tab="liked" class="${tab === "liked" ? "is-active" : ""}">点赞</button>
              <button type="button" data-me-tab="ledger" class="${tab === "ledger" ? "is-active" : ""}">流水</button>
            </nav>
          </aside>
          <section class="panel">
            <h2>${tab === "owned" ? "已购" : tab === "liked" ? "点赞" : "Credits 流水"}</h2>
            ${body}
          </section>
        </div>
      </div>`;
  }

  function pageAdminHome() {
    return `
      <div class="admin-layout">
        ${adminNav("home")}
        <div class="admin-main">
          <div class="kpi-row">
            <div class="kpi"><div class="label">已发布</div><div class="value">${RG.adminListings.filter((x) => x.status === "published").length}</div></div>
            <div class="kpi"><div class="label">草稿</div><div class="value">${RG.adminListings.filter((x) => x.status === "draft").length}</div></div>
            <div class="kpi"><div class="label">导入 Job</div><div class="value">${RG.importJobs.length}</div></div>
            <div class="kpi"><div class="label">C 端作品</div><div class="value">${RG.works.length}</div></div>
          </div>
          <section class="admin-card">
            <h1>运营台</h1>
            <p class="lead">Utility 皮肤：密度更高，服务导入、策展与治理。不使用 C 端暖纸画廊气质。</p>
            <div class="admin-actions">
              <a class="btn-admin" href="#/admin/import">导入导出包</a>
              <a class="btn-admin-ghost" href="#/admin/listings">管理 Listing</a>
            </div>
          </section>
        </div>
      </div>`;
  }

  function pageAdminImport() {
    return `
      <div class="admin-layout">
        ${adminNav("import")}
        <div class="admin-main">
          <section class="admin-card">
            <h1>导入 resource-gallery.export/v1</h1>
            <p class="lead">仅管理员。公网只接收 zip；自动剥离 video / auth；失败不得留下 published 半成品。</p>
            <div class="dropzone" data-mock-import role="button" tabindex="0">
              <strong>点击模拟上传 run 导出包</strong>
              <span>支持 manifest.json + task_meta.json + run_meta.json + files/</span>
            </div>
            <div class="job-list">
              ${RG.importJobs.map((j) => `
                <div class="job-item">
                  <div>
                    <div>${escapeHtml(j.file)}</div>
                    <div style="color:var(--admin-muted);font-size:0.82rem">${escapeHtml(j.note)} · ${escapeHtml(j.at)}</div>
                  </div>
                  <span class="badge ${j.status === "succeeded" ? "ok" : "danger"}">${j.status}</span>
                  ${j.status === "succeeded" ? `<a class="btn-admin-ghost" href="#/admin/listings/w-draft-01">去策展</a>` : `<span></span>`}
                </div>`).join("")}
            </div>
          </section>
        </div>
      </div>`;
  }

  function pageAdminListings(id) {
    if (!id) {
      return `
        <div class="admin-layout">
          ${adminNav("listings")}
          <div class="admin-main">
            <section class="admin-card">
              <h1>Listing</h1>
              <p class="lead">草稿、已发布、隐藏与下架。C 端用户不可见此台。</p>
              <table class="admin-table">
                <thead><tr><th>标题</th><th>状态</th><th>档位</th><th>标签</th><th></th></tr></thead>
                <tbody>
                  ${RG.adminListings.map((l) => `
                    <tr>
                      <td>${escapeHtml(l.title)}</td>
                      <td><span class="badge ${l.status === "published" ? "ok" : l.status === "draft" ? "warn" : ""}">${escapeHtml(l.status)}</span></td>
                      <td>${escapeHtml(l.tier)}</td>
                      <td>${escapeHtml(l.tags.join(" · "))}</td>
                      <td><a href="#/admin/listings/${l.id}">打开</a></td>
                    </tr>`).join("")}
                </tbody>
              </table>
            </section>
          </div>
        </div>`;
    }

    const listing = RG.adminListings.find((l) => l.id === id) || RG.adminListings[0];
    return `
      <div class="admin-layout">
        ${adminNav("listings")}
        <div class="admin-main">
          <section class="admin-card">
            <h1>策展 · ${escapeHtml(listing.title)}</h1>
            <p class="lead">勾选可分发文件，确认标签与价格档位后发布。锁定项为默认剥离且不可勾选。</p>
            <form class="admin-form" data-curate-form data-id="${listing.id}">
              <label>标题<input name="title" value="${escapeHtml(listing.title)}" /></label>
              <label>价格档位
                <select name="tier">
                  ${["free", "standard", "premium"].map((t) => `<option value="${t}" ${listing.tier === t ? "selected" : ""}>${t}</option>`).join("")}
                </select>
              </label>
              <label>标签（逗号分隔）<input name="tags" value="${escapeHtml(listing.tags.join(", "))}" /></label>
              <div>
                <div style="margin-bottom:8px;color:var(--admin-muted);font-size:0.88rem">文件</div>
                <div class="file-check">
                  ${(listing.files.length ? listing.files : [
                    { name: "deck.pdf", kind: "slide_pdf", included: true, locked: false },
                    { name: "content.md", kind: "content", included: true, locked: false }
                  ]).map((f, idx) => `
                    <label class="${f.locked ? "is-locked" : ""}">
                      <input type="checkbox" name="file_${idx}" ${f.included && !f.locked ? "checked" : ""} ${f.locked ? "disabled" : ""} />
                      <span>${escapeHtml(f.name)} <span class="badge">${escapeHtml(f.kind)}</span> ${f.locked ? "默认剥离" : ""}</span>
                    </label>`).join("")}
                </div>
              </div>
              <div class="admin-actions">
                <button class="btn-admin" type="submit">保存并发布</button>
                <button class="btn-admin-ghost" type="button" data-take-down>下架</button>
                <a class="btn-admin-ghost" href="#/admin/listings">返回列表</a>
              </div>
            </form>
          </section>
        </div>
      </div>`;
  }

  function adminNav(active) {
    return `
      <nav class="admin-nav" aria-label="运营导航">
        <a href="#/admin" class="${active === "home" ? "is-active" : ""}">总览</a>
        <a href="#/admin/import" class="${active === "import" ? "is-active" : ""}">导入 Job</a>
        <a href="#/admin/listings" class="${active === "listings" ? "is-active" : ""}">Listing 策展</a>
        <a href="#/">← C 端画廊</a>
      </nav>`;
  }

  function empty(text, actionLabel, href) {
    return `
      <div class="empty-state">
        <h3>暂无内容</h3>
        <p>${escapeHtml(text)}</p>
        ${actionLabel && href ? `<a class="btn btn-ghost" href="${href}">${escapeHtml(actionLabel)}</a>` : ""}
      </div>`;
  }

  function render() {
    const route = parseRoute();
    renderHeader(route);
    renderFooter(route);

    const p = route.parts;
    let html = "";

    if (p[0] === "admin") {
      if (p[1] === "import") html = pageAdminImport();
      else if (p[1] === "listings") html = pageAdminListings(p[2]);
      else html = pageAdminHome();
    } else if (p[0] === "topics") html = pageTopics(p[1]);
    else if (p[0] === "search") html = pageSearch(route.query.q || "");
    else if (p[0] === "rank") html = pageRank();
    else if (p[0] === "work" && p[1] && p[2] === "checkout") html = pageDetail(p[1], true);
    else if (p[0] === "work" && p[1]) html = pageDetail(p[1], false);
    else if (p[0] === "share" && p[1]) html = pageShare(p[1]);
    else if (p[0] === "me") html = pageMe();
    else html = pageHome();

    app.innerHTML = html;
    bind();
  }

  function bind() {
    document.querySelectorAll("[data-action='theme']").forEach((el) => {
      el.addEventListener("click", toggleTheme);
    });

    document.querySelectorAll("[data-search-form]").forEach((form) => {
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        const q = new FormData(form).get("q") || "";
        navigate(`#/search?q=${encodeURIComponent(String(q))}`);
      });
    });

    document.querySelectorAll("[data-rank-metric]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.rankMetric = btn.getAttribute("data-rank-metric");
        render();
      });
    });

    document.querySelectorAll("[data-rank-range]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.rankRange = btn.getAttribute("data-rank-range");
        render();
      });
    });

    document.querySelectorAll("[data-like]").forEach((btn) => {
      btn.addEventListener("click", () => toggleLike(btn.getAttribute("data-like")));
    });

    document.querySelectorAll("[data-action='open-checkout']").forEach((btn) => {
      btn.addEventListener("click", () => navigate(`#/work/${btn.getAttribute("data-id")}/checkout`));
    });

    document.querySelectorAll("[data-action='download']").forEach((btn) => {
      btn.addEventListener("click", () => toast("原型演示：已生成短时签名下载链接（模拟）"));
    });

    document.querySelectorAll("[data-purchase]").forEach((btn) => {
      btn.addEventListener("click", () => purchase(btn.getAttribute("data-purchase")));
    });

    document.querySelectorAll("[data-close-checkout]").forEach((el) => {
      el.addEventListener("click", (e) => {
        if (e.target === el || el.matches("button")) {
          const id = parseRoute().parts[1];
          navigate(`#/work/${id}`);
        }
      });
    });

    document.querySelectorAll("[data-me-tab]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.meTab = btn.getAttribute("data-me-tab");
        render();
      });
    });

    const importZone = document.querySelector("[data-mock-import]");
    if (importZone) {
      const run = () => {
        RG.importJobs.unshift({
          id: `job_${Date.now()}`,
          file: `demo_${String(Date.now()).slice(-4)}__run_x__v1.zip`,
          status: "succeeded",
          note: "模拟校验通过 → 新草稿",
          at: new Date().toISOString().slice(0, 16).replace("T", " ")
        });
        if (!RG.adminListings.find((l) => l.id === "w-draft-01")) {
          /* keep existing draft */
        }
        toast("导入 Job 已创建（模拟）");
        render();
      };
      importZone.addEventListener("click", run);
      importZone.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          run();
        }
      });
    }

    const curate = document.querySelector("[data-curate-form]");
    if (curate) {
      curate.addEventListener("submit", (e) => {
        e.preventDefault();
        const id = curate.getAttribute("data-id");
        const listing = RG.adminListings.find((l) => l.id === id);
        if (listing) {
          const fd = new FormData(curate);
          listing.title = String(fd.get("title") || listing.title);
          listing.tier = String(fd.get("tier") || listing.tier);
          listing.tags = String(fd.get("tags") || "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
          listing.status = "published";
          toast("已发布到画廊（模拟）");
        }
        navigate("#/admin/listings");
      });
      const takeDown = curate.querySelector("[data-take-down]");
      if (takeDown) {
        takeDown.addEventListener("click", () => {
          const id = curate.getAttribute("data-id");
          const listing = RG.adminListings.find((l) => l.id === id);
          if (listing) listing.status = "taken_down";
          toast("已下架");
          render();
        });
      }
    }

    const sheet = document.querySelector(".sheet");
    if (sheet) {
      const focusable = sheet.querySelector("button, [href], input, select, textarea");
      if (focusable) focusable.focus();
      sheet.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          const id = parseRoute().parts[1];
          navigate(`#/work/${id}`);
        }
      });
    }
  }

  window.addEventListener("hashchange", render);
  window.addEventListener("DOMContentLoaded", render);
  render();
})();
