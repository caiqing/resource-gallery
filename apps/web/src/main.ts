import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/gallery.css";
import "./styles/admin.css";
import * as pdfjsLib from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";
import { marked } from "marked";
import {
  api,
  coverUrl,
  priceLabel,
  type Account,
  type Listing,
  type SummaryLlmModel,
  type User
} from "./lib/api";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const markdownRenderer = new marked.Renderer();
markdownRenderer.html = () => "";
marked.setOptions({
  gfm: true,
  breaks: true,
  renderer: markdownRenderer
});

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

type PdfViewerController = {
  destroy: () => void;
  first: () => void;
  prev: () => void;
  next: () => void;
  last: () => void;
  rerender: () => void;
  page: number;
  pages: number;
};

let activePdfViewer: PdfViewerController | null = null;
let pdfKeyHandlerBound = false;

function destroyActivePdfViewer() {
  activePdfViewer?.destroy();
  activePdfViewer = null;
}

function pdfPagerMarkup(sourceLabel = "PDF") {
  return `<div class="pdf-viewer" data-pdf-viewer>
    <div class="pdf-stage">
      <canvas class="pdf-canvas" data-pdf-canvas></canvas>
      <div class="pdf-status" data-pdf-status>加载 ${esc(sourceLabel)}…</div>
    </div>
    <div class="pdf-pager" role="toolbar" aria-label="页面导航">
      <button type="button" class="btn btn-ghost btn-sm" data-pdf-nav="first" title="首页 (Home)" disabled>首页</button>
      <button type="button" class="btn btn-ghost btn-sm" data-pdf-nav="prev" title="上一页 (←)" disabled>上一页</button>
      <label class="pdf-page-jump">
        <span class="sr-only">页码</span>
        <input class="pdf-page-input" data-pdf-page-input type="number" min="1" value="1" inputmode="numeric" />
        <span class="pdf-page-total">/ <span data-pdf-pages>1</span></span>
      </label>
      <button type="button" class="btn btn-ghost btn-sm" data-pdf-nav="next" title="下一页 (→)" disabled>下一页</button>
      <button type="button" class="btn btn-ghost btn-sm" data-pdf-nav="last" title="末页 (End)" disabled>末页</button>
    </div>
  </div>`;
}

