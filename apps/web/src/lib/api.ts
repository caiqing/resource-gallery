export type User = {
  id: string;
  email: string;
  display_name: string;
  role: "user" | "admin";
};

export type Account = {
  balance: number;
  pending_earnings: number;
  lifetime_spent: number;
  lifetime_earned: number;
};

export type Listing = {
  id: string;
  title: string;
  summary: string;
  cover_path: string | null;
  author_name?: string;
  price_tier: string;
  price_credits: number;
  status: string;
  like_count: number;
  download_count: number;
  published_at?: string | null;
  tags: string[];
};

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const res = await fetch(path, {
    ...init,
    headers,
    credentials: "include"
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as any).error || `HTTP ${res.status}`);
  }
  return data as T;
}

export const api = {
  health: () => request<{ ok: boolean }>("/api/../health".replace("/api/../health", "/health")).catch(async () => {
    const r = await fetch("/health");
    return r.json();
  }),
  me: () => request<{ user: User | null; account: Account | null }>("/api/auth/me"),
  login: (email: string, password: string) =>
    request<{ user: User }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password })
    }),
  register: (email: string, password: string, display_name?: string) =>
    request<{ user: User }>("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ email, password, display_name })
    }),
  logout: () => request<{ ok: boolean }>("/api/auth/logout", { method: "POST" }),
  topics: () => request<{ topics: { id: string; name: string; description: string }[] }>("/api/topics"),
  listings: (params?: { q?: string; topic?: string; page?: number; limit?: number }) => {
    const sp = new URLSearchParams();
    if (params?.q) sp.set("q", params.q);
    if (params?.topic) sp.set("topic", params.topic);
    if (params?.page) sp.set("page", String(params.page));
    if (params?.limit) sp.set("limit", String(params.limit));
    const q = sp.toString();
    return request<{
      listings: Listing[];
      pagination: { page: number; limit: number; total: number; pages: number };
    }>(`/api/listings${q ? `?${q}` : ""}`);
  },
  listing: (id: string) =>
    request<{ listing: Listing; files: any[] }>(`/api/listings/${id}`),
  rank: (metric: "likes" | "downloads", period: "day" | "week" | "all") =>
    request<{ items: any[]; metric: string; period: string }>(
      `/api/rank?metric=${metric}&period=${period}`
    ),
  toggleLike: (id: string) =>
    request<{ liked: boolean }>(`/api/me/likes/${id}`, { method: "POST" }),
  likes: () => request<{ likes: any[] }>("/api/me/likes"),
  entitlements: () => request<{ entitlements: any[] }>("/api/me/entitlements"),
  ledger: () => request<{ entries: any[] }>("/api/me/ledger"),
  updateProfile: (display_name: string) =>
    request<{ user: User }>("/api/me/profile", {
      method: "PATCH",
      body: JSON.stringify({ display_name })
    }),
  checkout: (id: string) =>
    request<any>(`/api/me/listings/${id}/checkout`, { method: "POST" }),
  downloadToken: (id: string) =>
    request<{ token: string; url: string }>(`/api/me/listings/${id}/download-token`, {
      method: "POST"
    }),
  share: (id: string) =>
    request<{ slug: string; path: string; public_path: string }>(`/api/me/listings/${id}/share`, { method: "POST" }),
  shareGet: (slug: string) => request<{ share: any }>(`/api/share/${slug}`),
  report: (id: string, reason: string, detail: string) =>
    request<{ id: string; status: string }>(`/api/me/listings/${id}/report`, {
      method: "POST",
      body: JSON.stringify({ reason, detail })
    }),
  adminOverview: () => request<any>("/api/admin/overview"),
  adminJobs: () => request<{ jobs: any[] }>("/api/admin/import-jobs"),
  adminImport: (file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return request<{ job: any }>("/api/admin/import-jobs", { method: "POST", body: fd });
  },
  adminListings: () => request<{ listings: any[] }>("/api/admin/listings"),
  adminListing: (id: string) => request<any>(`/api/admin/listings/${id}`),
  adminPatchListing: (id: string, body: any) =>
    request<any>(`/api/admin/listings/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body)
    }),
  adminPublish: (id: string) =>
    request<any>(`/api/admin/listings/${id}/publish`, { method: "POST" }),
  adminGrant: (email: string, amount: number, note?: string) =>
    request<any>("/api/admin/credits/grant", {
      method: "POST",
      body: JSON.stringify({ email, amount, note })
    }),
  adminUsers: () => request<{ users: any[] }>("/api/admin/users"),
  adminAudits: () => request<{ logs: any[] }>("/api/admin/audit-logs"),
  adminReports: (status = "open") =>
    request<{ reports: any[] }>(`/api/admin/reports?status=${encodeURIComponent(status)}`),
  adminResolveReport: (id: string, body: any) =>
    request<any>(`/api/admin/reports/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  adminPriceTiers: () => request<{ tiers: any[] }>("/api/admin/price-tiers"),
  adminPatchPriceTier: (id: string, label: string, credits: number) =>
    request<any>(`/api/admin/price-tiers/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ label, credits })
    }),
  adminRevenueShares: () => request<{ configs: any[] }>("/api/admin/revenue-share"),
  adminCreateRevenueShare: (author_share_bps: number, platform_share_bps: number) =>
    request<any>("/api/admin/revenue-share", {
      method: "POST",
      body: JSON.stringify({ author_share_bps, platform_share_bps })
    })
};

export function coverUrl(listing: { id: string; cover_path?: string | null }) {
  return `/api/downloads/${listing.id}/cover`;
}

export function priceLabel(n: number) {
  return n === 0 ? "免费" : `${n} credits`;
}