async function mountPdfViewer(root: HTMLElement) {
  destroyActivePdfViewer();
  const url = root.getAttribute("data-pdf-url") || "";
  const canvas = root.querySelector("[data-pdf-canvas]") as HTMLCanvasElement | null;
  const status = root.querySelector("[data-pdf-status]") as HTMLElement | null;
  const pagesEl = root.querySelector("[data-pdf-pages]") as HTMLElement | null;
  const pageInput = root.querySelector("[data-pdf-page-input]") as HTMLInputElement | null;
  const buttons = {
    first: root.querySelector('[data-pdf-nav="first"]') as HTMLButtonElement | null,
    prev: root.querySelector('[data-pdf-nav="prev"]') as HTMLButtonElement | null,
    next: root.querySelector('[data-pdf-nav="next"]') as HTMLButtonElement | null,
    last: root.querySelector('[data-pdf-nav="last"]') as HTMLButtonElement | null
  };
  if (!url || !canvas) return;

  let destroyed = false;
  let pdfDoc: any = null;
  let page = 1;
  let pages = 1;
  let renderTask: any = null;
  const cleanupFns: Array<() => void> = [];

  const setStatus = (msg: string, isError = false) => {
    if (!status) return;
    status.hidden = !msg;
    status.textContent = msg;
    status.classList.toggle("is-error", isError);
  };

  const syncControls = () => {
    if (pageInput) {
      pageInput.value = String(page);
      pageInput.max = String(pages);
    }
    if (pagesEl) pagesEl.textContent = String(pages);
    if (buttons.first) buttons.first.disabled = page <= 1;
    if (buttons.prev) buttons.prev.disabled = page <= 1;
    if (buttons.next) buttons.next.disabled = page >= pages;
    if (buttons.last) buttons.last.disabled = page >= pages;
  };

  const renderPage = async (targetPage: number) => {
    if (!pdfDoc || destroyed) return;
    page = Math.min(Math.max(1, targetPage), pages);
    syncControls();
    setStatus("");
    if (renderTask) {
      try {
        renderTask.cancel();
      } catch {
        // ignore cancel race
      }
      renderTask = null;
    }
    const pdfPage = await pdfDoc.getPage(page);
    if (destroyed) return;
    const shell = root.closest(".preview-frame-shell") as HTMLElement | null;
    const stage = root.querySelector(".pdf-stage") as HTMLElement | null;
    const width = Math.max(320, stage?.clientWidth || shell?.clientWidth || 960);
    const height = Math.max(180, stage?.clientHeight || shell?.clientHeight || 540);
    const base = pdfPage.getViewport({ scale: 1 });
    const scale = Math.min(width / base.width, height / base.height) * (window.devicePixelRatio || 1);
    const viewport = pdfPage.getViewport({ scale: Math.max(0.5, scale) });
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.style.width = `${Math.floor(viewport.width / (window.devicePixelRatio || 1))}px`;
    canvas.style.height = `${Math.floor(viewport.height / (window.devicePixelRatio || 1))}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    renderTask = pdfPage.render({ canvasContext: ctx, viewport, canvas });
    try {
      await renderTask.promise;
    } catch (error: any) {
      if (error?.name !== "RenderingCancelledException") {
        setStatus("页面渲染失败", true);
      }
    } finally {
      renderTask = null;
    }
  };

  try {
    const loadingTask = pdfjsLib.getDocument({
      url,
      withCredentials: true,
      disableRange: false,
      disableStream: false
    });
    pdfDoc = await loadingTask.promise;
    if (destroyed) return;
    pages = pdfDoc.numPages || 1;
    page = 1;
    syncControls();
    await renderPage(1);
  } catch {
    setStatus("PDF 预览加载失败", true);
    return;
  }

  const onNav = (action: string) => {
    if (action === "first") void renderPage(1);
    if (action === "prev") void renderPage(page - 1);
    if (action === "next") void renderPage(page + 1);
    if (action === "last") void renderPage(pages);
  };

  Object.entries(buttons).forEach(([action, btn]) => {
    if (!btn) return;
    const handler = () => onNav(action);
    btn.addEventListener("click", handler);
    cleanupFns.push(() => btn.removeEventListener("click", handler));
  });

  if (pageInput) {
    const commit = () => {
      const next = Number(pageInput.value || "1");
      if (Number.isFinite(next)) void renderPage(next);
      else syncControls();
    };
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key === "Enter") {
        event.preventDefault();
        commit();
      }
    };
    pageInput.addEventListener("change", commit);
    pageInput.addEventListener("keydown", onKeydown);
    cleanupFns.push(() => {
      pageInput.removeEventListener("change", commit);
      pageInput.removeEventListener("keydown", onKeydown);
    });
  }

  const onResize = () => {
    void renderPage(page);
  };
  window.addEventListener("resize", onResize);
  cleanupFns.push(() => window.removeEventListener("resize", onResize));

  activePdfViewer = {
    destroy() {
      destroyed = true;
      cleanupFns.forEach((fn) => fn());
      if (renderTask) {
        try {
          renderTask.cancel();
        } catch {
          // ignore
        }
      }
      try {
        pdfDoc?.destroy?.();
      } catch {
        // ignore
      }
    },
    first: () => onNav("first"),
    prev: () => onNav("prev"),
    next: () => onNav("next"),
    last: () => onNav("last"),
    rerender: () => {
      void renderPage(page);
    },
    get page() {
      return page;
    },
    get pages() {
      return pages;
    }
  } as PdfViewerController;
}

function ensurePdfKeyboard() {
  if (pdfKeyHandlerBound) return;
  pdfKeyHandlerBound = true;
  window.addEventListener("keydown", (event) => {
    if (!activePdfViewer) return;
    const target = event.target as HTMLElement | null;
    if (target) {
      const tag = target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable) {
        // allow number input; only intercept when not typing freely except arrows on page input still ok for left/right outside
        if (!(target instanceof HTMLInputElement && target.matches("[data-pdf-page-input]"))) return;
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End") {
          return;
        }
      }
    }
    if (event.key === "ArrowLeft" || event.key === "PageUp") {
      event.preventDefault();
      activePdfViewer.prev();
    } else if (event.key === "ArrowRight" || event.key === "PageDown" || event.key === " ") {
      event.preventDefault();
      activePdfViewer.next();
    } else if (event.key === "Home") {
      event.preventDefault();
      activePdfViewer.first();
    } else if (event.key === "End") {
      event.preventDefault();
      activePdfViewer.last();
    }
  });
}


function isPreviewFullscreen() {
  const root = document.querySelector("[data-preview-root]");
  return Boolean(root && document.fullscreenElement === root);
}

const fullscreenEnterIcon = `<svg class="preview-fs-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
  <path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M8 3H4v4M16 3h4v4M8 21H4v-4M16 21h4v-4"/>
</svg>`;

const fullscreenExitIcon = `<svg class="preview-fs-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
  <path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M9 3v4H5M15 3v4h4M9 21v-4H5M15 21v-4h4"/>
</svg>`;

function syncFullscreenButton() {
  const btn = document.querySelector("[data-preview-fullscreen]") as HTMLButtonElement | null;
  if (!btn) return;
  const active = isPreviewFullscreen();
  btn.setAttribute("aria-pressed", active ? "true" : "false");
  btn.setAttribute("aria-label", active ? "退出全屏" : "全屏预览");
  btn.title = active ? "退出全屏 (Esc / F)" : "全屏 (F)";
  btn.innerHTML = active ? fullscreenExitIcon : fullscreenEnterIcon;
  btn.classList.toggle("is-active", active);
  document.querySelector("[data-preview-root]")?.classList.toggle("is-fullscreen", active);
}

async function togglePreviewFullscreen() {
  const root = document.querySelector("[data-preview-root]") as HTMLElement | null;
  if (!root) return;
  try {
    if (document.fullscreenElement === root) {
      await document.exitFullscreen();
    } else if (document.fullscreenElement) {
      await document.exitFullscreen();
      await root.requestFullscreen();
    } else {
      await root.requestFullscreen();
    }
  } catch {
    toast("当前浏览器不支持全屏预览");
  }
}

function ensurePreviewChrome() {
  if ((ensurePreviewChrome as any)._bound) return;
  (ensurePreviewChrome as any)._bound = true;
  document.addEventListener("fullscreenchange", () => {
    syncFullscreenButton();
    // PDF needs a reflow after entering/exiting fullscreen.
    window.setTimeout(() => activePdfViewer?.rerender(), 50);
  });
  document.addEventListener("dblclick", (event) => {
    const target = event.target as HTMLElement | null;
    if (!target) return;
    if (!target.closest("[data-preview-root]")) return;
    if (target.closest("button, a, input, textarea, select, label, .pdf-pager")) return;
    if (target.closest(".preview-media, .pdf-stage, .pdf-canvas, .preview-frame-shell")) {
      event.preventDefault();
      void togglePreviewFullscreen();
    }
  });
  window.addEventListener("keydown", (event) => {
    const root = document.querySelector("[data-preview-root]");
    if (!root) return;
    const target = event.target as HTMLElement | null;
    if (target) {
      const tag = target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable) return;
    }
    if (event.key === "f" || event.key === "F") {
      // Avoid intercepting browser find if user holds modifiers.
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      event.preventDefault();
      void togglePreviewFullscreen();
    }
  });
}

function hydratePreviewExtras(body: HTMLElement) {
  ensurePdfKeyboard();
  ensurePreviewChrome();
  syncFullscreenButton();
  const pdfHost = body.querySelector("[data-pdf-url]") as HTMLElement | null;
  if (pdfHost) {
    void mountPdfViewer(pdfHost);
    return;
  }
  destroyActivePdfViewer();
  const textHost = body.querySelector("[data-text-preview]") as HTMLElement | null;
  if (textHost) {
    void mountTextPreview(textHost);
    return;
  }
  // Backward-compatible plain text host
  const doc = body.querySelector("[data-preview-doc]") as HTMLElement | null;
  if (!doc) return;
  void (async () => {
    try {
      const res = await fetch(doc.getAttribute("data-preview-doc") || "", { credentials: "include" });
      if (!res.ok) throw new Error("preview unavailable");
      const textContent = await res.text();
      doc.innerHTML = `<pre class="preview-doc-text">${esc(textContent)}</pre>`;
    } catch {
      doc.innerHTML = `<div class="preview-empty">预览加载失败</div>`;
    }
  })();
}

async function mountTextPreview(root: HTMLElement) {
  const url = root.getAttribute("data-preview-url") || "";
  const format = root.getAttribute("data-preview-format") || "markdown";
  const bodyEl = root.querySelector("[data-text-body]") as HTMLElement | null;
  const copyBtn = root.querySelector("[data-text-copy]") as HTMLButtonElement | null;
  const modeButtons = [...root.querySelectorAll<HTMLButtonElement>("[data-text-mode]")];
  if (!url || !bodyEl) return;

  let source = "";
  let mode: "render" | "source" = "render";

  const setMode = (next: "render" | "source") => {
    mode = next;
    modeButtons.forEach((btn) => {
      const active = btn.getAttribute("data-text-mode") === mode;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-selected", active ? "true" : "false");
    });
    if (copyBtn) copyBtn.hidden = mode !== "source";
    renderMode();
  };

  const renderMode = () => {
    if (mode === "source") {
      bodyEl.innerHTML = `<pre class="preview-doc-text text-preview-source">${esc(source)}</pre>`;
      return;
    }
    if (format === "markdown") {
      const html = marked.parse(source, { async: false }) as string;
      bodyEl.innerHTML = `<article class="markdown-body">${html || "<p class=\"preview-doc-loading\">（空文档）</p>"}</article>`;
      return;
    }
    bodyEl.innerHTML = `<pre class="preview-doc-text">${esc(source)}</pre>`;
  };

  try {
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) throw new Error("preview unavailable");
    source = await res.text();
    setMode("render");
  } catch {
    bodyEl.innerHTML = `<div class="preview-empty"><strong>预览加载失败</strong><span>请稍后重试，或获取后下载查看。</span></div>`;
    modeButtons.forEach((btn) => {
      btn.disabled = true;
    });
    if (copyBtn) copyBtn.hidden = true;
    return;
  }

  modeButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const next = btn.getAttribute("data-text-mode") === "source" ? "source" : "render";
      setMode(next);
    });
  });

  if (copyBtn) {
    copyBtn.addEventListener("click", async () => {
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(source);
        } else {
          const ta = document.createElement("textarea");
          ta.value = source;
          ta.style.position = "fixed";
          ta.style.left = "-9999px";
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          ta.remove();
        }
        const prev = copyBtn.textContent;
        copyBtn.textContent = "已复制";
        window.setTimeout(() => {
          copyBtn.textContent = prev || "复制";
        }, 1200);
        toast("源码已复制");
      } catch {
        toast("复制失败");
      }
    });
  }
}

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

function tagChips(tags: unknown[] = [], limit = 2) {
  const visible = tags.slice(0, limit).map((tag) => `<span class="chip">${esc(tag)}</span>`).join("");
  const more = tags.length > limit ? `<span class="chip is-more">+${tags.length - limit}</span>` : "";
  return `${visible}${more}`;
}

function workCard(w: Listing) {
  const chips = tagChips(w.tags || []);
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
          <div class="chips">${chips}</div>
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

const assetGroupOrder = [
  { title: "AI 播客", kinds: ["audio_overview", "preview_audio"] },
  { title: "视频概览", kinds: ["video_overview", "preview_video", "poster"] },
  { title: "概览字幕", kinds: ["subtitle"] },
  { title: "来源材料（默认剥离）", kinds: ["video", "auth"] },
  { title: "结构材料", kinds: ["blueprint", "prompt", "source_context", "content"] },
  { title: "演示与下载", kinds: ["slide_pdf", "slide_deck", "infographic"] },
  { title: "其他文件", kinds: [] }
];

const assetKindLabels: Record<string, string> = {
  blueprint: "蓝图",
  prompt: "提示词",
  source_context: "来源上下文",
  content: "内容稿",
  slide_pdf: "PDF 演示稿",
  slide_deck: "PPTX",
  infographic: "信息图",
  audio_overview: "AI 播客",
  video_overview: "视频概览",
  preview_audio: "播客试听",
  preview_video: "视频片段",
  poster: "视频封面",
  video: "源视频",
  subtitle: "字幕"
};


function formatBytes(n: number | undefined) {
  const value = Number(n || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function shortAssetName(filename: string) {
  const base = String(filename || "");
  return base.length > 48 ? `${base.slice(0, 36)}…${base.slice(-8)}` : base;
}

const TEXT_PREVIEW_KINDS = new Set(["content", "blueprint", "prompt", "source_context", "subtitle"]);

function isTextPreviewFile(file: any) {
  const kind = String(file?.kind || "");
  const name = String(file?.filename || "");
  if (TEXT_PREVIEW_KINDS.has(kind)) return true;
  return /\.(md|markdown|mdx|txt)$/i.test(name);
}

function isMarkdownFile(file: any) {
  const name = String(file?.filename || "");
  if (/\.(md|markdown|mdx)$/i.test(name)) return true;
  // Text structure files are markdown even when extension is missing.
  return TEXT_PREVIEW_KINDS.has(String(file?.kind || "")) && !/\.txt$/i.test(name);
}

function isPreviewableFile(file: any) {
  // The API is the source of truth for public preview policy. In particular,
  // an included full overview must never become an anonymous media URL.
  return Boolean(file?.is_previewable);
}

function defaultPreviewFile(files: any[]) {
  return (
    files.find((f) => f.kind === "infographic") ||
    files.find((f) => f.kind === "slide_pdf") ||
    files.find((f) => isPreviewableFile(f)) ||
    null
  );
}

function groupPublicFiles(files: any[]) {
  const groups = [
    { title: "AI 播客", kinds: ["audio_overview", "preview_audio"] },
    { title: "视频概览", kinds: ["video_overview", "preview_video", "poster"] },
    { title: "演示文稿", kinds: ["slide_pdf", "slide_deck"] },
    { title: "信息图", kinds: ["infographic"] },
    { title: "结构材料", kinds: ["blueprint", "prompt", "source_context", "content"] },
    { title: "其他文件", kinds: [] as string[] }
  ];
  const remaining = new Set(files);
  return groups
    .map((group) => {
      const groupFiles = group.kinds.length
        ? files.filter((file) => group.kinds.includes(file.kind))
        : [...remaining];
      groupFiles.forEach((file) => remaining.delete(file));
      return { title: group.title, files: groupFiles };
    })
    .filter((group) => group.files.length > 0);
}

function publicAssetList(files: any[], owned: boolean, listingId: string, activeFilename = "") {
  if (!files.length) return `<div class="empty-state" style="min-height:120px"><p>暂无公开文件</p></div>`;
  return groupPublicFiles(files)
    .map((group) => {
      const items = group.files
        .map((file) => {
          const canPreview = isPreviewableFile(file) || (
            owned && ["audio_overview", "video_overview"].includes(String(file.kind || ""))
          );
          const active = activeFilename && file.filename === activeFilename ? " is-active" : "";
          const previewAttr = canPreview
            ? ` data-preview-file="${esc(file.filename)}" data-preview-kind="${esc(file.kind)}" data-asset-id="${esc(String(file.id || ""))}" data-parent-asset-id="${esc(String(file.parent_asset_id || ""))}"`
            : "";
          const downloadBtn = owned
            ? `<button type="button" class="btn btn-quiet btn-sm" data-download-file="${esc(listingId)}" data-file-name="${esc(file.filename)}">下载</button>`
            : `<button type="button" class="btn btn-quiet btn-sm" data-open-checkout="${esc(listingId)}">获取</button>`;
          return `<li class="asset-row${active}${canPreview ? " is-previewable" : ""}"${previewAttr} title="${esc(file.filename)}">
            <div class="asset-row-main">
              <div class="asset-row-name">${esc(shortAssetName(file.filename))}</div>
              <div class="asset-row-meta">
                <span class="badge">${esc(assetKindLabels[file.kind] || file.kind)}</span>
                <span>${esc(formatBytes(file.size_bytes))}</span>
                ${file.duration_ms ? `<span>${esc(`${Math.round(Number(file.duration_ms) / 1000)} 秒`)}</span>` : ""}
                ${canPreview ? `<span class="asset-hint">点击预览</span>` : `<span class="asset-hint">仅下载</span>`}
              </div>
            </div>
            <div class="asset-row-actions">${downloadBtn}</div>
          </li>`;
        })
        .join("");
      return `<section class="asset-group">
        <div class="asset-group-head"><h3>${esc(group.title)}</h3><span>${group.files.length}</span></div>
        <ul class="asset-list">${items}</ul>
      </section>`;
    })
    .join("");
}

function renderPreviewBody(listing: any, file: any | null, owned: boolean, files: any[] = []) {
  if (!file) {
    return listing.cover_path
      ? `<div class="preview-frame-shell"><img class="cover-art preview-media" src="${coverUrl(listing)}" alt="${esc(listing.title)}封面" /></div>`
      : `<div class="preview-frame-shell"><div class="preview-empty">暂无预览</div></div>`;
  }
  const kind = String(file.kind || "");
  const url = api.previewUrl(listing.id, file.filename);
  if (kind === "infographic" || String(file.filename).match(/\.(png|jpe?g|webp)$/i)) {
    return `<div class="preview-frame-shell" data-preview-ratio="slide">
      <img class="cover-art preview-media" src="${url}" alt="${esc(file.filename)}" />
    </div>`;
  }
  if (kind === "audio_overview" || kind === "preview_audio" || String(file.filename).match(/\.(m4a|mp3|wav|ogg)$/i)) {
    return `<div class="preview-frame-shell" data-preview-ratio="doc">
      <audio class="preview-media" src="${url}" controls preload="metadata" aria-label="${esc(file.filename)}"></audio>
    </div>`;
  }
  if (kind === "video_overview" || kind === "preview_video" || String(file.filename).match(/\.(mp4|webm|mov)$/i)) {
    const poster = files.find((candidate) => candidate.kind === "poster" && candidate.parent_asset_id === file.id);
    const posterAttr = poster ? ` poster="${esc(api.previewUrl(listing.id, poster.filename))}"` : "";
    return `<div class="preview-frame-shell" data-preview-ratio="video">
      <video class="preview-media" src="${url}"${posterAttr} controls preload="metadata" playsinline aria-label="${esc(file.filename)}"></video>
    </div>`;
  }
  if (kind === "slide_pdf" || String(file.filename).toLowerCase().endsWith(".pdf")) {
    return `<div class="preview-frame-shell" data-preview-ratio="slide" data-pdf-url="${esc(url)}" data-pdf-source="pdf">
      ${pdfPagerMarkup("PDF")}
    </div>`;
  }
  if (kind === "slide_deck" || String(file.filename).toLowerCase().endsWith(".pptx")) {
    // PPTX cannot render natively; caller may pair a PDF. Fallback keeps same frame.
    return `<div class="preview-frame-shell" data-preview-ratio="slide">
      <div class="preview-empty">
        <strong>暂无对应 PDF 可翻页预览</strong>
        <span>请选择同主题 PDF，或获取后下载 PPTX。方向键翻页在 PDF 预览中可用。</span>
      </div>
    </div>`;
  }
  if (isTextPreviewFile(file)) {
    const format = isMarkdownFile(file) ? "markdown" : "plain";
    return `<div class="preview-frame-shell" data-preview-ratio="doc">
      <div class="text-preview" data-text-preview data-preview-url="${esc(url)}" data-preview-format="${format}">
        <div class="text-preview-toolbar">
          <div class="seg-tabs text-preview-modes" role="tablist" aria-label="预览模式">
            <button type="button" class="is-active" data-text-mode="render" role="tab" aria-selected="true">渲染</button>
            <button type="button" data-text-mode="source" role="tab" aria-selected="false">源码</button>
          </div>
          <button type="button" class="btn btn-ghost btn-sm" data-text-copy hidden title="复制源码">复制</button>
        </div>
        <div class="text-preview-body" data-text-body>
          <div class="preview-doc-loading">加载预览…</div>
        </div>
      </div>
    </div>`;
  }
  return owned
    ? `<div class="preview-frame-shell" data-preview-ratio="slide"><div class="preview-empty">该文件不支持在线预览，请下载后查看。</div></div>`
    : `<div class="preview-frame-shell" data-preview-ratio="slide"><div class="preview-empty">该文件需获取后下载查看。可先预览信息图 / PDF / 内容稿。</div></div>`;
}

function assetOption(file: any, inputName = "file", preview?: { listingId: string; versionId: string }) {
  const previewDerivative = ["poster", "preview_audio", "preview_video"].includes(String(file.kind || ""));
  const locked = Boolean(file.stripped) || previewDerivative;
  const details = [
    formatBytes(file.size_bytes),
    file.duration_ms ? `${Math.round(Number(file.duration_ms) / 1000)} 秒` : "",
    file.audio_codec ? `音频 ${file.audio_codec}` : "",
    file.video_codec ? `视频 ${file.video_codec}` : "",
    file.variant_group_id ? `版本组 ${shortAssetName(String(file.variant_group_id))}` : "",
    file.source_run_id ? `run ${shortAssetName(String(file.source_run_id))}` : "",
    file.sha256 ? `sha256 ${String(file.sha256).slice(0, 12)}` : "",
    file.preview_policy === "public"
      ? "公开预览"
      : file.entitlement_download
        ? "权益下载"
        : "不公开",
    previewDerivative ? "仅预览" : ""
  ].filter(Boolean);
  const previewLink = preview && !locked
    ? `<a class="btn-admin-ghost btn-sm" href="${api.adminPreviewUrl(preview.listingId, file.filename, preview.versionId)}" target="_blank" rel="noreferrer">预览</a>`
    : "";
  return `<label class="asset-option ${locked ? "is-locked" : ""}">
    <input type="checkbox" name="${inputName}" value="${file.id}" data-file-choice ${file.included && !locked ? "checked" : ""} ${locked ? "disabled" : ""} />
    <span class="asset-option-body">
      <span class="asset-option-name">${esc(file.filename)}</span>
      <span class="asset-option-meta"><span class="badge">${esc(assetKindLabels[file.kind] || file.kind)}</span>${details.map((detail) => `<span>${esc(detail)}</span>`).join("")}${file.stripped ? "<span>已剥离</span>" : ""}</span>
    </span>
    ${previewLink}
  </label>`;
}

function assetPicker(files: any[], inputName = "file", preview?: { listingId: string; versionId: string }) {
  const available = files.filter(
    (file) => !file.stripped && !["poster", "preview_audio", "preview_video"].includes(String(file.kind || ""))
  );
  const selected = available.filter((file) => file.included).length;
  const remaining = new Set(files);
  const groups = assetGroupOrder
    .map((group) => {
      const groupFiles = group.kinds.length
        ? files.filter((file) => group.kinds.includes(file.kind))
        : [...remaining];
      groupFiles.forEach((file) => remaining.delete(file));
      if (!groupFiles.length) return "";
      const groupedByVariant = new Map<string, any[]>();
      const ungrouped = groupFiles.filter((file) => !file.variant_group_id);
      for (const file of groupFiles) {
        const variantGroup = String(file.variant_group_id || "");
        if (!variantGroup) continue;
        const members = groupedByVariant.get(variantGroup) ?? [];
        members.push(file);
        groupedByVariant.set(variantGroup, members);
      }
      const versionChoices = [...groupedByVariant.entries()]
        .map(([variantGroup, members]) => `<div class="asset-variant-group">
          <div class="asset-variant-group-head"><span>版本选择</span><code>${esc(variantGroup)}</code><span>${members.length} 项</span></div>
          <div class="asset-file-grid">${members.map((file) => assetOption(file, inputName, preview)).join("")}</div>
        </div>`)
        .join("");
      const ungroupedChoices = ungrouped.length
        ? `<div class="asset-file-grid">${ungrouped.map((file) => assetOption(file, inputName, preview)).join("")}</div>`
        : "";
      return `<section class="asset-file-group">
        <div class="asset-file-group-head"><h3>${group.title}</h3><span>${groupFiles.length} 项</span></div>
        ${versionChoices}${ungroupedChoices}
      </section>`;
    })
    .join("");

  return `<section class="asset-picker" aria-labelledby="asset-picker-title">
    <div class="asset-picker-head">
      <div><h2 id="asset-picker-title">发布文件</h2><p>选择将随 Listing 对外提供的资产。</p></div>
      <div class="asset-picker-tools">
        <span data-file-selection-count>${selected} / ${available.length} 已选</span>
        <button type="button" data-file-select="all">全选</button>
        <button type="button" data-file-select="none">清空</button>
      </div>
    </div>
    <div class="file-check">${groups}</div>
  </section>`;
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
      <div class="section-head"><div><h2>主题墙</h2><p>覆盖常用知识场景，持续策展</p></div><a class="btn btn-quiet" href="#/topics">全部主题</a></div>
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
      <div class="section-head"><div><h2>主题墙</h2><p>一级受控主题 · 覆盖常用知识场景</p></div></div>
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
          <div>
            <h3 class="rank-title">${esc(w.title)}</h3>
            <p class="rank-meta">${esc(w.author_name || "")}</p>
            ${(w.tags || []).length ? `<div class="chips rank-tags">${tagChips(w.tags, 3)}</div>` : ""}
          </div>
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
      owned =
        ents.entitlements.some((e: any) => e.listing_id === id) ||
        listing.price_credits === 0 ||
        state.user.role === "admin";
    } catch {
      owned = listing.price_credits === 0 || state.user?.role === "admin";
    }
  } else {
    owned = listing.price_credits === 0;
  }

  const previewable = files.filter((f: any) => isPreviewableFile(f));
  const initial = defaultPreviewFile(files);
  const activeName = initial?.filename || "";
  const primary = owned
    ? `<button class="btn btn-primary btn-block" type="button" data-download="${listing.id}">打包下载</button>`
    : `<button class="btn btn-primary btn-block" type="button" data-open-checkout="${listing.id}">使用 ${listing.price_credits} credits 获取下载权</button>`;

  const sheet =
    checkout && !owned && listing.price_credits > 0
      ? `<div class="sheet-backdrop" data-close-checkout>
          <div class="sheet" role="dialog" aria-modal="true">
            <h2>确认获取</h2>
            <p style="margin:0;color:var(--muted)">支付后可下载全部资源文件</p>
            <div class="sheet-row"><span>作品</span><strong>${esc(listing.title)}</strong></div>
            <div class="sheet-row"><span>文件</span><strong class="num">${files.length} 个</strong></div>
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
      <section class="preview-stage" data-preview-root data-listing-id="${esc(listing.id)}" data-owned="${owned ? "1" : "0"}">
        <div class="preview-body" data-preview-body>
          ${renderPreviewBody(listing, initial, owned, files)}
        </div>
        <div class="preview-caption">
          <div class="preview-caption-main">
            <span class="preview-kicker">${owned ? "已获取" : "免费预览"}</span>
            <span data-preview-label>${initial ? esc(shortAssetName(initial.filename)) : "封面预览"}</span>
          </div>
          <div class="preview-caption-actions">
            <button type="button" class="icon-btn preview-fs-btn" data-preview-fullscreen title="全屏 (F)" aria-label="全屏预览" aria-pressed="false">${fullscreenEnterIcon}</button>
            ${owned ? "" : `<span class="preview-caption-meta">可预览 ${previewable.length} 项 · 下载需 ${listing.price_credits} credits</span>`}
          </div>
        </div>
      </section>
      <aside class="buy-rail">
        <div class="buy-rail-top">
          <div class="chips">${(listing.tags || []).map((t: string) => `<span class="chip">${esc(t)}</span>`).join("")}</div>
          <h1>${esc(listing.title)}</h1>
          <p class="buy-summary">${esc(listing.summary)}</p>
          <div class="buy-price">
            <div>
              <div class="buy-label">价格</div>
              <div class="amount num">${esc(priceLabel(listing.price_credits))}</div>
            </div>
            <div class="buy-stats">
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
        </div>
        <div class="asset-panel">
          <div class="asset-panel-head">
            <div>
              <h2>资源清单</h2>
              <p>唯一入口：点文件预览，按类型下载</p>
            </div>
            <span>${files.length}</span>
          </div>
          ${publicAssetList(files, owned, listing.id, activeName)}
        </div>
        <div class="source-note">作者 ${esc(listing.author_name || "")} · Generated with Video2PPT · <a href="#/copyright">授权与下架说明</a></div>
        ${
          state.user
            ? `<details class="report-disclosure"><summary>举报此资源</summary>
          <form class="report-form" data-report="${listing.id}">
            <select name="reason" aria-label="举报原因"><option value="copyright">版权或授权</option><option value="unsafe">不安全内容</option><option value="misleading">误导信息</option><option value="other">其他</option></select>
            <textarea name="detail" maxlength="1000" placeholder="补充说明" required></textarea>
            <button class="btn btn-ghost btn-sm" type="submit">提交举报</button>
          </form></details>`
            : ""
        }
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
    <a href="#/admin/llm" class="${active === "llm" ? "is-active" : ""}">模型配置</a>
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
      <h1>导入资源站导出包</h1>
      <p class="lead">支持 resource-gallery.export/v1 与 v2；仅管理员可导入，失败不留下可见版本。</p>
      <label class="dropzone">
        <strong>选择 zip 上传</strong>
        <span>manifest.json + task_meta.json + run_meta.json + files/（v2 可含 preview/）</span>
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
    const { listings, draft_count: draftCount } = await api.adminListings();
    return `<div class="admin-layout">${adminNav("listings")}<div class="admin-main">
      <section class="admin-card">
        <div class="admin-card-head">
          <div>
            <h1>Listing</h1>
            <p class="lead">${draftCount} 个草稿 · ${listings.length} 个条目</p>
          </div>
          <button class="btn-admin" type="button" data-publish-all data-draft-count="${draftCount}" ${draftCount === 0 ? "disabled" : ""}>
            全部发布${draftCount > 0 ? `（${draftCount}）` : ""}
          </button>
        </div>
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
  const draftVersion = (data.versions || []).find((version: any) => version.status === "draft");
  const versionAssets = draftVersion
    ? (data.assets || []).filter((asset: any) => asset.version_id === draftVersion.id)
    : [];
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
        ${draftVersion ? `<input type="hidden" name="version_id" value="${esc(draftVersion.id)}" />${assetPicker(versionAssets, "asset", { listingId: id, versionId: draftVersion.id })}` : assetPicker(data.files || [])}
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

async function pageAdminLlm() {
  if (state.user?.role !== "admin") return `<div class="container page">${empty("需要管理员登录", "去登录", "#/me")}</div>`;
  const { settings } = await api.adminLlmSettings();
  return `<div class="admin-layout">${adminNav("llm")}<div class="admin-main">
    <section class="admin-card">
      <div class="admin-card-head">
        <div>
          <h1>摘要与内容标签模型配置</h1>
          <p class="lead">统一配置 OpenAI 兼容模型；摘要和内容语义标签共用主模型、备用模型与本地 fallback 降级链。</p>
        </div>
        <span class="badge ${settings.api_key_configured ? "ok" : "warn"}">${settings.api_key_configured ? "密钥已配置" : "尚未配置密钥"}</span>
      </div>
      <form class="admin-form llm-settings-form" data-llm-settings>
        <label class="checkbox-row"><input name="enabled" type="checkbox" ${settings.enabled ? "checked" : ""} />启用模型摘要</label>
        <div class="config-grid">
          <label>服务类型<input name="provider" value="${esc(settings.provider)}" required /></label>
          <label>API Base URL<input name="api_base" type="url" value="${esc(settings.api_base)}" placeholder="https://api.openai.com/v1" required /></label>
        </div>
        <label>API Key
          <input name="api_key" type="password" value="" autocomplete="new-password" placeholder="${settings.api_key_configured ? "已安全保存；留空不修改" : "输入模型 API Key"}" />
        </label>
        <div class="llm-model-picker" data-llm-model-picker>
          <div class="llm-model-picker-head">
            <div>
              <strong>模型选择</strong>
              <p>获取服务端模型列表后勾选所需模型，再指定其中一个为主模型；其余自动作为备用模型。</p>
            </div>
            <button class="btn-admin-ghost" type="button" data-llm-load-models>获取模型列表</button>
          </div>
          <div class="config-grid llm-model-picker-controls">
            <label>主模型
              <select name="model" data-llm-primary required>
                ${settings.model
                  ? `<option value="${esc(settings.model)}">${esc(settings.model)}</option>`
                  : `<option value="">请先勾选模型</option>`}
              </select>
            </label>
            <label>筛选模型<input type="search" data-llm-model-search placeholder="输入模型名称" /></label>
          </div>
          <input name="fallback_models" type="hidden" value="${esc(settings.fallback_models.join(","))}" />
          <p class="llm-model-selection" data-llm-model-selection></p>
          <div class="llm-model-options" data-llm-model-options></div>
          <div class="llm-model-manual">
            <input type="text" data-llm-manual-model placeholder="模型列表不完整时，可手工输入模型 ID" />
            <button class="btn-admin-ghost" type="button" data-llm-add-model>添加</button>
          </div>
          <p class="form-hint" data-llm-model-list-status>${settings.api_key_configured
            ? "密钥已配置，可直接获取模型列表；页面中输入的新密钥也可用于本次获取。"
            : "请先填写 Base URL 和 API Key，再获取模型列表。"}</p>
        </div>
        <div class="config-grid">
          <label>超时（毫秒）<input name="timeout_ms" type="number" min="1000" max="300000" step="1000" value="${settings.timeout_ms}" required /></label>
          <label>Temperature<input name="temperature" type="number" min="0" max="2" step="0.1" value="${settings.temperature}" required /></label>
          <label>Max Tokens<input name="max_tokens" type="number" min="32" max="8192" step="1" value="${settings.max_tokens}" required /></label>
        </div>
        <div class="admin-actions">
          <button class="btn-admin" type="submit">保存并应用</button>
          <button class="btn-admin-ghost" type="button" data-llm-test>测试已配置模型</button>
          <button class="btn-admin-ghost" type="button" data-summary-backfill>补偿历史摘要</button>
          <button class="btn-admin-ghost" type="button" data-tags-backfill>重建内容标签</button>
        </div>
        <p class="form-hint" data-llm-status>API Key 不会回显；保存新配置后会在后台升级未锁定的 fallback/failed 摘要和内容标签。</p>
      </form>
    </section>
  </div></div>`;
}

function pageTerms(kind: "terms" | "copyright") {
  if (kind === "terms") {
  return `<div class="container page legal-page"><h1>用户协议</h1><p>本站分发运营审核后的知识资产导出包。注册用户仅可在授权范围内浏览、点赞与下载，不得绕过权限、转售认证材料或利用本站传播违法内容。</p><h2>Credits</h2><p>Credits 是站内获取额度，不对应法币，不支持提现。订单与账户变动记录在不可变流水中。</p><h2>内容边界</h2><p>一期仅由运营导入与上架，注册用户没有发布入口。资源来源说明不代表来源平台对衍生内容背书。来源视频、原始字幕和认证材料不会进入公开资源包；可分发的 AI 播客、视频概览及其预览衍生物必须经过运营审核。</p></div>`;
  }
  return `<div class="container page legal-page"><h1>授权与侵权下架</h1><p>导入包默认剥离 cookies、凭据、来源视频和原始字幕；只有经过校验的核心资料、生成媒体及合规预览衍生物可进入运营审核。运营发布前需确认内容授权范围和可分发文件清单。</p><h2>提交举报</h2><p>登录后可在资源详情提交版权、危险内容或误导信息举报。运营会记录处理结果，并可将资源下架；既有购买权益按一期策略保留。</p><h2>必要信息</h2><p>举报说明应包含资源名称、权利基础、争议范围及可联系信息。请勿在说明中提交账号密码、cookies 或其他认证材料。</p></div>`;
}

async function render() {
  const route = parseRoute();
  destroyActivePdfViewer();
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
      else if (p[1] === "llm") html = await pageAdminLlm();
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
  const updateFileSelectionCount = () => {
    const choices = [...document.querySelectorAll<HTMLInputElement>("[data-file-choice]:not(:disabled)")];
    const selected = choices.filter((choice) => choice.checked).length;
    document.querySelectorAll("[data-file-selection-count]").forEach((el) => {
      el.textContent = `${selected} / ${choices.length} 已选`;
    });
  };

  document.querySelectorAll<HTMLInputElement>("[data-file-choice]").forEach((choice) => {
    choice.addEventListener("change", updateFileSelectionCount);
  });

  document.querySelectorAll<HTMLButtonElement>("[data-file-select]").forEach((button) => {
    button.addEventListener("click", () => {
      const checked = button.dataset.fileSelect === "all";
      document.querySelectorAll<HTMLInputElement>("[data-file-choice]:not(:disabled)").forEach((choice) => {
        choice.checked = checked;
      });
      updateFileSelectionCount();
    });
  });

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

  document.querySelectorAll("[data-download-file]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const listingId = btn.getAttribute("data-download-file")!;
      const fileName = btn.getAttribute("data-file-name") || "";
      try {
        const r = await api.downloadToken(listingId, fileName || undefined);
        window.open(r.url, "_blank");
      } catch (e) {
        const msg = e instanceof Error ? e.message : "下载失败";
        if (msg.includes("no entitlement") || msg.includes("login")) {
          toast("请先获取下载权");
          navigate(`/work/${listingId}/checkout`);
          return;
        }
        toast(msg);
      }
    })
  );

  function findPairedVisual(filename: string, kind: string) {
    if (kind !== "slide_deck" && !filename.toLowerCase().endsWith(".pptx")) return null;
    const root = document.querySelector("[data-preview-root]") as HTMLElement | null;
    if (!root) return null;
    // Prefer same-stem PDF/PNG buttons already rendered in the preview thumbs / asset rows.
    const stem = filename.replace(/\.pptx$/i, "");
    const candidates = [
      ...document.querySelectorAll<HTMLElement>("[data-preview-file]")
    ]
      .map((el) => ({
        filename: el.getAttribute("data-preview-file") || "",
        kind: el.getAttribute("data-preview-kind") || ""
      }))
      .filter((item) => item.filename && item.filename !== filename);

    const sameStemPdf = candidates.find(
      (item) => item.kind === "slide_pdf" && item.filename.replace(/\.pdf$/i, "") === stem
    );
    if (sameStemPdf) return sameStemPdf;
    const sameStemPng = candidates.find(
      (item) =>
        (item.kind === "infographic" || /\.(png|jpe?g|webp)$/i.test(item.filename)) &&
        item.filename.replace(/\.(png|jpe?g|webp)$/i, "") === stem
    );
    if (sameStemPng) return sameStemPng;

    // Fallback: shared title prefix before common separators.
    const prefix = stem.split(/[-_#]|SlideDeck/i)[0]?.trim();
    if (prefix && prefix.length >= 6) {
      const byPrefixPdf = candidates.find(
        (item) => item.kind === "slide_pdf" && item.filename.includes(prefix)
      );
      if (byPrefixPdf) return byPrefixPdf;
      const byPrefixPng = candidates.find(
        (item) => item.kind === "infographic" && item.filename.includes(prefix)
      );
      if (byPrefixPng) return byPrefixPng;
    }
    return null;
  }

  async function applyPreview(filename: string, kind: string) {
    const root = document.querySelector("[data-preview-root]") as HTMLElement | null;
    const body = document.querySelector("[data-preview-body]") as HTMLElement | null;
    const label = document.querySelector("[data-preview-label]") as HTMLElement | null;
    if (!root || !body) return;
    const listingId = root.getAttribute("data-listing-id") || "";
    const owned = root.getAttribute("data-owned") === "1";
    const paired = findPairedVisual(filename, kind);
    const file = paired || { filename, kind };
    const files = [...document.querySelectorAll<HTMLElement>("[data-preview-file]")].map((element) => ({
      id: element.getAttribute("data-asset-id") || "",
      filename: element.getAttribute("data-preview-file") || "",
      kind: element.getAttribute("data-preview-kind") || "",
      parent_asset_id: element.getAttribute("data-parent-asset-id") || null,
      is_previewable: true
    }));
    body.innerHTML = renderPreviewBody({ id: listingId, title: filename, cover_path: null }, file, owned, files);
    if (label) {
      label.textContent = paired
        ? `${shortAssetName(filename)} · 对应 PDF 翻页预览`
        : shortAssetName(filename);
    }
    document.querySelectorAll(".asset-row[data-preview-file]").forEach((el) => {
      el.classList.toggle("is-active", el.getAttribute("data-preview-file") === filename);
    });
    hydratePreviewExtras(body);
  }

  document.querySelectorAll("[data-preview-file]").forEach((el) =>
    el.addEventListener("click", (event) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("[data-download-file], [data-open-checkout]")) return;
      const filename = el.getAttribute("data-preview-file") || "";
      const kind = el.getAttribute("data-preview-kind") || "";
      applyPreview(filename, kind);
    })
  );

  const previewBody = document.querySelector("[data-preview-body]") as HTMLElement | null;
  if (previewBody) hydratePreviewExtras(previewBody);
  document.querySelectorAll("[data-preview-fullscreen]").forEach((btn) => {
    btn.addEventListener("click", () => {
      void togglePreviewFullscreen();
    });
  });

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
      const includedFiles = [...(form as HTMLFormElement).querySelectorAll('input[name="file"]:checked')].map(
        (x) => (x as HTMLInputElement).value
      );
      const includedAssets = [...(form as HTMLFormElement).querySelectorAll('input[name="asset"]:checked')].map(
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
          included_file_ids: includedFiles,
          included_asset_ids: includedAssets,
          version_id: fd.get("version_id") || undefined
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

  document.querySelectorAll<HTMLButtonElement>("[data-publish-all]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const draftCount = Number(btn.dataset.draftCount || 0);
      if (draftCount === 0) return;
      if (!window.confirm(`确认发布全部 ${draftCount} 个草稿？发布后将在画廊公开展示。`)) return;

      btn.disabled = true;
      try {
        const result = await api.adminPublishAll();
        const message = result.skipped_count
          ? `已发布 ${result.published_count} 个，跳过 ${result.skipped_count} 个无可用文件草稿`
          : `已发布 ${result.published_count} 个草稿`;
        toast(message);
        render();
      } catch (e) {
        btn.disabled = false;
        toast(e instanceof Error ? e.message : "批量发布失败");
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

  document.querySelectorAll<HTMLFormElement>("form[data-llm-settings]").forEach((form) => {
    const status = form.querySelector<HTMLElement>("[data-llm-status]");
    const setStatus = (message: string) => {
      if (status) status.textContent = message;
    };
    const primarySelect = form.elements.namedItem("model") as HTMLSelectElement | null;
    const fallbackInput = form.elements.namedItem("fallback_models") as HTMLInputElement | null;
    const modelOptions = form.querySelector<HTMLElement>("[data-llm-model-options]");
    const modelSearch = form.querySelector<HTMLInputElement>("[data-llm-model-search]");
    const modelSelection = form.querySelector<HTMLElement>("[data-llm-model-selection]");
    const modelListStatus = form.querySelector<HTMLElement>("[data-llm-model-list-status]");
    const manualModel = form.querySelector<HTMLInputElement>("[data-llm-manual-model]");
    const configuredPrimary = primarySelect?.value.trim() ?? "";
    const configuredFallbacks = String(fallbackInput?.value ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    let selectedModelIds = Array.from(new Set([configuredPrimary, ...configuredFallbacks].filter(Boolean)));
    let primaryModelId = configuredPrimary;
    let discoveredModels: SummaryLlmModel[] = selectedModelIds.map((id) => ({ id, name: id, ownedBy: "" }));
    let modelTestResults = new Map<string, { ok: boolean; message: string }>();

    const syncModelFields = () => {
      if (!selectedModelIds.includes(primaryModelId)) primaryModelId = selectedModelIds[0] ?? "";
      if (primarySelect) {
        const options = selectedModelIds.length
          ? selectedModelIds.map((id) => new Option(id, id))
          : [new Option("请先勾选模型", "")];
        primarySelect.replaceChildren(...options);
        primarySelect.value = primaryModelId;
        primarySelect.disabled = selectedModelIds.length === 0;
      }
      if (fallbackInput) {
        fallbackInput.value = selectedModelIds.filter((id) => id !== primaryModelId).join(",");
      }
      if (modelSelection) {
        const fallbackCount = Math.max(0, selectedModelIds.length - (primaryModelId ? 1 : 0));
        modelSelection.textContent = selectedModelIds.length
          ? `已选择 ${selectedModelIds.length} 个模型：1 个主模型，${fallbackCount} 个备用模型`
          : "尚未选择模型";
      }
    };

    const renderModelPicker = () => {
      syncModelFields();
      if (!modelOptions) return;
      const query = modelSearch?.value.trim().toLowerCase() ?? "";
      const visibleModels = discoveredModels.filter((model) => {
        const text = `${model.id} ${model.name} ${model.ownedBy}`.toLowerCase();
        return !query || text.includes(query);
      });
      if (visibleModels.length === 0) {
        const emptyState = document.createElement("p");
        emptyState.className = "llm-model-empty";
        emptyState.textContent = discoveredModels.length
          ? "没有匹配的模型"
          : "获取模型列表后，可在这里勾选主、备模型";
        modelOptions.replaceChildren(emptyState);
        return;
      }
      modelOptions.replaceChildren(...visibleModels.map((model) => {
        const label = document.createElement("label");
        label.className = "llm-model-option";
        if (selectedModelIds.includes(model.id)) label.classList.add("is-selected");

        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = selectedModelIds.includes(model.id);
        checkbox.setAttribute("aria-label", `选择模型 ${model.id}`);
        checkbox.addEventListener("change", () => {
          if (checkbox.checked) {
            selectedModelIds = Array.from(new Set([...selectedModelIds, model.id]));
            if (!primaryModelId) primaryModelId = model.id;
          } else {
            selectedModelIds = selectedModelIds.filter((id) => id !== model.id);
            if (primaryModelId === model.id) primaryModelId = selectedModelIds[0] ?? "";
          }
          renderModelPicker();
        });

        const body = document.createElement("span");
        body.className = "llm-model-option-body";
        const name = document.createElement("strong");
        name.textContent = model.name || model.id;
        const id = document.createElement("code");
        id.textContent = model.id;
        body.append(name, id);
        if (model.ownedBy) {
          const owner = document.createElement("small");
          owner.textContent = model.ownedBy;
          body.append(owner);
        }

        label.append(checkbox, body);
        if (selectedModelIds.includes(model.id)) {
          const meta = document.createElement("span");
          meta.className = "llm-model-meta";

          const role = document.createElement("span");
          role.className = `llm-model-role ${model.id === primaryModelId ? "is-primary" : ""}`;
          role.textContent = model.id === primaryModelId ? "主" : "备";
          meta.append(role);

          const testResult = modelTestResults.get(model.id);
          if (testResult) {
            const health = document.createElement("span");
            health.className = `llm-model-health ${testResult.ok ? "is-ok" : "is-failed"}`;
            health.textContent = testResult.ok ? "正常" : "失败";
            health.title = testResult.message;
            health.setAttribute("aria-label", `${model.id}：${testResult.ok ? "正常" : "失败"}，${testResult.message}`);
            meta.append(health);
          }
          label.append(meta);
        }
        return label;
      }));
    };

    primarySelect?.addEventListener("change", () => {
      primaryModelId = primarySelect.value;
      renderModelPicker();
    });
    modelSearch?.addEventListener("input", renderModelPicker);

    const addManualModel = () => {
      const modelId = manualModel?.value.trim() ?? "";
      if (!modelId) return;
      if (modelId.length > 200) {
        setStatus("模型 ID 不能超过 200 个字符");
        return;
      }
      if (!discoveredModels.some((model) => model.id === modelId)) {
        discoveredModels = [{ id: modelId, name: modelId, ownedBy: "手工添加" }, ...discoveredModels];
      }
      selectedModelIds = Array.from(new Set([...selectedModelIds, modelId]));
      if (!primaryModelId) primaryModelId = modelId;
      if (manualModel) manualModel.value = "";
      renderModelPicker();
    };
    form.querySelector("[data-llm-add-model]")?.addEventListener("click", addManualModel);
    manualModel?.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      addManualModel();
    });
    renderModelPicker();

    const invalidateModelTestResults = () => {
      if (modelTestResults.size === 0) return;
      modelTestResults = new Map();
      renderModelPicker();
    };
    form.querySelectorAll<HTMLInputElement>(
      'input[name="provider"], input[name="api_base"], input[name="api_key"], input[name="timeout_ms"]'
    ).forEach((input) => input.addEventListener("input", invalidateModelTestResults));

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const data = new FormData(form);
      const apiKey = String(data.get("api_key") || "").trim();
      const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]');
      if (submit) submit.disabled = true;
      setStatus("正在保存配置…");
      try {
        const result = await api.adminUpdateLlmSettings({
          enabled: data.get("enabled") === "on",
          provider: String(data.get("provider") || ""),
          api_base: String(data.get("api_base") || ""),
          ...(apiKey ? { api_key: apiKey } : {}),
          model: String(data.get("model") || ""),
          fallback_models: String(data.get("fallback_models") || "")
            .split(/[,\n]/)
            .map((item) => item.trim())
            .filter(Boolean),
          timeout_ms: Number(data.get("timeout_ms")),
          temperature: Number(data.get("temperature")),
          max_tokens: Number(data.get("max_tokens"))
        });
        const keyInput = form.elements.namedItem("api_key") as HTMLInputElement | null;
        if (keyInput) {
          keyInput.value = "";
          keyInput.placeholder = result.settings.api_key_configured
            ? "已安全保存；留空不修改"
            : "输入模型 API Key";
        }
        const message = result.backfill_scheduled
          ? "配置已生效，历史 fallback/failed 摘要已进入后台补偿队列。"
          : "配置已生效；当前未启用模型补偿。";
        setStatus(message);
        toast("模型配置已保存");
      } catch (error) {
        const message = error instanceof Error ? error.message : "模型配置保存失败";
        setStatus(message);
        toast(message);
      } finally {
        if (submit) submit.disabled = false;
      }
    });

    form.querySelector<HTMLButtonElement>("[data-llm-load-models]")?.addEventListener("click", async (event) => {
      const button = event.currentTarget as HTMLButtonElement;
      setStatus("正在读取模型列表…");
      if (modelListStatus) modelListStatus.textContent = "正在连接模型服务并读取列表…";
      button.disabled = true;
      try {
        const data = new FormData(form);
        const pendingApiKey = String(data.get("api_key") || "").trim();
        const { models } = await api.adminLlmModels({
          api_base: String(data.get("api_base") || "").trim(),
          ...(pendingApiKey ? { api_key: pendingApiKey } : {}),
          timeout_ms: Number(data.get("timeout_ms"))
        });
        const merged = new Map(discoveredModels.map((model) => [model.id, model]));
        for (const model of models) merged.set(model.id, model);
        discoveredModels = [...merged.values()];
        renderModelPicker();
        const message = `已获取 ${models.length} 个模型，请勾选需要使用的主、备模型。`;
        setStatus(message);
        if (modelListStatus) modelListStatus.textContent = message;
      } catch (error) {
        const message = error instanceof Error ? error.message : "模型列表加载失败";
        setStatus(message);
        if (modelListStatus) modelListStatus.textContent = message;
      } finally {
        button.disabled = false;
      }
    });

    form.querySelector("[data-llm-test]")?.addEventListener("click", async () => {
      const selectedModels = Array.from(new Set([
        String(primarySelect?.value || "").trim(),
        ...String(fallbackInput?.value || "").split(",").map((item) => item.trim())
      ].filter(Boolean)));
      modelTestResults = new Map();
      renderModelPicker();
      setStatus(`正在测试 ${selectedModels.length || "已配置"} 个模型…`);
      try {
        const result = await api.adminTestLlm();
        modelTestResults = new Map(result.results.map((item) => [item.model, {
          ok: item.ok,
          message: item.message
        }]));
        renderModelPicker();
        const passed = result.results.filter((item) => item.ok).length;
        const details = result.results
          .map((item) => `${item.model}：${item.ok ? `正常（${item.message}）` : `失败（${item.message}）`}`)
          .join("；");
        setStatus(`${result.ok ? "全部模型连接正常" : `已完成：${passed}/${result.results.length} 个模型通过`} · ${details}`);
        toast(result.ok ? "全部模型连接正常" : `${passed}/${result.results.length} 个模型连接正常`);
      } catch (error) {
        const message = error instanceof Error ? error.message : "模型连接失败";
        modelTestResults = new Map(selectedModels.map((model) => [model, { ok: false, message }]));
        renderModelPicker();
        setStatus(message);
        toast(message);
      }
    });

    form.querySelector("[data-summary-backfill]")?.addEventListener("click", async () => {
      setStatus("正在补偿历史摘要…");
      try {
        const result = await api.adminBackfillSummaries();
        setStatus(`补偿完成：扫描 ${result.scanned} 条，更新 ${result.updated} 条。`);
        toast("历史摘要补偿完成");
      } catch (error) {
        const message = error instanceof Error ? error.message : "历史摘要补偿失败";
        setStatus(message);
        toast(message);
      }
    });

    form.querySelector("[data-tags-backfill]")?.addEventListener("click", async () => {
      setStatus("正在依据正文重建内容标签…");
      try {
        const result = await api.adminBackfillTags();
        setStatus(`内容标签已重建：扫描 ${result.scanned} 个，更新 ${result.updated} 个。`);
        toast("内容标签重建完成");
      } catch (error) {
        setStatus(error instanceof Error ? error.message : "内容标签重建失败");
      }
    });
  });

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
