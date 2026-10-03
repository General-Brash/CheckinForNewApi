// ===== NewAPI 中转站一键签到 - 后台 Service Worker =====
// 原理：直接用 host 权限跨域调用目标站 /api/user/checkin，无需任何服务端代理。
//   GET  /api/user/checkin?month=YYYY-MM  -> 获取签到开关/额度上下限/本月统计
//   POST /api/user/checkin               -> 执行当日签到
//   鉴权：Authorization: Bearer <系统访问令牌/PAT>，令牌唯一标识用户。

importScripts("auth-config.js");
const AUTH_CONFIG = globalThis.NACheckinAuth;

const KEY_PLATFORMS = "nacheckin.platforms";
const KEY_SETTINGS = "nacheckin.settings";
const KEY_LASTAUTO = "nacheckin.lastAuto";
const KEY_AUTOSTATE = "nacheckin.autoState";
const KEY_AGENTROUTER_REAUTH = "nacheckin.agentRouterReauth";
const ALARM_NAME = "nacheckin.auto";
const OAUTH_ALARM_NAME = "nacheckin.oauth";
const DEFAULT_KEEPALIVE_MODEL = "deepseek v4 flash";
const KEEPALIVE_FORMATS = ["chat", "message", "response"];
const KEEPALIVE_PATHS = { chat: "/v1/chat/completions", message: "/v1/messages", response: "/v1/responses" };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function todayStr() {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
function currentMonth() {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
}

// ---------- 存储 ----------
function getStore(key, fallback) {
  return new Promise((resolve) => {
    chrome.storage.local.get(key, (res) => resolve(res[key] ?? fallback));
  });
}
function setStore(obj) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(obj, () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message || "无法保存扩展配置"));
      else resolve();
    });
  });
}
const getPlatforms = () => getStore(KEY_PLATFORMS, []);
// 旧的批量/页面快照不能覆盖刚确认的 OAuth 结果。
function preserveCompletedReauth(next, stored) {
  if (!stored || !next.reauthPending || !stored.reauthCompletedAt ||
      Number(stored.reauthCompletedAt) < Number(next.reauthStartedAt || 0) || next.authMode !== stored.authMode ||
      String(next.userId || "") !== String(stored.userId || "") || next.baseUrl !== stored.baseUrl) return next;
  return { ...next, reauthPending: false, reauthCompletedAt: stored.reauthCompletedAt, message: stored.message,
    error: stored.error, stats: stored.stats, statsDate: stored.statsDate, account: stored.account, lastCheckinAt: stored.lastCheckinAt };
}
let platformWriteQueue = Promise.resolve();
function mutatePlatforms(fn) {
  const update = platformWriteQueue.then(async () => {
    const current = await getPlatforms();
    const next = await fn(current);
    await setStore({ [KEY_PLATFORMS]: next });
  });
  platformWriteQueue = update.catch(() => {});
  return update;
}
const savePlatforms = (list) => mutatePlatforms((current) => list.map((p) => preserveCompletedReauth(p, current.find((x) => x.id === p.id))));
const getSettings = () =>
  getStore(KEY_SETTINGS, { autoEnabled: false, autoTime: "08:01", autoApprove: false, notify: true });
const saveSettings = (s) => setStore({ [KEY_SETTINGS]: s });

// ---------- 校验 ----------
function validatePlatform(p) {
  let url;
  try {
    url = new URL(p.baseUrl);
  } catch {
    throw new Error("NewAPI 站点地址格式不正确");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new Error("站点地址必须使用 HTTP/HTTPS");
  if (p.authMode && !AUTH_CONFIG.modes.includes(p.authMode)) throw new Error("不支持的鉴权方式");
  if (p.authMode === "cookie") return; // Cookie 模式：仅需站点地址 + 浏览器已登录该站点
  if (p.userId && !/^\d+$/.test(String(p.userId).trim()))
    throw new Error("请填写正确的 NewAPI 用户ID");
  if (isAgentRouterMode(p) && !/^\d+$/.test(String(p.userId || "").trim()))
    throw new Error("Agent Router 签到模式必须填写数字用户ID");
  if (isAgentRouterMode(p)) return;
  if (p.authMode === "password") {
    if (url.protocol !== "https:" || url.username || url.password) throw new Error("邮箱密码登录必须使用无内嵌凭据的 HTTPS 地址");
    if (!String(p.loginUsername || "").trim()) throw new Error("请填写邮箱或用户名");
    if (typeof p.loginPassword !== "string" || !p.loginPassword) throw new Error("请填写登录密码");
    return;
  }
  if (!(p.accessToken || "").trim()) throw new Error("请填写访问令牌");
}

const isVisitOnly = (p) => AUTH_CONFIG.isVisitOnly(p);
async function resolveSavedVisitOnly(p) {
  if (!p || p.id == null) return p;
  const stored = (await getPlatforms()).find((entry) => entry.id === p.id);
  return isVisitOnly(stored) ? stored : p;
}
async function assertApiAllowed(p, reqPath = "/api/user/checkin") {
  const current = await resolveSavedVisitOnly(p);
  if (!isVisitOnly(p) && !isVisitOnly(current)) return;
  // 仅访问只跳过签到动作，不禁止正常登录、额度、日志、模型或用户已配置的保活。
  const pathOf = (path) => decodeURIComponent(new URL(path, current.baseUrl).pathname).replace(/\/+$/, "");
  const path = pathOf(reqPath);
  const custom = String(current.checkinPath || "").trim();
  if (path === "/api/user/checkin" || (custom && !current.triggerSelf && path === pathOf(custom))) {
    throw new Error("仅访问模式跳过签到接口，请使用立即访问");
  }
}

function sameTaskConfig(a, b) {
  return isVisitOnly(a) === isVisitOnly(b) &&
    ["baseUrl", "authMode", "userId", "loginUsername", "loginPassword"].every((key) => a[key] === b[key]);
}

function isSiteHost(base, host) {
  try { return new URL(base).hostname.toLowerCase() === host; } catch { return false; }
}
// 两种显式 Agent Router 模式共享校验、账户检测及重登录链路，均不需要访问令牌。
function isAgentRouterMode(p) {
  return !!p && AUTH_CONFIG.isAgentRouterMode(p.authMode);
}
function isAgentRouterReauthMode(p) {
  return isAgentRouterMode(p) || (!!p && p.authMode === "cookie" && isSiteHost(p.baseUrl, "agentrouter.org"));
}
function agentRouterProvider(p) { return AUTH_CONFIG.agentRouterProvider(p.authMode); }
function agentRouterProviderLabel(provider) { return provider === "linuxdo" ? "Linux DO" : "GitHub"; }
function isSelfTriggerMode(p) {
  return isAgentRouterReauthMode(p) || (!!p && p.authMode === "password" && isSiteHost(p.baseUrl, "agentrouter.org")) ||
    (!!p && p.authMode === "cookie" && (isSiteHost(p.baseUrl, "ps.air-outer.com") || !!p.triggerSelf));
}

function verifyConfiguredUser(p, body) {
  const configured = String((p && p.userId) || "").trim();
  const actual = body && body.data && body.data.id != null ? String(body.data.id) : "";
  if (configured && actual && configured !== actual) {
    throw accountMismatchError(configured, actual);
  }
  return body;
}

function accountMismatchError(configured, actual) {
  const error = new Error("当前站点用户ID为 " + actual + "，与配置的 " + configured + " 不一致");
  error.code = "ACCOUNT_MISMATCH";
  return error;
}

// 按 tab 存储 OAuth 任务，迁移旧单槽记录。写入排队，避免批量登录覆盖其他站点。
async function getAgentRouterPending() {
  const stored = await getStore(KEY_AGENTROUTER_REAUTH, {});
  if (!stored) return {};
  if (stored.tabId != null) return { [stored.tabId]: { ...stored, provider: "github", oauthStarted: !!stored.githubClicked } };
  return stored;
}
let agentRouterPendingWrite = Promise.resolve();
function updateAgentRouterPending(tabId, pending) {
  const update = agentRouterPendingWrite.then(async () => {
    const all = await getAgentRouterPending();
    if (pending) all[tabId] = { ...(all[tabId] || {}), ...pending }; else delete all[tabId];
    await setStore({ [KEY_AGENTROUTER_REAUTH]: all });
    if (Object.keys(all).length) chrome.alarms.create(OAUTH_ALARM_NAME, { periodInMinutes: 1 });
    else await chrome.alarms.clear(OAUTH_ALARM_NAME);
  });
  agentRouterPendingWrite = update.catch(() => {});
  return update;
}
async function isAgentRouterReauthPending(p) {
  if (!isAgentRouterReauthMode(p)) return false;
  const all = await getAgentRouterPending();
  const origin = new URL(p.baseUrl).origin;
  return Object.values(all).some((pending) => pending.origin === origin && Date.now() - Number(pending.createdAt || 0) <= 6 * 60 * 1000);
}

// 同一个站点只有一个网页登录会话；不同账号/提供方必须等上一轮回调处理结束再切换。
function sameOauthTask(pending, platform) {
  return (!pending.platformId || pending.platformId === platform.id) &&
    (!pending.authMode || pending.authMode === platform.authMode) &&
    pending.provider === agentRouterProvider(platform) &&
    String(pending.userId || "").trim() === String(platform.userId || "").trim() &&
    !!pending.visitOnly === isVisitOnly(platform);
}
async function waitForAgentRouterTurn(platform, reuse = false) {
  const origin = new URL(platform.baseUrl).origin;
  const deadline = Date.now() + 120000;
  for (let i = 0; i < 150 && Date.now() < deadline; i++) {
    const pending = Object.values(await getAgentRouterPending()).find((item) => item.origin === origin);
    if (!pending) return null;
    const tab = await chrome.tabs.get(pending.tabId).catch(() => null);
    if (!tab || Date.now() - Number(pending.createdAt || 0) > 6 * 60 * 1000) {
      await updateAgentRouterPending(pending.tabId, null);
      await saveAgentRouterLoginOutcome(pending, null, tab ? "登录等待超时，请重新执行" : "登录页已关闭，请重新执行");
      continue;
    }
    if (reuse && sameOauthTask(pending, platform)) return pending;
    // 不登出、不导航上一账号的页面，避免把它的 state 和回调换给后一账号。
    await wait(800);
  }
  throw new Error("本站前一个账号的授权尚未完成；已保留原登录页，请先完成或关闭它，再执行当前账号");
}

// 上游 NewAPI 鉴权错误码 → 友好中文提示（来源：QuantumNous/new-api middleware/auth.go）
const CODE_HINTS = {
  "AUTH_INSUFFICIENT_PRIVILEGE": "令牌校验通过，但该账号角色权限不足以调用签到接口（站点侧限制）。请确认填的是「个人设置」生成的系统访问令牌，而非「令牌管理」里的 API 令牌(sk-xxx)；若令牌正确则该账号无签到权限。",
  "AUTH_UNAUTHORIZED": "访问令牌无效或类型错误。请填「个人设置」页生成的系统访问令牌，而非「令牌管理」的 API 令牌。",
  "AUTH_USER_DISABLED": "该账号已被封禁。",
  "AUTH_TOKEN_EXPIRED": "登录会话已过期。",
  "AUTH_SESSION_REVOKED": "登录会话已被撤销。",
  "AUTH_USER_INVALID": "用户信息无效。",
};
// ---------- 核心：直连 NewAPI 签到接口 ----------
async function callCheckin(p, method = "GET", month, opts) {
  await assertApiAllowed(p);
  validatePlatform(p);
  const base = (p.baseUrl || "").trim().replace(/\/+$/, "");
  if (isAgentRouterReauthMode(p)) {
    if (opts && opts.reauth) return await runAgentRouterOauthCheckin(p, base);
    const account = await callAgentRouterAccountViaTab(p, base);
    if (account.warning) account.body._accountWarn = account.warning;
    return account.body;
  }
  if (p.authMode === "password") {
    const user = await ensurePasswordSession(p, !!(opts && opts.reauth && isSelfTriggerMode(p)));
    if (opts && opts.reauth && user._freshLogin && user.checked_in === true) return { success: true, message: "登录回调已确认签到", data: { stats: { checked_in_today: true } } };
    if (isSelfTriggerMode(p)) {
      if (opts && opts.reauth) throw new Error("已登录，但本站登录回调未确认签到；请检查站点签到规则后重试");
      return { success: true, data: user };
    }
    return await callViaTab(p, base, method, month, opts);
  }
  if (p.authMode === "cookie") return await callViaTab(p, base, method, month, opts);
  const url = new URL(base + "/api/user/checkin");
  const headers = { "Content-Type": "application/json" };
  const token = (p.accessToken || "").trim();
  if (token) headers["Authorization"] = "Bearer " + token;
  // 部分兼容站点需要通过 New-Api-User 指定用户ID
  const uid = String(p.userId || "").trim();
  if (uid && /^\d+$/.test(uid)) headers["New-Api-User"] = uid;

  const init = { method, headers, credentials: "omit" };
  if (method === "GET") {
    url.searchParams.set("month", month || currentMonth());
  }
  let res;
  try {
    res = await fetch(url.toString(), init);
  } catch (e) {
    throw new Error("网络请求失败：" + (e && e.message ? e.message : "无法连接站点"));
  }
  let body;
  try {
    body = await res.json();
  } catch {
    throw new Error("站点返回了无法解析的数据");
  }
  if (!res.ok || body.success === false) {
    const code = (body && body.code) || "";
    const hint = CODE_HINTS[code] || "";
    throw new Error((body.message || "请求失败（HTTP " + res.status + "）") + (hint ? " ｜ " + hint : ""));
  }
  if (!body.data || (method === "GET" && !body.data.stats))
    throw new Error("该站点不是兼容的 NewAPI 签到站点");
  return body;
}

async function getAgentRouterPage(base) {
  const origin = new URL(base).origin;
  const tabs = await chrome.tabs.query({ url: origin + "/*" }).catch(() => []);
  let tab = tabs && tabs.find((t) => t.url && !/\/(login|signin|register)/i.test(t.url));
  let createdTabId = null;
  if (!tab) {
    tab = await chrome.tabs.create({ url: base, active: false }).catch(() => null);
    if (!tab) throw new Error("无法打开 Agent Router 标签页");
    createdTabId = tab.id;
    await waitTabComplete(tab.id);
  } else if (tab.status && tab.status !== "complete") {
    await waitTabComplete(tab.id);
  }
  return { tab, createdTabId };
}

async function callAgentRouterAccountViaTab(p, base, strict = false) {
  const { tab, createdTabId } = await getAgentRouterPage(base);
  let result = null;
  try {
    const out = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: tabFetchAgentRouterAccount,
      args: [String(p.userId || "").trim(), strict],
    });
    result = out && out[0] && out[0].result;
  } catch (e) {
    throw new Error("无法在 Agent Router 页面读取账户额度：" + (e && e.message ? e.message : "页面脚本执行失败"));
  } finally {
    if (createdTabId != null) await chrome.tabs.remove(createdTabId).catch(() => {});
  }

  if (result && result.userMismatch) {
    throw accountMismatchError(result.configuredUserId, result.actualUserId);
  }
  if (result && result.ok && result.body && result.body.data) {
    if (strict && (result.body.data.id == null || !/^\d+$/.test(String(result.body.data.id)))) {
      const error = new Error("在线账户响应缺少有效用户ID，尚未确认登录");
      error.code = "AUTH_NOT_LOGGED_IN";
      throw error;
    }
    verifyConfiguredUser(p, result.body);
    return {
      body: result.body,
      warning: result.usedCachedAccount
        ? "用户接口连续返回异常零值，当前额度来自最近一次登录数据"
        : "",
    };
  }
  if (!strict && result && result.cachedUser && ![401, 403].includes(result.status) && !result.htmlResponse) {
    const body = { success: true, data: result.cachedUser };
    verifyConfiguredUser(p, body);
    return { body, warning: "用户接口返回异常，当前额度来自最近一次登录数据" };
  }

  const detail = result && result.message ? result.message : "网站未返回账户数据";
  const error = new Error("获取账户额度失败：" + detail);
  if (result && ([401, 403].includes(result.status) || result.htmlResponse)) error.code = "AUTH_NOT_LOGGED_IN";
  throw error;
}

// Agent Router 的当前前端在 OAuth/密码登录响应中通过 data.checked_in 返回签到结果。
// 正确流程是退出当前 Cookie 会话后重新登录，不需要预先用访问令牌请求 /api/user/self。
async function runAgentRouterOauthCheckin(p, base) {
  const origin = new URL(base).origin;
  if (visitOnlyOrigins.has(origin) || passwordLoginInflight.has(origin) || agentRouterStarting.has(origin)) throw new Error("本站有其他登录任务正在启动，请稍后重试");
  agentRouterStarting.add(origin); // 在首次 await 前预留，防止两种提供方同时启动。
  try {
    const old = await waitForAgentRouterTurn(p, true);
    if (old) {
      await chrome.tabs.update(old.tabId, { active: true }).catch(() => {});
      return { success: true, message: "正在等待 " + agentRouterProviderLabel(old.provider) + " 登录完成", _reauthRequired: true, _reauthStartedAt: old.createdAt, _oauthLoginStarted: old.oauthStarted, _githubLoginStarted: old.provider === "github" && old.oauthStarted };
    }
    const { tab, createdTabId } = await getAgentRouterPage(base);
    let storedUser = null;
    try {
      const out = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: "MAIN",
        func: tabReadAgentRouterStoredUser,
      });
      storedUser = out && out[0] && out[0].result;
    } catch {}
    const configured = String(p.userId || "").trim();
    // 旧会话可以属于另一账号；主动重登录的入口应先退出它，而不是在退出前拦截切换。

    let logoutResult = null;
    try {
      const out = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: "MAIN", func: tabLogout });
      logoutResult = out && out[0] && out[0].result;
    } catch {}
    if (createdTabId != null) await chrome.tabs.remove(createdTabId).catch(() => {});
    if (!logoutResult?.ok) {
      throw new Error((logoutResult && logoutResult.body && logoutResult.body.message) || "Agent Router 退出失败，无法开始重新登录签到");
    }

    clearSiteSessionTokens(origin);
    const reauthTab = await startAgentRouterReauth(base, p);
    if (!reauthTab) throw new Error("Agent Router 登录页启动失败");
    return {
      success: true,
      message: "已打开 " + agentRouterProviderLabel(agentRouterProvider(p)) + " 登录页，等待登录回调确认签到",
      data: { id: configured || null },
      _reauthRequired: true,
      _reauthStartedAt: reauthTab.createdAt,
      _logoutOk: !storedUser || !!(logoutResult && logoutResult.ok),
      _oauthLoginStarted: !!reauthTab.oauthStarted,
      _githubLoginStarted: agentRouterProvider(p) === "github" && !!reauthTab.oauthStarted,
    };
  } finally { agentRouterStarting.delete(origin); }
}

// 上游返回校验（cookie/token 共用）
// strategy.triggerSelf=true 时，GET /api/user/self 成功即视为签到完成（不要求 stats）
function throwOnBadResult(result, method, strategy) {
  const body = result && result.body;
  const status = (result && result.status) || 0;
  if (!result || !result.ok) {
    const code = (body && body.code) || "";
    const hint = CODE_HINTS[code] || "";
    throw new Error((body && body.message) || ("请求失败（HTTP " + status + "）") + (hint ? " ｜ " + hint : ""));
  }
  if (!body) throw new Error("站点返回了无法解析的数据");
  if (body.success === false) {
    const code = body.code || "";
    const hint = CODE_HINTS[code] || "";
    throw new Error((body.message || "请求失败") + (hint ? " ｜ " + hint : ""));
  }
  // self 触发型：只要 success 即视为签到成功
  if (strategy && strategy.triggerSelf) {
    if (!body.data && body.success !== true && body.ret == null && body.code == null)
      throw new Error("该站点未返回有效用户数据");
    return body;
  }
  if (!body.data || (method === "GET" && !body.data.stats))
    throw new Error("该站点不是兼容的 NewAPI 签到站点");
  return body;
}

// 等待标签页加载完成（最长 12s）
function waitTabComplete(tabId) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; chrome.tabs.onUpdated.removeListener(listener); resolve(); } };
    const listener = (id, info) => { if (id === tabId && info.status === "complete") finish(); };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((tab) => { if (tab && tab.status === "complete") finish(); }).catch(finish);
    setTimeout(finish, 12000);
  });
}

// 内容脚本内同源 fetch（自动携带站点登录 Cookie；MV3 无法在 SW 直接设 Cookie 头）
// 站点内的同源请求（自动携带登录 Cookie；含浏览器伪装头，绕过部分站点 UA/Referer 校验）
// args: [reqPath, method, month, userId, apiUserKey]
function tabFetchCheckin(reqPath, method, month, userId, apiUserKey, query) {
  return (async () => {
    const url = new URL(reqPath, location.origin);
    if (url.origin !== location.origin) return { ok: false, status: 0, body: { success: false, message: "禁止向其他站点发送会话请求" } };
    if (month) url.searchParams.set("month", month);
    if (query) for (const k of Object.keys(query)) url.searchParams.set(k, String(query[k]));
    const headers = {
      "Accept": "application/json, text/plain, */*",
      "Cache-Control": "no-store",
    };
    if ((method || "GET").toUpperCase() !== "GET") headers["Content-Type"] = "application/json";
    if (!userId) {
      try { const user = JSON.parse(localStorage.getItem("user") || "null"); if (user && user.id != null) userId = String(user.id); } catch {}
    }
    if (userId) headers[(apiUserKey || "New-Api-User")] = String(userId);
    let res;
    try {
      res = await fetch(url.toString(), { method, headers, credentials: "include" });
    } catch (e) {
      return { ok: false, status: 0, body: { success: false, message: "网络请求失败：" + (e && e.message ? e.message : "无法连接站点") } };
    }
    const contentType = String(res.headers.get("content-type") || "").toLowerCase();
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch {}
    const htmlResponse = contentType.includes("text/html") || /^\s*<!doctype\s+html|^\s*<html[\s>]/i.test(text);
    if (!body && htmlResponse) {
      body = { success: false, message: "登录会话已失效或站点触发了安全验证，请打开目标站点重新登录或完成验证后重试" };
    } else if (!body) {
      body = { success: false, message: text ? "站点返回了非 JSON 数据，请稍后重试" : "站点返回了空响应，请稍后重试" };
    }
    return { ok: res.ok, status: res.status, body, htmlResponse };
  })();
}

function tabReadAgentRouterStoredUser() {
  try {
    const user = JSON.parse(localStorage.getItem("user") || "null");
    if (!user || user.id == null) return null;
    return {
      id: user.id,
      username: user.username || "",
      display_name: user.display_name || "",
      checked_in: user.checked_in === true,
    };
  } catch {
    return null;
  }
}

// 与 Agent Router 当前前端的 Axios 请求保持一致：页面主世界、Cookie、New-API-User 和 XHR。
function tabFetchAgentRouterAccount(configuredUserId, strict = false) {
  const readStoredUser = () => {
    try {
      const user = JSON.parse(localStorage.getItem("user") || "null");
      if (!user || user.id == null) return null;
      return {
        id: user.id,
        username: user.username || "",
        display_name: user.display_name || "",
        quota: user.quota ?? null,
        available: user.available ?? null,
        available_quota: user.available_quota ?? null,
        remaining_quota: user.remaining_quota ?? null,
        used_quota: user.used_quota ?? null,
        usedQuota: user.usedQuota ?? null,
        used: user.used ?? null,
        request_count: user.request_count ?? null,
        requestCount: user.requestCount ?? null,
      };
    } catch {
      return null;
    }
  };

  return (async () => {
    const cachedUser = readStoredUser();
    const configured = String(configuredUserId || "").trim();
    const actual = cachedUser && cachedUser.id != null ? String(cachedUser.id) : "";
    if (!strict && configured && actual && configured !== actual) {
      return { userMismatch: true, configuredUserId: configured, actualUserId: actual };
    }

    const userId = strict ? configured || actual || "-1" : actual || configured || "-1";
    const valueOf = (data, names) => {
      if (!data) return null;
      for (const name of names) {
        if (data[name] != null && data[name] !== "") return data[name];
      }
      return null;
    };
    const accountValues = (data) => ({
      quota: valueOf(data, ["quota", "available", "available_quota", "remaining_quota"]),
      used: valueOf(data, ["used_quota", "usedQuota", "used"]),
    });
    const isZero = (value) => value != null && value !== "" && Number(value) === 0;
    const looksLikeEmptyAccount = (data) => {
      const values = accountValues(data);
      return isZero(values.quota) && isZero(values.used);
    };
    const cachedValues = accountValues(cachedUser);
    const cachedHasBalance = [cachedValues.quota, cachedValues.used]
      .some((value) => value != null && value !== "" && Number(value) !== 0);

    const requestUser = (cacheBust) => new Promise((resolveRequest) => {
      let xhr;
      try {
        xhr = new XMLHttpRequest();
        const path = "/api/user/self" + (cacheBust ? "?_nacheckin=" + Date.now() : "");
        xhr.open("GET", path, true);
        xhr.withCredentials = true;
        xhr.timeout = 15000;
        xhr.setRequestHeader("Accept", "application/json, text/plain, */*");
        xhr.setRequestHeader("X-Requested-With", "XMLHttpRequest");
        xhr.setRequestHeader("New-API-User", userId);
        xhr.setRequestHeader("Cache-Control", "no-cache, no-store, max-age=0");
        xhr.setRequestHeader("Pragma", "no-cache");
      } catch (e) {
        resolveRequest({ ok: false, message: e && e.message ? e.message : "无法创建账户请求" });
        return;
      }

      xhr.onload = () => {
        const text = String(xhr.responseText || "");
        const contentType = String(xhr.getResponseHeader("content-type") || "").toLowerCase();
        let body = null;
        try { body = text ? JSON.parse(text) : null; } catch {}
        if (xhr.status >= 200 && xhr.status < 300 && body && body.success !== false && body.data) {
          resolveRequest({ ok: true, status: xhr.status, responseUrl: xhr.responseURL, contentType, body });
          return;
        }
        const htmlResponse = contentType.includes("text/html") || /^\s*<!doctype\s+html|^\s*<html[\s>]/i.test(text);
        const message = body && body.message
          ? body.message
          : htmlResponse
            ? "用户接口被重定向到网页（HTTP " + xhr.status + "，" + (xhr.responseURL || "/api/user/self") + "）"
            : "用户接口返回无效数据（HTTP " + xhr.status + "）";
        resolveRequest({ ok: false, status: xhr.status, responseUrl: xhr.responseURL, contentType, htmlResponse, message });
      };
      xhr.onerror = () => resolveRequest({ ok: false, status: xhr.status || 0, message: "用户接口网络请求失败" });
      xhr.ontimeout = () => resolveRequest({ ok: false, status: 0, message: "用户接口请求超时" });
      try { xhr.send(); }
      catch (e) { resolveRequest({ ok: false, status: 0, message: e && e.message ? e.message : "用户接口请求失败" }); }
    });

    let result = await requestUser(false);
    if (!result.ok || (cachedHasBalance && looksLikeEmptyAccount(result.body && result.body.data))) {
      const retry = await requestUser(true);
      if (retry.ok || !result.ok) result = retry;
    }

    const onlineId = result && result.ok && result.body && result.body.data && result.body.data.id;
    if (configured && onlineId != null && configured !== String(onlineId)) {
      return { userMismatch: true, configuredUserId: configured, actualUserId: String(onlineId) };
    }
    // 回调/检测必须使用在线响应，不能用旧 user 缓存补额度或证明当前会话。
    if (strict) return { ...result, cachedUser: null };
    if (result.ok && cachedHasBalance && looksLikeEmptyAccount(result.body.data)) {
      const liveUser = result.body.data;
      result.body = {
        ...result.body,
        data: {
          ...liveUser,
          quota: cachedValues.quota,
          used_quota: cachedValues.used,
          request_count: valueOf(cachedUser, ["request_count", "requestCount"])
            ?? valueOf(liveUser, ["request_count", "requestCount"]),
        },
      };
      result.usedCachedAccount = true;
    } else if (result.ok) {
      try {
        const stored = JSON.parse(localStorage.getItem("user") || "null") || {};
        localStorage.setItem("user", JSON.stringify({ ...stored, ...result.body.data }));
      } catch {}
    }

    return { ...result, cachedUser };
  })();
}

// agentrouter.org 需要重新建立登录会话后才会激活签到额度。
// ---------- 邮箱/用户名密码：只填写本站原生登录表单，不在 SW 拼装登录请求 ----------
// 参数只能传到已核验的 HTTPS origin；页面内再次核验，防止导航竞态误投凭据。
async function tabSubmitPasswordLogin(expectedOrigin, username, password) {
  const onLoginPage = () => location.origin === expectedOrigin && location.protocol === "https:" && /^\/login\/?$/.test(location.pathname);
  const visible = (el) => !!el && !el.disabled && el.getClientRects().length > 0;
  if (!onLoginPage()) return { ok: false, message: "登录页地址已变化，已停止填写密码" };
  for (let i = 0; i < 30; i++) {
    if (!onLoginPage()) return { ok: false, message: "登录页地址已变化，已停止填写密码" };
    const pass = Array.from(document.querySelectorAll('input[name="password"], input[type="password"]')).find(visible);
    if (pass) {
      const form = pass.form || pass.closest("form");
      if (!form) return { ok: false, message: "未找到本站登录表单，请手动登录后重试" };
      const action = new URL(form.getAttribute("action") || location.href, location.href);
      if (action.origin !== expectedOrigin || action.protocol !== "https:" || action.username || action.password) {
        return { ok: false, message: "登录表单指向其他地址，已停止填写密码" };
      }
      const user = Array.from(form.querySelectorAll('input[name="username"], input[name="email"], input[autocomplete="username"], input[type="email"], input[type="text"]')).find(visible);
      if (!user) return { ok: false, message: "未找到邮箱/用户名输入框，请手动登录后重试" };
      // 默认 method 是 GET，Semi/React 表单通常靠 JS POST；阻止不安全的原生提交回退。
      const safeSubmission = (button) => {
        const target = new URL((button && button.getAttribute("formaction")) || form.getAttribute("action") || location.href, location.href);
        return onLoginPage() && target.origin === expectedOrigin && target.protocol === "https:" && !target.username && !target.password;
      };
      const guard = (event) => {
        const button = event.submitter;
        const method = ((button && button.getAttribute("formmethod")) || form.getAttribute("method") || "get").toLowerCase();
        if (method !== "post" || !safeSubmission(button)) event.preventDefault();
      };
      form.addEventListener("submit", guard, true);
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      setter.call(user, String(username).trim());
      user.dispatchEvent(new Event("input", { bubbles: true }));
      user.dispatchEvent(new Event("change", { bubbles: true }));
      setter.call(pass, password); // 密码必须原样保留，包括首尾空格。
      pass.dispatchEvent(new Event("input", { bubbles: true }));
      pass.dispatchEvent(new Event("change", { bubbles: true }));
      // 等待 React 受控字段更新后触发原页面处理器（包含站点 Turnstile 等逻辑）。
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (!onLoginPage()) return { ok: false, message: "登录页地址已变化，已停止提交" };
      const submit = Array.from(form.querySelectorAll('button, input[type="submit"]')).find((el) => visible(el) &&
        (el.type === "submit" || /^(继续|登录|登\s*录|sign\s*in|log\s*in|continue)$/i.test(String(el.textContent || el.value || "").trim())));
      if (!submit) return { ok: false, message: "登录按钮尚不可用，请完成本站验证后手动登录" };
      // button 的 formaction 可以覆盖 form.action；同样必须检查。
      // 必须重新读取 action：输入事件及 React 更新可能已替换提交目标。
      const explicitMethod = (submit.getAttribute("formmethod") || form.getAttribute("method") || "").toLowerCase();
      if (!safeSubmission(submit) || (explicitMethod && explicitMethod !== "post")) {
        return { ok: false, message: "登录提交目标不安全，已停止提交" };
      }
      submit.click();
      return { ok: true };
    }
    // AnyRouter/NewAPI 的 OAuth 首页需要先展开“使用邮箱或用户名进行登录”。
    const reveal = Array.from(document.querySelectorAll("button")).find((el) => visible(el) &&
      /(?:邮箱|用户名|email|username)/i.test(el.textContent || "") && /(?:登录|登陆|log\s*in|sign\s*in|continue)/i.test(el.textContent || ""));
    if (reveal) reveal.click();
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return { ok: false, message: "未找到邮箱密码登录表单；请在打开的页面完成安全验证或手动登录后重试" };
}

function passwordUserMatches(p, user) {
  if (!user || user.id == null) return false;
  const uid = String(p.userId || "").trim();
  if (uid && uid !== String(user.id)) return false;
  const login = String(p.loginUsername || "").trim().toLowerCase();
  return [user.username, user.email].some((v) => v && String(v).trim().toLowerCase() === login);
}

const passwordLoginInflight = new Map();
const visitOnlyOrigins = new Set();
// 只负责在调用方拥有的临时页内登录；页面生命周期由调用方管理。
async function loginPasswordOnTab(p, tab, force = false) {
  const origin = new URL(p.baseUrl).origin;
  const login = String(p.loginUsername || "").trim();
  const inject = async (func, args = [], main = false) => {
    const current = await chrome.tabs.get(tab.id);
    if (!current.url || new URL(current.url).origin !== origin) throw new Error("站点跳转到其他地址，已停止邮箱密码登录");
    const out = await chrome.scripting.executeScript({ target: { tabId: tab.id }, ...(main ? { world: "MAIN" } : {}), func, args });
    return out && out[0] && out[0].result;
  };
  const probe = await inject(tabFetchCheckin, ["/api/user/self", "GET", null, String(p.userId || ""), "New-Api-User"]);
  const currentUser = probe && probe.ok && probe.body && probe.body.success !== false && probe.body.data;
  if (!force && passwordUserMatches(p, currentUser)) return currentUser;
  // 不沿用其他账号/无法确认归属的会话，也不能以旧 localStorage 证明登录成功。
  const logout = await inject(tabLogout, [], true);
  if (!logout || !logout.ok) throw new Error("无法退出旧登录会话，请在本站手动退出后重试");
  clearSiteSessionTokens(origin);
  await chrome.tabs.update(tab.id, { url: origin + "/login", active: true });
  await waitTabComplete(tab.id);
  const submitted = await inject(tabSubmitPasswordLogin, [origin, login, p.loginPassword], true);
  if (!submitted || !submitted.ok) throw new Error(submitted && submitted.message || "无法填写本站登录表单");
  // 成功必须同时有新的页面登录数据和在线 self，不能仅以提交按钮/跳转判断。
  for (let i = 0; i < 25; i++) {
    await wait(800);
    let stored = null, online = null;
    try {
      stored = await inject(tabReadAgentRouterStoredUser);
      if (stored && stored.id != null) online = await inject(tabFetchCheckin, ["/api/user/self", "GET", null, String(stored.id), "New-Api-User"]);
    } catch { continue; } // SPA 导航期间注入可能暂不可用。
    const user = online && online.ok && online.body && online.body.success !== false && online.body.data;
    if (!user || !stored || String(user.id) !== String(stored.id)) continue;
    verifyConfiguredUser(p, online.body);
    // 新表单登录完成后，若站点提供邮箱/用户名，进一步拒绝明确串号。
    if ((!login.includes("@") || user.email) && !passwordUserMatches(p, user)) throw new Error("本站登录账号与配置的邮箱/用户名不一致");
    return { ...user, checked_in: stored.checked_in === true, _freshLogin: true };
  }
  throw new Error("邮箱密码登录尚未完成：请在打开的页面检查密码、验证码或二次验证，完成后重试");
}

async function ensurePasswordSession(p, force = false) {
  validatePlatform(p);
  const origin = new URL(p.baseUrl).origin;
  if (visitOnlyOrigins.has(origin) || agentRouterStarting.has(origin)) throw new Error("本站有访问或 OAuth 登录任务正在启动，请完成后重试");
  await waitForAgentRouterTurn(p);
  if (visitOnlyOrigins.has(origin) || agentRouterStarting.has(origin)) throw new Error("本站有访问或 OAuth 登录任务正在启动，请完成后重试");
  const login = String(p.loginUsername || "").trim();
  const existing = passwordLoginInflight.get(origin);
  if (existing) {
    if (existing.login !== login || existing.userId !== String(p.userId || "") || existing.password !== p.loginPassword) {
      throw new Error("同站点的其他账号正在登录，请逐一处理，避免串号");
    }
    return await existing.promise;
  }
  const promise = (async () => {
    const tab = await chrome.tabs.create({ url: origin + "/login", active: false });
    let keepTab = false;
    try {
      await waitTabComplete(tab.id);
      keepTab = true;
      const user = await loginPasswordOnTab(p, tab, force);
      keepTab = false;
      return user;
    } finally {
      if (!keepTab) await chrome.tabs.remove(tab.id).catch(() => {});
      else await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
    }
  })();
  passwordLoginInflight.set(origin, { login, userId: String(p.userId || ""), password: p.loginPassword, promise });
  try { return await promise; }
  finally { passwordLoginInflight.delete(origin); }
}

function clearSiteSessionTokens(origin) {
  for (const key of sessionTokenCache.keys()) if (key.startsWith(origin + "#")) sessionTokenCache.delete(key);
}

function tabLogout() {
  return (async () => {
    try {
      let userId = "-1";
      try {
        const user = JSON.parse(localStorage.getItem("user") || "null");
        if (user && user.id != null) userId = String(user.id);
      } catch {}
      const res = await fetch("/api/user/logout", {
        method: "GET",
        credentials: "include",
        headers: {
          "Accept": "application/json, text/plain, */*",
          "Cache-Control": "no-store",
          "New-API-User": userId,
        },
      });
      const contentType = String(res.headers.get("content-type") || "").toLowerCase();
      const text = await res.text();
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch {}
      if (!body && (contentType.includes("text/html") || /^\s*<!doctype\s+html|^\s*<html[\s>]/i.test(text))) {
        body = { success: false, message: "登出请求被站点安全验证拦截" };
      } else if (!body && text) {
        body = { success: false, message: "登出接口返回了非 JSON 数据" };
      }
      if (res.ok && !(body && body.success === false)) {
        try { localStorage.removeItem("user"); } catch {}
      }
      return { ok: res.ok && !(body && body.success === false), status: res.status, body };
    } catch (e) {
      return { ok: false, status: 0, body: { success: false, message: e && e.message ? e.message : "登出请求失败" } };
    }
  })();
}

// 参数来自站点公开配置，不硬编码 client_id；Cookie/state 始终由站点页面生成。
async function tabBuildAgentRouterOauthUrl(provider, expectedOrigin) {
  try {
    if (location.origin !== expectedOrigin) return { ok: false, message: "登录页跳转到其他站点，已停止 OAuth" };
    if (!["github", "linuxdo"].includes(provider)) return { ok: false, message: "不支持的 OAuth 登录方式" };
    const headers = { "Accept": "application/json, text/plain, */*", "Cache-Control": "no-store" };
    const statusRes = await fetch("/api/status", { credentials: "include", headers });
    const statusBody = await statusRes.json();
    const status = statusRes.ok && statusBody && statusBody.success !== false && statusBody.data;
    const clientId = status && status[provider === "linuxdo" ? "linuxdo_client_id" : "github_client_id"];
    if (!clientId) return { ok: false, message: "站点未提供 " + (provider === "linuxdo" ? "Linux DO" : "GitHub") + " OAuth 配置" };
    const params = new URLSearchParams({ mode: "login" });
    const aff = localStorage.getItem("aff");
    if (aff) params.set("aff", aff);
    const stateRes = await fetch("/api/oauth/state?" + params.toString(), { credentials: "include", headers });
    const stateBody = await stateRes.json();
    if (!stateRes.ok || !stateBody || stateBody.success === false || typeof stateBody.data !== "string" || !stateBody.data) {
      return { ok: false, message: "无法生成本站 OAuth 登录状态，请在登录页重试" };
    }
    localStorage.setItem("oauth_mode", "login");
    const oauth = new URL(provider === "linuxdo" ? "https://connect.linux.do/oauth2/authorize" : "https://github.com/login/oauth/authorize");
    oauth.searchParams.set("client_id", String(clientId));
    oauth.searchParams.set("state", stateBody.data);
    if (provider === "linuxdo") oauth.searchParams.set("response_type", "code");
    else oauth.searchParams.set("scope", "user:email");
    return { ok: true, url: oauth.href };
  } catch {
    return { ok: false, message: "无法启动 OAuth，可能需要先在本站完成安全验证" };
  }
}

// 只在本轮动态 client_id/state 与当前授权 URL 完全匹配时寻找 Linux DO 同意链接。
function tabClickLinuxDoApprove(expectedState, expectedClientId) {
  let clickAttempted = false;
  const fail = (reason) => ({ ok: false, clicked: clickAttempted, reason });
  try {
    const authorize = new URL(location.href);
    if (authorize.protocol !== "https:" || authorize.origin !== "https://connect.linux.do" || authorize.pathname !== "/oauth2/authorize") return fail("not_authorize_page");
    const oneParam = (name) => {
      const values = authorize.searchParams.getAll(name);
      return values.length === 1 ? values[0] : "";
    };
    const state = oneParam("state");
    const clientId = oneParam("client_id");
    if (oneParam("response_type") !== "code" || !String(expectedState || "").trim() || state !== expectedState ||
        !String(expectedClientId || "").trim() || clientId !== expectedClientId) return fail("authorize_context_mismatch");

    const selector = ".oauth-actions a.btn-pill-primary[href]";
    const candidates = document.querySelectorAll(selector);
    if (!candidates || candidates.length !== 1) return fail("approval_link_not_unique");
    const anchor = candidates[0];
    if (!anchor || String(anchor.tagName || "").toLowerCase() !== "a" || !anchor.matches(selector) || anchor.isConnected === false ||
        anchor.disabled === true || anchor.getAttribute("aria-disabled") === "true" || anchor.textContent.trim() !== "允许" ||
        (anchor.target && anchor.target !== "_self")) return fail("approval_link_unavailable");
    const href = anchor.getAttribute("href");
    if (href == null || !String(href).trim()) return fail("approval_link_unavailable");
    const approval = new URL(href, location.href);
    const target = approval.pathname.slice("/oauth2/approve/".length);
    if (approval.protocol !== "https:" || approval.origin !== "https://connect.linux.do" || approval.username || approval.password ||
        !approval.pathname.startsWith("/oauth2/approve/") || !target || target.includes("/")) return fail("approval_link_unsafe");
    const box = anchor.getBoundingClientRect();
    if (!anchor.getClientRects().length || !box || box.width <= 0 || box.height <= 0) return fail("approval_link_hidden");
    for (let element = anchor; element; element = element.parentElement) {
      const style = getComputedStyle(element);
      if (element.hidden || element.inert || element.getAttribute("aria-hidden") === "true" || style.display === "none" ||
          style.visibility === "hidden" || style.visibility === "collapse" || Number(style.opacity) === 0 ||
          style.pointerEvents === "none" || style.contentVisibility === "hidden") return fail("approval_link_hidden");
    }
    if (typeof anchor.click !== "function") return fail("approval_link_unavailable");
    clickAttempted = true;
    anchor.click();
    return { ok: true, clicked: true };
  } catch {
    return fail("approval_check_failed");
  }
}

function tabCheckAgentRouterLogin(configuredUserId) {
  try {
    const user = JSON.parse(localStorage.getItem("user") || "null");
    if (!user || user.id == null) return { ok: false };
    const configured = String(configuredUserId || "").trim();
    const actual = String(user.id);
    return {
      ok: !configured || configured === actual,
      userMismatch: !!configured && configured !== actual,
      userId: actual,
      checkedIn: user.checked_in === true,
      account: { available: user.quota ?? null, used: user.used_quota ?? null, requestCount: user.request_count ?? null, displayName: user.display_name || user.username || "" },
    };
  } catch { return { ok: false }; }
}

const agentRouterStarting = new Set();
const agentRouterReauthQueues = new Map();
async function saveAgentRouterLoginOutcome(pending, login, message) {
  if (pending.visitOnly) return; // 仅访问的回调/关闭/超时不得写入签到状态。
  return await mutatePlatforms((list) => {
    const matched = list.filter((p) => {
      if (isVisitOnly(p) !== !!pending.visitOnly) return false; // 切换任务用途后，旧签到回调不能覆盖仅访问状态。
      // 已被新一轮任务取代的旧关闭/超时/回调事件不能修改新任务结果。
      if (p.reauthStartedAt != null && Number(p.reauthStartedAt) !== Number(pending.createdAt)) return false;
      if (pending.platformId) {
        try { return p.id === pending.platformId && p.authMode === pending.authMode && String(p.userId || "") === pending.userId && new URL(p.baseUrl).origin === pending.origin; } catch { return false; }
      }
      // 兼容旧 pending，没有 id 时仅匹配同源同账号同提供方配置。
      try { return isAgentRouterReauthMode(p) && agentRouterProvider(p) === pending.provider && new URL(p.baseUrl).origin === pending.origin && String(p.userId || "") === pending.userId; }
      catch { return false; }
    });
    for (const p of matched) {
      p.reauthPending = false;
      p.reauthCompletedAt = Date.now();
      p.message = message;
      p.error = login && login.ok ? "" : message;
      p.lastCheckinAt = new Date().toISOString();
      if (login && login.ok && login.checkedIn === true) {
        p.stats = { ...(p.stats || {}), checked_in_today: true };
        p.statsDate = todayStr();
        if (login.account) p.account = { ...(p.account || {}), ...login.account };
      }
    }
    return list;
  });
}

async function startAgentRouterReauth(base, platform) {
  const origin = new URL(base).origin;
  const tab = await chrome.tabs.create({ url: origin + "/login", active: true });
  const pending = {
    tabId: tab.id, base, origin, platformId: platform.id || null,
    userId: String(platform.userId || ""), authMode: platform.authMode || "cookie",
    provider: agentRouterProvider(platform), oauthStarted: false, createdAt: Date.now(),
  };
  await updateAgentRouterPending(tab.id, pending);
  await mutatePlatforms((list) => {
    const configured = list.find((p) => p.id === platform.id);
    if (configured) {
      configured.reauthPending = true;
      configured.reauthStartedAt = pending.createdAt;
      configured.error = "";
      configured.message = "等待 " + agentRouterProviderLabel(pending.provider) + " 登录回调确认签到";
    }
    return list;
  });
  await waitTabComplete(tab.id);
  const current = await chrome.tabs.get(tab.id).catch(() => null);
  await handleAgentRouterReauthTab(tab.id, current && current.url);
  const active = (await getAgentRouterPending())[tab.id];
  return { ...tab, createdAt: pending.createdAt, oauthStarted: !!(active && active.oauthStarted) };
}

// 同一 tab 的状态读取、校验与点击预留一并排队；不能在读到旧快照后才加锁。
// 不丢弃排队中的回调 URL，避免快速导航时遗漏本轮回调证据。
function handleAgentRouterReauthTab(tabId, tabUrl) {
  const previous = agentRouterReauthQueues.get(tabId) || Promise.resolve();
  const task = previous.catch(() => {}).then(() => processAgentRouterReauthTab(tabId, tabUrl));
  agentRouterReauthQueues.set(tabId, task);
  task.finally(() => {
    if (agentRouterReauthQueues.get(tabId) === task) agentRouterReauthQueues.delete(tabId);
  }).catch(() => {});
  return task;
}
async function processAgentRouterReauthTab(tabId, tabUrl) {
  const pending = (await getAgentRouterPending())[tabId];
  if (!pending) return;
  let reportedUrl;
  try { reportedUrl = new URL(tabUrl); } catch {}
  const callbackStates = reportedUrl ? reportedUrl.searchParams.getAll("state") : [];
  const callbackCodes = reportedUrl ? reportedUrl.searchParams.getAll("code") : [];
  if (reportedUrl && reportedUrl.origin === pending.origin && reportedUrl.pathname.replace(/\/$/, "") === "/oauth/" + pending.provider &&
      pending.oauthStarted === true && String(pending.oauthState || "").trim() && callbackStates.length === 1 &&
      callbackStates[0] === pending.oauthState && callbackCodes.length === 1 && callbackCodes[0]) {
    pending.callbackSeen = true;
    await updateAgentRouterPending(tabId, { callbackSeen: true });
  }
  const label = agentRouterProviderLabel(pending.provider);
  if (Date.now() - Number(pending.createdAt || 0) > 6 * 60 * 1000) {
    await updateAgentRouterPending(tabId, null);
    await saveAgentRouterLoginOutcome(pending, null, label + " 登录等待超时，请完成验证后重新签到");
    return; // 不关闭需要用户交互的页面。
  }
  let url;
  try { url = new URL(tabUrl); } catch { return; }
  if (pending.provider === "linuxdo" && pending.authMode === "agentrouter_linuxdo" &&
      url.protocol === "https:" && url.origin === "https://connect.linux.do" && url.pathname === "/oauth2/authorize") {
    if (pending.approveClickStarted === true || pending.oauthStarted !== true ||
        !String(pending.oauthState || "").trim() || !String(pending.oauthClientId || "").trim()) return;
    const states = url.searchParams.getAll("state");
    const clientIds = url.searchParams.getAll("client_id");
    const responseTypes = url.searchParams.getAll("response_type");
    if (states.length !== 1 || states[0] !== pending.oauthState || clientIds.length !== 1 ||
        clientIds[0] !== pending.oauthClientId || responseTypes.length !== 1 || responseTypes[0] !== "code") return;
    // 先持久化预留：注入结果丢失或 worker 中断时不重复提交授权。
    await updateAgentRouterPending(tabId, { approveClickStarted: true });
    let approval;
    try {
      const out = await chrome.scripting.executeScript({ target: { tabId }, func: tabClickLinuxDoApprove, args: [pending.oauthState, pending.oauthClientId] });
      approval = out && out[0] && out[0].result;
    } catch { return; } // 结果不确定时保留页面供人工处理，不重试可能已发生的点击。
    if (approval && approval.ok === false && approval.clicked === false) {
      await updateAgentRouterPending(tabId, { approveClickStarted: false });
    }
    return;
  }
  if (url.origin !== pending.origin) return; // 其他 provider / 外站页面不注入本站代码。
  if (/^\/login\/?$/.test(url.pathname) && !pending.oauthStarted) {
    let oauth = null;
    try {
      const out = await chrome.scripting.executeScript({ target: { tabId }, func: tabBuildAgentRouterOauthUrl, args: [pending.provider, pending.origin] });
      oauth = out && out[0] && out[0].result;
    } catch {}
    if (!oauth || !oauth.ok || !oauth.url) {
      notify("Agent Router 自动登录未启动", (oauth && oauth.message) || "请在本站登录页手动使用 " + label + " 登录");
      return; // 保留 pending，可在手动回调后继续确认。
    }
    const destination = new URL(oauth.url);
    if (destination.origin !== (pending.provider === "linuxdo" ? "https://connect.linux.do" : "https://github.com")) return;
    const states = destination.searchParams.getAll("state");
    if (states.length !== 1 || !String(states[0] || "").trim()) return;
    if (pending.provider === "linuxdo") {
      const clientIds = destination.searchParams.getAll("client_id");
      const responseTypes = destination.searchParams.getAll("response_type");
      if (destination.protocol !== "https:" || destination.pathname !== "/oauth2/authorize" || clientIds.length !== 1 ||
          !String(clientIds[0] || "").trim() || responseTypes.length !== 1 || responseTypes[0] !== "code") return;
      pending.oauthClientId = clientIds[0]; // 本轮从站点配置生成，不硬编码。
      pending.approveClickStarted = false;
    }
    // 在导航前保存阶段，避免快速跳转回调时重复发起 OAuth。
    pending.oauthStarted = true;
    pending.oauthState = states[0];
    await updateAgentRouterPending(tabId, pending);
    const updated = await chrome.tabs.update(tabId, { url: oauth.url, active: true }).catch(() => null);
    if (!updated) { pending.oauthStarted = false; await updateAgentRouterPending(tabId, pending); }
    return;
  }
  if (pending.visitOnly) return; // 仅访问由其任务核验在线身份和首页，不能按 checked_in 关闭页面。
  if (!pending.callbackSeen) return; // 不能把任意同源页面的旧缓存当作本轮回调。
  let login = null;
  for (let i = 0; i < 12; i++) {
    if (i) await wait(800);
    try {
      const current = await chrome.tabs.get(tabId);
      if (!current.url || new URL(current.url).origin !== pending.origin) return;
      const cachedOut = await chrome.scripting.executeScript({ target: { tabId }, func: tabCheckAgentRouterLogin, args: [pending.userId] });
      const cached = cachedOut && cachedOut[0] && cachedOut[0].result;
      const onlineOut = await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func: tabFetchAgentRouterAccount, args: [pending.userId, true] });
      const online = onlineOut && onlineOut[0] && onlineOut[0].result;
      const live = online && online.ok && online.body && online.body.success !== false && online.body.data;
      const expected = String(pending.userId || cached && cached.userId || "").trim();
      if (online && (online.userMismatch || (live && live.id != null && expected && String(live.id) !== expected))) {
        login = { ok: false, userMismatch: true, userId: String(online.actualUserId || live && live.id || "") };
        break; // 在线证明确实登录错账号时立即失败，释放这一轮任务，不挂到超时。
      }
      if (!live || live.id == null || !cached || !cached.ok || String(live.id) !== String(cached.userId)) continue;
      // localStorage 可能还保留上一账号，不能据此过早拒绝，也不能据此证明成功。
      const freshAccount = accountFromSelf(live);
      const account = { ...(cached.account || {}) };
      for (const key of ["available", "used", "requestCount", "displayName"]) {
        if (freshAccount[key] != null) account[key] = freshAccount[key];
      }
      login = { ...cached, account };
      break;
    } catch {} // SPA 回调/安全验证期间保留页面继续等，不能使用旧缓存兜底。
  }
  if (!login) return;
  const message = login.userMismatch
    ? "登录账号与配置的用户ID不一致，未确认签到；请切换正确账号后重试"
    : login.checkedIn === true
      ? label + " 重登录回调已确认签到成功"
      : label + " 登录已完成，但本站回调未确认签到；请检查站点签到规则";
  await saveAgentRouterLoginOutcome(pending, login, message);
  await updateAgentRouterPending(tabId, null);
  notify("Agent Router 登录结果", message);
  if (login.ok && login.checkedIn === true) await chrome.tabs.remove(tabId).catch(() => {});
}

// 在目标站点页面内完成 Turnstile 验证，再用同一页面上下文提交签到。
// Turnstile site key 受域名限制，不能在 Service Worker 或扩展页面中渲染。
function tabFetchTurnstileCheckin(accessToken, userId) {
  return new Promise((resolve) => {
    const overlayId = "__nacheckin_turnstile_overlay";
    const old = document.getElementById(overlayId);
    if (old) old.remove();
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      const el = document.getElementById(overlayId);
      if (el) el.remove();
      resolve(value);
    };
    const fail = (message, verified = false) => finish({ ok: false, status: 0, body: { success: false, message }, verified });
    const overlay = document.createElement("div");
    overlay.id = overlayId;
    overlay.style.cssText = "position:fixed;z-index:2147483647;inset:0;background:rgba(0,0,0,.42);display:flex;align-items:center;justify-content:center;font:14px system-ui,sans-serif;color:#1f2937";
    const card = document.createElement("div");
    card.style.cssText = "width:min(420px,calc(100vw - 32px));background:#fff;border-radius:12px;padding:24px;box-shadow:0 16px 48px rgba(0,0,0,.3);text-align:center";
    const title = document.createElement("div");
    title.textContent = "请完成安全验证后签到";
    title.style.cssText = "font-size:18px;font-weight:600;margin-bottom:8px";
    const hint = document.createElement("div");
    hint.textContent = "验证通过后将自动提交签到，请不要关闭此页面。";
    hint.style.cssText = "color:#6b7280;margin-bottom:16px";
    const widget = document.createElement("div");
    widget.style.cssText = "display:flex;justify-content:center;min-height:65px";
    card.append(title, hint, widget);
    overlay.appendChild(card);
    (document.body || document.documentElement).appendChild(overlay);

    const headers = { "Content-Type": "application/json", "Accept": "application/json, text/plain, */*" };
    if (accessToken) headers.Authorization = "Bearer " + accessToken;
    if (userId && /^\d+$/.test(String(userId))) headers["New-Api-User"] = String(userId);
    let submitted = false;
    const submit = async (token) => {
      if (submitted) return;
      submitted = true;
      try {
        const res = await fetch("/api/user/checkin?turnstile=" + encodeURIComponent(token), {
          method: "POST", headers, credentials: "include",
        });
        let body = null;
        try { body = await res.json(); } catch {}
        finish({ ok: res.ok, status: res.status, body, verified: true });
      } catch (e) {
        fail("签到请求失败：" + (e && e.message ? e.message : "无法连接站点"), true);
      }
    };
    const render = (siteKey) => {
      if (!siteKey) return fail("站点未返回 Turnstile site key");
      if (!window.turnstile || typeof window.turnstile.render !== "function") return fail("Turnstile 组件加载失败，请刷新页面重试");
      try {
        window.turnstile.render(widget, {
          sitekey: siteKey,
          callback: (token) => submit(token),
          "error-callback": () => fail("Turnstile 验证失败，请刷新页面重试"),
          "expired-callback": () => fail("Turnstile 验证已过期，请刷新页面重试"),
        });
      } catch (e) {
        fail("Turnstile 初始化失败：" + (e && e.message ? e.message : "未知错误"));
      }
    };
    const load = (siteKey) => {
      if (window.turnstile) return render(siteKey);
      let script = document.querySelector('script[src*="challenges.cloudflare.com/turnstile/v0/api.js"]');
      if (!script) {
        script = document.createElement("script");
        script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
        script.async = true;
        script.defer = true;
        document.head.appendChild(script);
      }
      const started = Date.now();
      const poll = () => {
        if (window.turnstile) return render(siteKey);
        if (Date.now() - started > 15000) return fail("Turnstile 组件加载超时，请刷新页面重试");
        setTimeout(poll, 200);
      };
      poll();
    };
    fetch("/api/status", { credentials: "include" })
      .then((r) => r.json())
      .then((body) => load(body && body.data && body.data.turnstile_site_key))
      .catch(() => fail("无法读取站点 Turnstile 配置"));
    setTimeout(() => fail("等待 Turnstile 验证超时"), 120000);
  });
}

function isTurnstileMissingMessage(message) {
  return /Turnstile\s*(?:token\s*)?(?:为空|empty|missing)|turnstile token is empty/i.test(String(message || ""));
}

async function runTurnstileCheckin(platform) {
  await assertApiAllowed(platform);
  validatePlatform(platform);
  const base = (platform.baseUrl || "").trim().replace(/\/+$/, "");
  const origin = new URL(base).origin;
  let tab = null;
  let createdTabId = null;
  const tabs = await chrome.tabs.query({ url: origin + "/*" }).catch(() => []);
  if (tabs && tabs.length) tab = tabs.find((t) => t.url && !/(login|signin|register)/i.test(t.url)) || tabs[0];
  if (!tab) {
    tab = await chrome.tabs.create({ url: base, active: true });
    createdTabId = tab.id;
  }
  if (tab && tab.id != null) {
    await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
    if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  }
  if (tab && tab.id != null && ((createdTabId != null && tab.status !== "complete") || (createdTabId == null && tab.status && tab.status !== "complete"))) await waitTabComplete(tab.id);
  let result;
  try {
    const out = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: tabFetchTurnstileCheckin,
      args: [isTokenAuthMode(platform) ? String(platform.accessToken || "").trim() : "", String(platform.userId || "").trim()],
    });
    result = out && out[0] && out[0].result;
  } catch (e) {
    throw new Error("无法在站点页面启动 Turnstile 验证：" + (e && e.message ? e.message : "请先打开目标站点"));
  }
  const verified = !!(result && result.verified);
  try {
    return throwOnBadResult(result, "POST", { triggerSelf: false });
  } finally {
    if (verified && createdTabId != null) await chrome.tabs.remove(createdTabId).catch(() => {});
  }
}

// Cookie 模式：复用已打开的同源标签页，没有则临时开一个后台标签页完成后关闭
// 平台签到策略：决定 Cookie 模式下用哪个路径/方法
// Cookie 模式下的只读账户请求策略；Agent Router 的实际签到由 GitHub 重登录完成。
function cookieStrategy(p, base) {
  const h = (p && p.checkinPath || "").trim();
  if (h) {
    return {
      reqPath: h,
      reqMethod: (p.checkinMethod || "POST").toUpperCase(),
      apiUserKey: p.apiUserKey || "New-Api-User",
      triggerSelf: !!p.triggerSelf,
    };
  }
  // 默认与特殊站点
  if (isSiteHost(base, "agentrouter.org")) {
    return { reqPath: "/api/user/self", reqMethod: "GET", apiUserKey: "new-api-user", triggerSelf: true };
  }
  return { reqPath: "/api/user/checkin", reqMethod: "POST", apiUserKey: "New-Api-User", triggerSelf: false };
}

async function callViaTab(p, base, method, month, opts) {
  await assertApiAllowed(p);
  const origin = new URL(base).origin;
  let tab = null;
  let createdTabId = null;
  let keepCreatedTab = false;
  const tabs = await chrome.tabs.query({ url: origin + "/*" }).catch(() => []);
  if (tabs && tabs.length) {
    tab = tabs.find((t) => t.url && !/\/(login|signin|register)/i.test(t.url)) || tabs[0];
  }
  if (!tab) {
    try {
      tab = await chrome.tabs.create({ url: base, active: false });
      createdTabId = tab.id;
      await waitTabComplete(tab.id);
    } catch (e) {
      throw new Error("无法打开站点标签页：" + (e && e.message ? e.message : "未知错误"));
    }
  }
  try {
    let result;
    // Cookie 模式统一按平台策略决定路径/方法（agentrouter 等走 GET /api/user/self）
    const st = cookieStrategy(p, base);
    let reqUrl, reqMethod;
    if (st.triggerSelf) {
      reqUrl = st.reqPath;
      reqMethod = st.reqMethod; // GET
    } else if (method === "POST") {
      reqUrl = "/api/user/checkin";
      reqMethod = "POST";
    } else {
      reqUrl = "/api/user/checkin";
      reqMethod = "GET";
    }
    try {
      const out = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: tabFetchCheckin,
        args: [reqUrl, reqMethod, st.triggerSelf ? null : (month || currentMonth() || null), String(p.userId || "").trim(), st.apiUserKey || null],
      });
      result = out && out[0] && out[0].result;
    } catch (e) {
      throw new Error("在站点标签页执行请求失败：" + (e && e.message ? e.message : "请先在浏览器登录该站点"));
    }
    if (result && result.htmlResponse && /agentrouter\.org/i.test(base)) {
      // WAF 挑战只有在真实页面导航中才会执行；fetch 拿到挑战 HTML 时先打开接口页，完成挑战后重试一次。
      try {
        await chrome.tabs.update(tab.id, { url: new URL(reqUrl, base).toString(), active: true });
        await wait(5000);
        await chrome.tabs.update(tab.id, { url: base, active: true });
        await waitTabComplete(tab.id);
      } catch {}
      try {
        const retry = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: tabFetchCheckin,
          args: [reqUrl, reqMethod, st.triggerSelf ? null : (month || currentMonth() || null), String(p.userId || "").trim(), st.apiUserKey || null],
        });
        result = retry && retry[0] && retry[0].result;
      } catch {}
    }
    if (result && result.htmlResponse && /agentrouter\.org/i.test(base)) {
      await chrome.tabs.update(tab.id, { url: base + "/login", active: true }).catch(() => {});
      keepCreatedTab = true;
    }
    const body = throwOnBadResult(result, reqMethod, st);
    return body;
  } finally {
    if (createdTabId != null && !keepCreatedTab) await chrome.tabs.remove(createdTabId).catch(() => {});
  }
}

// Cookie 模式通用同源请求：用于 /api/user/self、/api/log/self/stat 等
async function callViaTabRaw(p, base, reqPath, method, opts) {
  await assertApiAllowed(p, reqPath);
  const origin = new URL(base).origin;
  let tab = null, createdTabId = null;
  const tabs = await chrome.tabs.query({ url: origin + "/*" }).catch(() => []);
  if (tabs && tabs.length) tab = tabs.find((t) => t.url && !/\/(login|signin|register)/i.test(t.url)) || tabs[0];
  if (!tab) {
    try {
      tab = await chrome.tabs.create({ url: base, active: false });
      createdTabId = tab.id;
      await waitTabComplete(tab.id);
    } catch (e) {
      throw new Error("无法打开站点标签页：" + (e && e.message ? e.message : "未知错误"));
    }
  }
  try {
    let result;
    const apiUserKey = (opts && opts.apiUserKey) || "New-Api-User";
    try {
      const out = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: tabFetchCheckin,
        args: [reqPath, (method || "GET").toUpperCase(), opts && opts.month != null ? opts.month : null, String(p.userId || "").trim(), apiUserKey, opts && opts.query ? opts.query : null],
      });
      result = out && out[0] && out[0].result;
    } catch (e) {
      throw new Error("在站点标签页执行请求失败：" + (e && e.message ? e.message : "请先在浏览器登录该站点"));
    }
    const r = result || {};
    const body = r.body;
    if (!r.ok || (body && body.success === false)) {
      const code = (body && body.code) || "";
      const hint = CODE_HINTS[code] || "";
      throw new Error((body && body.message) || ("请求失败（HTTP " + r.status + "）") + (hint ? " ｜ " + hint : ""));
    }
    if (!body) throw new Error("站点返回了无法解析的数据");
    return body;
  } finally {
    if (createdTabId != null) await chrome.tabs.remove(createdTabId).catch(() => {});
  }
}

// Token 模式通用请求（任意 path + query），headers 与签到一致
async function callApiPath(p, reqPath, method, opts) {
  await assertApiAllowed(p, reqPath);
  validatePlatform(p);
  const base = (p.baseUrl || "").trim().replace(/\/+$/, "");
  const url = new URL(base + reqPath);
  if (opts && opts.month) url.searchParams.set("month", opts.month);
  if (opts && opts.query) for (const k of Object.keys(opts.query)) url.searchParams.set(k, String(opts.query[k]));
  const headers = { "Content-Type": "application/json", "Accept": "application/json, text/plain, */*" };
  const token = (p.accessToken || "").trim();
  if (token) headers["Authorization"] = "Bearer " + token;
  const uid = String(p.userId || "").trim();
  if (uid && /^\d+$/.test(uid)) headers["New-Api-User"] = uid;
  let res;
  try {
    res = await fetch(url.toString(), { method, headers, credentials: "omit" });
  } catch (e) {
    throw new Error("网络请求失败：" + (e && e.message ? e.message : "无法连接站点"));
  }
  const contentType = String(res.headers && res.headers.get ? (res.headers.get("content-type") || "") : "").toLowerCase();
  let text = "";
  try { text = await res.text(); } catch { text = ""; }
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch {}
  if (!body) {
    if (contentType.includes("text/html") || /^\s*<!doctype\s+html|^\s*<html[\s>]/i.test(text)) {
      throw new Error("Agent Router 用户接口返回了网页页面，可能是登录跳转或安全验证（HTTP " + res.status + "）");
    }
    throw new Error("Agent Router 用户接口返回了无法解析的数据（HTTP " + res.status + "）");
  }
  if (!res.ok || body.success === false) {
    const code = (body && body.code) || "";
    const hint = CODE_HINTS[code] || "";
    throw new Error((body.message || "请求失败（HTTP " + res.status + "）") + (hint ? " ｜ " + hint : ""));
  }
  return body;
}

// 按 authMode 分发：Cookie/Agent Router 复用网站原生会话，普通 token 由 Service Worker 直连。
async function callApi(p, reqPath, method, opts) {
  await assertApiAllowed(p, reqPath);
  validatePlatform(p);
  if (p.authMode === "password") await ensurePasswordSession(p);
  const base = (p.baseUrl || "").trim().replace(/\/+$/, "");
  if (p.authMode === "cookie" || p.authMode === "password" || isAgentRouterMode(p)) {
    const st = cookieStrategy(p, base);
    const merged = Object.assign({ apiUserKey: st.apiUserKey }, opts || {});
    return await callViaTabRaw(p, base, reqPath, method, merged);
  }
  return await callApiPath(p, reqPath, method, opts);
}

// 仅访问：始终创建独立临时页，不复用或关闭用户原有标签页。
function waitVisitComplete(tabId) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(updated);
      chrome.tabs.onRemoved.removeListener(removed);
      if (error) reject(error); else resolve();
    };
    const updated = (id, info) => { if (id === tabId && info.status === "complete") finish(); };
    const removed = (id) => { if (id === tabId) finish(new Error("访问页面在加载完成前已关闭")); };
    chrome.tabs.onUpdated.addListener(updated);
    chrome.tabs.onRemoved.addListener(removed);
    timer = setTimeout(() => finish(new Error("访问页面加载超时，页面已保留，请检查站点后重试")), 30000);
    chrome.tabs.get(tabId).then((tab) => {
      if (tab && tab.status === "complete") finish();
    }).catch(() => finish(new Error("无法读取访问页面")));
  });
}
// 必须在线验证 Cookie 会话；不能以页面加载、旧 localStorage 或配置令牌当作网页登录成功。
async function readVisitSession(platform, tabId, allowAccountSwitch = false, allowLoginPage = false) {
  const current = await chrome.tabs.get(tabId).catch(() => null);
  if (!current) throw new Error("访问页面已关闭，未确认登录");
  const origin = new URL(platform.baseUrl).origin;
  let url;
  try { url = new URL(current.url); } catch { throw new Error("访问页面加载失败"); }
  if (!/^https?:$/.test(url.protocol)) throw new Error("访问页面加载失败");
  if (url.origin !== origin) {
    if (isAgentRouterReauthMode(platform)) return null; // 授权站点只能走已有的 state/client_id 校验链路。
    throw new Error("访问页面跳转到其他站点，未确认目标站点登录");
  }
  if (current.status !== "complete") return null;
  let probe;
  try {
    const out = await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func: tabFetchCheckin,
      args: ["/api/user/self", "GET", null, String(platform.userId || ""), cookieStrategy(platform, platform.baseUrl).apiUserKey] });
    probe = out && out[0] && out[0].result;
  } catch { return null; } // SPA 导航或安全验证期间，不能宣称已登录。
  const user = probe && probe.ok && probe.body && probe.body.success !== false && probe.body.data;
  if (!user || user.id == null || !/^\d+$/.test(String(user.id))) return null;
  if (allowAccountSwitch && platform.authMode === "password" && !passwordUserMatches(platform, user)) return null;
  if (allowAccountSwitch && isAgentRouterReauthMode(platform) && platform.userId && String(platform.userId).trim() !== String(user.id)) return null;
  verifyConfiguredUser(platform, probe.body);
  if (platform.authMode === "password" && !passwordUserMatches(platform, user)) {
    throw new Error("本站登录账号与配置的邮箱/用户名不一致，页面已保留");
  }
  // 登录/回调页面还未完成前端导航，不能立即关闭。
  const latest = await chrome.tabs.get(tabId).catch(() => null);
  if (!latest) throw new Error("访问页面已关闭，未确认登录");
  const latestUrl = new URL(latest.url);
  if (latestUrl.origin !== origin) throw new Error("身份核验期间页面跳转到其他站点，未确认登录");
  if (latest.status !== "complete" || (!allowLoginPage && /^\/(login|signin|register|oauth)(\/|$)/i.test(latestUrl.pathname))) return null;
  return user;
}

async function waitVisitSession(platform, tabId, oauth = false, allowLoginPage = false, requireQuota = false) {
  const deadline = Date.now() + 120000;
  for (let i = 0; i < 150 && Date.now() < deadline; i++) {
    if (oauth) {
      const current = await chrome.tabs.get(tabId).catch(() => null);
      if (!current) throw new Error("访问登录页已关闭，未确认登录");
      await handleAgentRouterReauthTab(tabId, current.url);
      const pending = (await getAgentRouterPending())[tabId];
      if (!pending || !pending.callbackSeen) { await wait(800); continue; }
    }
    const user = await readVisitSession(platform, tabId, false, allowLoginPage);
    if (user && (!requireQuota || hasAccountQuota(user))) return user;
    await wait(800);
  }
  throw new Error("尚未确认目标账号登录或最新额度，页面已保留；请完成登录、验证码或授权后重新访问");
}

// 所有账户/日志请求固定使用本轮临时页，不重新开登录页或读取其他账号的页面。
async function readVisitApi(platform, tabId, reqPath, query) {
  await assertApiAllowed(platform, reqPath);
  const origin = new URL(platform.baseUrl).origin;
  const checkPage = async () => {
    const page = await chrome.tabs.get(tabId);
    if (!page.url || new URL(page.url).origin !== origin || page.status !== "complete" ||
        /^\/(login|signin|register|oauth)(\/|$)/i.test(new URL(page.url).pathname)) {
      throw new Error("刷新账户时页面登录状态已变化，页面已保留");
    }
  };
  await checkPage();
  const st = cookieStrategy(platform, platform.baseUrl);
  const out = await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func: tabFetchCheckin,
    args: [reqPath, "GET", null, String(platform.userId || ""), st.apiUserKey, query || null] });
  await checkPage();
  const result = out && out[0] && out[0].result;
  if (!result || !result.ok || !result.body || result.body.success === false) {
    throw new Error(result && result.body && result.body.message || "无法获取最新账户数据");
  }
  return result.body;
}

async function runVisitOnly(platform, options) {
  validatePlatform(platform);
  const origin = new URL(platform.baseUrl).origin;
  const home = origin + "/";
  if (visitOnlyOrigins.has(origin) || passwordLoginInflight.has(origin) || agentRouterStarting.has(origin)) {
    throw new Error("本站有其他访问或登录任务尚未完成，请稍后重试");
  }
  visitOnlyOrigins.add(origin);
  let tab, completed = false, oauth = false;
  try {
    await waitForAgentRouterTurn(platform);
    tab = await chrome.tabs.create({ url: home, active: false });
    if (!tab || tab.id == null) throw new Error("无法创建访问页面");
    await waitVisitComplete(tab.id);
    const user = await readVisitSession(platform, tab.id, true);
    // 与普通任务一致：依赖登录回调的站点需要重新登录，不能用旧会话跳过该动作。
    const reauth = !!(options && options.reauth);
    const forceLogin = reauth && (isAgentRouterReauthMode(platform) ||
      (platform.authMode === "password" && isSelfTriggerMode(platform)));
    if (!user || forceLogin) {
      if (platform.authMode === "password") {
        await loginPasswordOnTab(platform, tab, forceLogin);
      } else {
        if (isAgentRouterReauthMode(platform)) {
          // 进入 OAuth 就必须退出旧站点会话，即使它属于另一提供方/账号。
          const out = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: "MAIN", func: tabLogout });
          if (!out || !out[0] || !out[0].result || !out[0].result.ok) throw new Error("无法退出旧登录会话，页面已保留");
          clearSiteSessionTokens(origin);
          oauth = true;
          await updateAgentRouterPending(tab.id, { tabId: tab.id, base: platform.baseUrl, origin,
            platformId: platform.id || null, userId: String(platform.userId || ""), authMode: platform.authMode,
            provider: agentRouterProvider(platform), visitOnly: true, oauthStarted: false, createdAt: Date.now() });
        }
        await chrome.tabs.update(tab.id, { url: origin + "/login", active: true });
        await waitVisitComplete(tab.id);
      }
      await waitVisitSession(platform, tab.id, oauth, true);
    }
    // 无论旧会话还是刚完成登录，都刷新首页一次，再在线读取额度；不等同于“额度必须上涨”。
    await chrome.tabs.update(tab.id, { url: home, active: false });
    await waitVisitComplete(tab.id);
    const freshUser = await waitVisitSession(platform, tab.id, false, false, true);
    const read = (reqPath, query) => readVisitApi(platform, tab.id, reqPath, query);
    const account = await fetchAccount(platform, currentMonth(), freshUser, read);
    // 日志取数期间共享会话可能变化；关闭前再核验，并以这份在线数据更新最终额度。
    const finalUser = await waitVisitSession(platform, tab.id, false, false, true);
    Object.assign(account, accountFromSelf(finalUser, account.monthlyTokens, account.tokensTruncated, account._warn));
    const previous = platform.account && platform.account.available;
    const quotaDelta = previous != null && previous !== "" && Number.isFinite(Number(previous))
      ? Number(account.available) - Number(previous) : null;
    // 先发布最新账户信息，让侧边栏/管理页同步额度，再关闭临时页。
    await mutatePlatforms((list) => {
      const current = list.find((entry) => entry.id === platform.id);
      if (current && sameTaskConfig(current, platform)) current.account = Object.assign({}, current.account || {}, account);
      return list;
    });
    if (oauth) { await updateAgentRouterPending(tab.id, null); oauth = false; }
    await chrome.tabs.remove(tab.id); // 只有登录、刷新和最新额度都确认成功，才关闭本轮临时页。
    completed = true;
    return { ok: true, visited: true, outcome: "visited", message: "登录及刷新完成，最新额度已更新，临时页已关闭（已跳过签到接口）",
      data: null, account, quotaDelta, lastVisitedAt: new Date().toISOString(), lastVisitDate: todayStr() };
  } finally {
    try {
      if (oauth && tab) await updateAgentRouterPending(tab.id, null);
      if (!completed && tab) await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
    } finally { visitOnlyOrigins.delete(origin); }
  }
}

// 签到 / 仅访问
async function runCheckin(platform, options) {
  try {
    platform = await resolveSavedVisitOnly(platform);
    if (isVisitOnly(platform)) return await runVisitOnly(platform, options);
    // Agent Router 通过退出并重新登录签到；其他自触发兼容站点仍使用 GET 请求。
    const isSelfTrigger = isSelfTriggerMode(platform);
    const method = isSelfTrigger ? "GET" : "POST";
    let body;
    try {
      body = await callCheckin(platform, method, null, {
        reauth: !!(options && options.reauth),
      });
    } catch (e) {
      if (!isTurnstileMissingMessage(e && e.message)) throw e;
      body = await runTurnstileCheckin(platform);
    }
    let data = body.data;
    // 部分兼容站点的 POST 只返回奖励额度；追加一次只读 GET，补齐本月统计。
    if (!isSelfTrigger && !(data && data.stats)) {
      try {
        const statsBody = await callCheckin(platform, "GET", currentMonth());
        if (statsBody && statsBody.data) data = { ...(data || {}), ...statsBody.data };
      } catch {
        // 签到已经成功，统计接口不可用时保留签到结果，不将整体降级为失败。
      }
    }
    const awarded = data && data.quota_awarded;
    const uname = data && (data.username || data.display_name);
    let msg = body.message;
    if (body._reauthRequired) {
      return { ok: true, pending: true, outcome: "pending", message: body.message || "等待登录完成并确认签到", data: null,
        reauthRequired: true, reauthStartedAt: body._reauthStartedAt, oauthLoginStarted: !!body._oauthLoginStarted, githubLoginStarted: !!body._githubLoginStarted };
    }
    // 仅仅读取 Agent Router 用户信息不能证明签到。
    if (isAgentRouterReauthMode(platform)) throw new Error("当前操作仅刷新了账户信息，未执行重登录签到");
    if (!msg) {
      if (awarded != null) msg = "签到成功，获得额度 " + awarded;
      else if (isSelfTrigger) msg = (uname ? "用户「" + uname + "」" : "") + "信息请求成功，签到已自动完成";
      else msg = "签到请求成功";
    }
    return {
      ok: true,
      message: msg,
      data,
      reauthRequired: !!body._reauthRequired,
      githubLoginStarted: !!body._githubLoginStarted,
    };
  } catch (e) {
    return { ok: false, message: e.message, error: e.message };
  }
}

// 统计（GET，也用于检测连接）
// 月份边界时间戳（秒）
function monthRangeTs(month) {
  const [y, m] = (month || currentMonth()).split("-");
  const Y = Number(y), M = Number(m);
  const start = Math.floor(new Date(Y, M - 1, 1, 0, 0, 0).getTime() / 1000);
  const end = Math.floor(new Date(Y, M, 1, 0, 0, 0).getTime() / 1000) - 1;
  return { start, end };
}

// 拉 /api/user/self 的账户数据（token 或 cookie 模式自适应）
// 分页累加月内所有日志的 prompt_tokens + completion_tokens（上游无现成 token 总数接口）
async function fetchMonthlyTokens(platform, month, read) {
  const { start, end } = monthRangeTs(month);
  let tokens = 0, total = null, page = 1, guard = 0, truncated = false;
  const per = 100;
  for (;;) {
    if (++guard > 40) { truncated = true; break; }
    let body;
    try {
      const query = { start_timestamp: start, end_timestamp: end, type: 0, p: page, per };
      body = read ? await read("/api/log/self", query) : await callApi(platform, "/api/log/self", "GET", { query });
    } catch (e) {
      return tokens > 0 ? { tokens, truncated: true } : null;
    }
    const data = body && body.data;
    let logs = null;
    if (Array.isArray(data)) logs = data;
    else if (data && Array.isArray(data.items)) { logs = data.items; if (total == null) total = data.total ?? null; }
    else if (data && Array.isArray(data.logs)) { logs = data.logs; if (total == null) total = data.total ?? null; }
    else if (data && Array.isArray(data.data)) { logs = data.data; }
    if (!logs) return tokens > 0 ? { tokens, truncated: true } : null;
    for (const it of logs) {
      tokens += Number(it.prompt_tokens || 0) + Number(it.completion_tokens || 0);
    }
    if (total == null) total = body.total ?? null;
    if (logs.length < per) break;
    if (total != null && page * per >= total) break;
    page++;
  }
  return { tokens, truncated };
}

async function fetchAccount(platform, month, reuseSelfData, read) {
  validatePlatform(platform);
  if (!read && await isAgentRouterReauthPending(platform)) {
    throw new Error("Agent Router 正在重新登录，请在登录完成后刷新额度");
  }
  let selfData = reuseSelfData || null;
  let selfErr = "";
  let accountWarn = "";
  if (!selfData) {
    try {
      let selfBody;
      if (read) {
        selfBody = await read("/api/user/self");
      } else if (isAgentRouterReauthMode(platform)) {
        const result = await callAgentRouterAccountViaTab(
          platform,
          (platform.baseUrl || "").trim().replace(/\/+$/, ""),
        );
        selfBody = result.body;
        accountWarn = result.warning || "";
      } else {
        selfBody = await callApi(platform, "/api/user/self", "GET");
      }
      if (isAgentRouterReauthMode(platform)) verifyConfiguredUser(platform, selfBody);
      selfData = (selfBody && selfBody.data) || null;
    } catch (e) {
      if (e && e.code === "ACCOUNT_MISMATCH") throw e;
      selfErr = e && e.message ? e.message : String(e); selfData = null;
    }
  }
  let monthlyTokens = null, tokensTruncated = false, tokenErr = "";
  try {
    const r = await fetchMonthlyTokens(platform, month, read);
    if (r) { monthlyTokens = r.tokens; tokensTruncated = !!r.truncated; }
    else tokenErr = "日志接口无数据";
  } catch (e) { tokenErr = e && e.message ? e.message : String(e); }
  if (!selfData && monthlyTokens == null) {
    throw new Error("获取账户额度失败：" + (selfErr || tokenErr || "账号接口不可用"));
  }
  if (!selfData && monthlyTokens != null) {
    throw new Error("获取账户额度失败：用户接口不可用（" + (selfErr || "未返回账户额度") + "）；本月 Token 统计仍可用");
  }
  const warnings = [];
  if (accountWarn) warnings.push(accountWarn);
  if (tokensTruncated) warnings.push("本月Token为前若干页累计估算（超出截断）");
  else if (monthlyTokens == null) warnings.push("本月Token接口不可用");
  return accountFromSelf(selfData, monthlyTokens, tokensTruncated, warnings.join("；"));
}

function hasAccountQuota(data) {
  const quota = accountFromSelf(data).available;
  return (typeof quota === "number" || (typeof quota === "string" && quota.trim() !== "")) && Number.isFinite(Number(quota));
}

function accountFromSelf(selfData, monthlyTokens = null, tokensTruncated = false, warning = "") {
  const quotaValue = (data, names) => {
    if (!data) return null;
    for (const name of names) {
      if (data[name] != null && data[name] !== "") return data[name];
    }
    return null;
  };
  return {
    available: quotaValue(selfData, ["quota", "available", "available_quota", "remaining_quota"]),
    used: quotaValue(selfData, ["used_quota", "usedQuota", "used"]),
    requestCount: quotaValue(selfData, ["request_count", "requestCount"]),
    monthlyTokens,
    tokensTruncated,
    displayName: selfData ? (selfData.display_name || selfData.displayName || selfData.username) : null,
    _warn: warning,
  };
}

function unverifiedOauthConfig(platform) {
  return { ok: true, configOnly: true, needsLogin: true, data: null,
    message: "配置已校验，尚未确认此账号登录；执行任务时将通过 " + agentRouterProviderLabel(agentRouterProvider(platform)) + " 登录" + (platform.userId ? "用户ID " + String(platform.userId).trim() : "对应账号") + "，不会沿用其他账号的额度" };
}

async function runStats(platform, month) {
  platform = await resolveSavedVisitOnly(platform);
  // 配置校验失败不能靠账户缓存降级为连接成功。
  try { validatePlatform(platform); }
  catch (e) { return { ok: false, message: e.message, error: e.message }; }
  if (isAgentRouterReauthMode(platform)) {
    try {
      if (await isAgentRouterReauthPending(platform)) return unverifiedOauthConfig(platform);
      const result = await callAgentRouterAccountViaTab(platform, platform.baseUrl.trim().replace(/\/+$/, ""), true);
      const account = await fetchAccount(platform, month || currentMonth(), result.body.data);
      return { ok: true, message: "当前账号在线身份及额度已确认", data: null, account };
    } catch (e) {
      if (e && ["ACCOUNT_MISMATCH", "AUTH_NOT_LOGGED_IN"].includes(e.code)) {
        return unverifiedOauthConfig(platform);
      }
      return { ok: false, message: e.message, error: e.message };
    }
  }
  if (isVisitOnly(platform)) {
    try {
      const account = await fetchAccount(platform, month || currentMonth(), null);
      return { ok: true, message: "登录及额度检测成功（已跳过签到接口）", data: null, account };
    } catch (e) { return { ok: false, message: e.message, error: e.message }; }
  }
  const isSelfTrigger = isSelfTriggerMode(platform);
  try {
    const body = await callCheckin(platform, "GET", month);
    const account = await fetchAccount(platform, month || currentMonth(), isSelfTrigger && body.data ? body.data : null);
    return { ok: true, message: body.message || "统计数据已更新", data: body.data, account };
  } catch (e) {
    try {
      const account = await fetchAccount(platform, month || currentMonth(), null);
      if (account) return { ok: true, message: "额度已更新（签到统计不可用）", data: null, account };
    } catch {}
    return { ok: false, message: e.message, error: e.message };
  }
}

// ---------- 模型可用性与性能指标（全部只读，不触发签到） ----------
// 数据来自上游 NewAPI 自带接口，无需真实调用模型，也不消耗额度：
//   GET /api/status                     -> 版本、quota_per_unit、pricing 导航模块开关
//   GET /api/perf-metrics/summary       -> 各模型成功率/平均延迟/TPS（仅含近期有流量的模型）
//   GET /api/perf-metrics?model=xxx     -> 单模型分组明细，含首字延迟 avg_ttft_ms 与时间序列
//   GET /api/pricing                    -> 站点完整模型清单，用于左连接补齐"无流量"的模型
// 注意：success_rate 上游已是 0-100 的百分数，不要再乘 100。
const PERF_HOURS_DEFAULT = 24;

// 只读 GET：保留 HTTP 状态码，便于区分"版本不支持(404)"和"令牌无效(401)"。
// 不复用 callApiPath，避免把状态码丢进异常里，也避免影响既有签到链路。
async function rawGetJson(p, reqPath, query) {
  await assertApiAllowed(p, reqPath);
  const base = (p.baseUrl || "").trim().replace(/\/+$/, "");
  let url;
  try {
    url = new URL(base + reqPath);
  } catch {
    return { ok: false, status: 0, message: "站点地址格式不正确" };
  }
  if (query) for (const k of Object.keys(query)) url.searchParams.set(k, String(query[k]));
  const headers = { "Accept": "application/json, text/plain, */*" };
  const token = (p.accessToken || "").trim();
  if (token) headers["Authorization"] = "Bearer " + token;
  const uid = String(p.userId || "").trim();
  if (uid && /^\d+$/.test(uid)) headers["New-Api-User"] = uid;
  let res;
  try {
    res = await fetch(url.toString(), { method: "GET", headers, credentials: "omit" });
  } catch (e) {
    return { ok: false, status: 0, message: "网络请求失败：" + (e && e.message ? e.message : "无法连接站点") };
  }
  const contentType = String(res.headers.get("content-type") || "").toLowerCase();
  let text = "";
  try { text = await res.text(); } catch { text = ""; }
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch {}
  if (!body) {
    const isHtml = contentType.includes("text/html") || /^\s*<!doctype\s+html|^\s*<html[\s>]/i.test(text);
    return {
      ok: false,
      status: res.status,
      message: isHtml
        ? "站点返回了网页而非接口数据，可能被安全验证拦截（HTTP " + res.status + "）"
        : "站点返回了无法解析的数据（HTTP " + res.status + "）",
    };
  }
  if (!res.ok || body.success === false) {
    const hint = CODE_HINTS[(body && body.code) || ""] || "";
    return {
      ok: false,
      status: res.status,
      body,
      message: (body.message || "请求失败（HTTP " + res.status + "）") + (hint ? " ｜ " + hint : ""),
    };
  }
  return { ok: true, status: res.status, body };
}

// 只有「访问令牌」模式能由 Service Worker 直连；另两种模式复用站点登录态。
function isTokenAuthMode(p) {
  return !p || !p.authMode || p.authMode === "token";
}

// ---- Cookie / Agent Router 模式的只读取数通道 ----
// 新版 NewAPI 的 UserAuth() 只认 Authorization 头（middleware/auth.go 里
// classifyDashboardCredential 第一行就读该头，取不到直接判定凭证不匹配），
// 所以纯 Cookie 请求后台接口一律 401。POST /api/user/auth/refresh 可以用登录
// Cookie 换取有效期 15 分钟的 access token，但它挂了 SessionCookieOriginGuard()，
// 要求 Origin/Referer 与站点同源，Service Worker 直连会被判 403。
// 因此这两种模式与既有签到链路一致：统一在站点标签页内同源执行。
const SESSION_TOKEN_SKEW_MS = 60000;
const SESSION_TOKEN_FALLBACK_MS = 10 * 60 * 1000;
const sessionTokenCache = new Map();
const sessionTokenInflight = new Map();

// 站点页面内只读 GET：自动携带登录 Cookie，可按需附加 Authorization。
// 独立于 tabFetchCheckin，避免为了加一个请求头而改动既有签到链路。
function tabGetPerfJson(reqPath, query, bearer, apiUserKey, userId) {
  return (async () => {
    let url;
    try {
      url = new URL(reqPath, location.origin);
    } catch {
      return { status: 0, httpOk: false, netError: "接口路径不合法" };
    }
    if (url.origin !== location.origin) return { status: 0, httpOk: false, netError: "禁止向其他站点发送会话令牌" };
    if (query) for (const k of Object.keys(query)) url.searchParams.set(k, String(query[k]));
    const headers = { "Accept": "application/json, text/plain, */*", "Cache-Control": "no-store" };
    if (bearer) headers["Authorization"] = "Bearer " + bearer;
    if (userId && apiUserKey) headers[apiUserKey] = String(userId);
    let res;
    try {
      res = await fetch(url.toString(), { method: "GET", headers, credentials: "include" });
    } catch (e) {
      return { status: 0, httpOk: false, netError: "网络请求失败：" + (e && e.message ? e.message : "无法连接站点") };
    }
    const contentType = String(res.headers.get("content-type") || "").toLowerCase();
    let text = "";
    try { text = await res.text(); } catch { text = ""; }
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch {}
    const isHtml = contentType.includes("text/html") || /^\s*<!doctype\s+html|^\s*<html[\s>]/i.test(text);
    return { status: res.status, httpOk: res.ok, body, isHtml };
  })();
}

// 站点页面内用登录 Cookie 换取 access token（同源发起才能过 Origin 校验）。
function tabRefreshAuthToken() {
  return (async () => {
    let res;
    try {
      res = await fetch(new URL("/api/user/auth/refresh", location.origin).toString(), {
        method: "POST",
        headers: {
          "Accept": "application/json, text/plain, */*",
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
        credentials: "include",
        body: "{}",
      });
    } catch (e) {
      return { status: 0, httpOk: false, netError: "网络请求失败：" + (e && e.message ? e.message : "无法连接站点") };
    }
    let text = "";
    try { text = await res.text(); } catch { text = ""; }
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch {}
    const data = body && body.data ? body.data : null;
    return {
      status: res.status,
      httpOk: res.ok,
      success: body ? body.success !== false : false,
      token: data && data.access_token ? String(data.access_token) : "",
      expiresAt: data && data.access_expires_at != null ? Number(data.access_expires_at) : null,
      message: body && body.message ? String(body.message) : "",
      code: body && body.code ? String(body.code) : "",
    };
  })();
}

// access_expires_at 可能是秒级或毫秒级时间戳，统一成毫秒。
function normalizeTokenExpiry(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return Date.now() + SESSION_TOKEN_FALLBACK_MS;
  return n < 1e12 ? n * 1000 : n;
}

function sessionTokenKey(base, userId) {
  let origin = base;
  try { origin = new URL(base).origin; } catch {}
  return origin + "#" + (userId || "");
}

function readSessionToken(key) {
  const hit = sessionTokenCache.get(key);
  if (!hit) return "";
  if (hit.expiresAt - Date.now() <= SESSION_TOKEN_SKEW_MS) {
    sessionTokenCache.delete(key);
    return "";
  }
  return hit.token;
}

// /api/user/auth/refresh 带 CriticalRateLimit() 且会轮换 refresh Cookie，
// 同一站点的并发请求必须共用同一次换取结果，避免限流与刷新竞争。
async function acquireSessionToken(tabId, key, staleToken) {
  const cached = readSessionToken(key);
  if (cached && cached !== staleToken) return { ok: true, token: cached };
  const running = sessionTokenInflight.get(key);
  if (running) return await running;
  const task = (async () => {
    let out;
    try {
      out = await chrome.scripting.executeScript({ target: { tabId }, func: tabRefreshAuthToken });
    } catch (e) {
      return { ok: false, message: "在站点标签页换取会话令牌失败：" + (e && e.message ? e.message : "请先在浏览器登录该站点") };
    }
    const r = (out && out[0] && out[0].result) || null;
    if (!r) return { ok: false, message: "站点标签页没有返回会话令牌" };
    if (r.netError) return { ok: false, message: r.netError };
    if (!r.httpOk || !r.success || !r.token) {
      sessionTokenCache.delete(key);
      if (r.status === 404) {
        return { ok: false, status: 404, message: "该站点没有 /api/user/auth/refresh 接口，无法用登录状态读取后台指标。" };
      }
      const hint = CODE_HINTS[r.code || ""] || "";
      const detail = r.message || "HTTP " + r.status;
      return {
        ok: false,
        status: r.status,
        message: "无法用登录状态换取会话令牌（" + detail + "）" + (hint ? " ｜ " + hint : "") +
          "，请先在浏览器中打开并登录该站点，然后重试。",
      };
    }
    sessionTokenCache.set(key, { token: r.token, expiresAt: normalizeTokenExpiry(r.expiresAt) });
    return { ok: true, token: r.token };
  })();
  sessionTokenInflight.set(key, task);
  try {
    return await task;
  } finally {
    sessionTokenInflight.delete(key);
  }
}

// 把注入结果归一化成与 rawGetJson 一致的契约：{ ok, status, body, message }
async function injectGetJson(tabId, reqPath, query, bearer, apiUserKey, userId) {
  let out;
  try {
    out = await chrome.scripting.executeScript({
      target: { tabId },
      func: tabGetPerfJson,
      args: [reqPath, query || null, bearer || null, apiUserKey || null, userId || null],
    });
  } catch (e) {
    return { ok: false, status: 0, message: "在站点标签页执行请求失败：" + (e && e.message ? e.message : "请先在浏览器登录该站点") };
  }
  const r = (out && out[0] && out[0].result) || null;
  if (!r) return { ok: false, status: 0, message: "站点标签页没有返回数据" };
  if (r.netError) return { ok: false, status: r.status || 0, message: r.netError };
  if (!r.body) {
    return {
      ok: false,
      status: r.status,
      message: r.isHtml
        ? "站点返回了网页而非接口数据，可能是登录跳转或安全验证（HTTP " + r.status + "）"
        : "站点返回了无法解析的数据（HTTP " + r.status + "）",
    };
  }
  if (!r.httpOk || r.body.success === false) {
    const hint = CODE_HINTS[(r.body && r.body.code) || ""] || "";
    return {
      ok: false,
      status: r.status,
      body: r.body,
      message: (r.body.message || "请求失败（HTTP " + r.status + "）") + (hint ? " ｜ " + hint : ""),
    };
  }
  return { ok: true, status: r.status, body: r.body };
}

// 复用已打开的站点标签页；没有就临时开一个后台标签页，结束后关掉。
async function withSiteTab(base, fn) {
  let origin;
  try {
    origin = new URL(base).origin;
  } catch {
    throw new Error("站点地址格式不正确");
  }
  let tab = null;
  let createdTabId = null;
  const tabs = await chrome.tabs.query({ url: origin + "/*" }).catch(() => []);
  if (tabs && tabs.length) {
    tab = tabs.find((t) => t.url && !/\/(login|signin|register)/i.test(t.url)) || tabs[0];
  }
  if (!tab) {
    try {
      tab = await chrome.tabs.create({ url: base, active: false });
      createdTabId = tab.id;
      await waitTabComplete(tab.id);
    } catch (e) {
      throw new Error("无法打开站点标签页：" + (e && e.message ? e.message : "未知错误"));
    }
  }
  try {
    return await fn(tab.id);
  } finally {
    if (createdTabId != null) await chrome.tabs.remove(createdTabId).catch(() => {});
  }
}

// 取数通道：token 模式由 Service Worker 直连；Cookie / Agent Router 模式在站点
// 标签页内同源请求。先不带 Authorization 试一次（旧内核 TryUserAuth 允许匿名读，
// 这样对它们零副作用），只有明确 401 时才换会话令牌重试。
async function withInsightReader(platform, fn) {
  const base = (platform.baseUrl || "").trim().replace(/\/+$/, "");
  if (isTokenAuthMode(platform)) {
    return await fn((reqPath, query) => rawGetJson(platform, reqPath, query));
  }
  if (await isAgentRouterReauthPending(platform)) throw new Error("本站正在重新登录，请完成后读取模型数据");
  if (platform.authMode === "password") await ensurePasswordSession(platform);
  const st = cookieStrategy(platform, base);
  const apiUserKey = st.apiUserKey || "New-Api-User";
  const userId = String(platform.userId || "").trim();
  const key = sessionTokenKey(base, userId);
  return await withSiteTab(base, async (tabId) => {
    const read = async (reqPath, query) => {
      await assertApiAllowed(platform, reqPath);
      const bearer = readSessionToken(key);
      const first = await injectGetJson(tabId, reqPath, query, bearer, apiUserKey, userId);
      if (first.ok || first.status !== 401) return first;
      const got = await acquireSessionToken(tabId, key, bearer);
      if (!got.ok) return { ok: false, status: first.status, message: got.message || first.message };
      if (got.token === bearer) return first;
      return await injectGetJson(tabId, reqPath, query, got.token, apiUserKey, userId);
    };
    return await fn(read);
  });
}

// 解析 /api/status 里的 pricing 导航模块：决定 perf-metrics 是否可用/是否要求登录。
function parsePricingModule(statusData) {
  let nav = statusData && statusData.HeaderNavModules;
  if (typeof nav === "string") {
    try { nav = JSON.parse(nav); } catch { nav = null; }
  }
  const pricing = nav && nav.pricing;
  if (pricing == null) return { present: false, enabled: null, requireAuth: null };
  if (typeof pricing === "boolean") return { present: true, enabled: pricing, requireAuth: null };
  return {
    present: true,
    enabled: pricing.enabled !== false,
    requireAuth: pricing.requireAuth === true,
  };
}

function normalizePerfEntry(entry) {
  if (!entry) return null;
  const num = (v) => (v == null || v === "" || Number.isNaN(Number(v)) ? null : Number(v));
  return {
    successRate: num(entry.success_rate),
    avgLatencyMs: num(entry.avg_latency_ms),
    avgTps: num(entry.avg_tps),
    avgTtftMs: num(entry.avg_ttft_ms),
    recentSuccessRates: Array.isArray(entry.recent_success_rates)
      ? entry.recent_success_rates.map(num).filter((v) => v != null)
      : [],
  };
}

// 以 /api/pricing 的完整模型清单为骨架左连接 perf 指标；
// perf 里出现但 pricing 未返回的模型（例如你的分组看不到但站点有流量）也补进来并标记。
function joinModelInsight(catalog, perfModels) {
  const perfMap = new Map();
  for (const m of perfModels) {
    const name = String((m && m.model_name) || "").trim();
    if (name) perfMap.set(name, m);
  }
  const rows = [];
  const seen = new Set();
  for (const item of catalog) {
    const name = String((item && item.model_name) || "").trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    rows.push({
      model: name,
      vendor: String((item && item.owner_by) || ""),
      groups: Array.isArray(item && item.enable_groups) ? item.enable_groups : [],
      inCatalog: true,
      perf: normalizePerfEntry(perfMap.get(name)),
    });
  }
  for (const m of perfModels) {
    const name = String((m && m.model_name) || "").trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    rows.push({ model: name, vendor: "", groups: [], inCatalog: false, perf: normalizePerfEntry(m) });
  }
  return rows;
}

// ---- 无 perf-metrics 站点的降级指标：从「我的调用日志」聚合 ----
// 老版 new-api 分支（例如 Agent Router，/api/status 的 version 形如
// init-2026xxxx-xxxxxxx、且没有 HeaderNavModules 字段）没有 perf_metrics 模块，
// /api/perf-metrics 一律 404。它们的 /api/log/self 里有足够的信息可以还原
// 成功率与延迟：type=2 是消费（成功），type=5 是错误（失败），use_time 是秒，
// other 里的 frt 是首字毫秒。据此聚合出的是「你自己的调用表现」而非站点全局。
const LOG_PAGE_SIZE = 100;
const LOG_MAX_PAGES = 6;
const LOG_TYPE_CONSUME = 2;
const LOG_TYPE_ERROR = 5;

function parseLogOther(raw) {
  if (!raw) return null;
  if (typeof raw === "object") return raw;
  try { return JSON.parse(String(raw)); } catch { return null; }
}

// /api/log/self/ 返回 { success, data: { items, page, page_size, total } }
async function fetchSelfLogs(read, hours, modelName) {
  const endTs = Math.floor(Date.now() / 1000);
  const startTs = endTs - Math.max(1, Number(hours) || PERF_HOURS_DEFAULT) * 3600;
  const items = [];
  let lastError = "";
  for (let page = 1; page <= LOG_MAX_PAGES; page++) {
    const query = {
      p: page,
      page_size: LOG_PAGE_SIZE,
      type: 0,
      start_timestamp: startTs,
      end_timestamp: endTs,
    };
    if (modelName) query.model_name = modelName;
    const res = await read("/api/log/self/", query);
    if (!res.ok) {
      lastError = res.message || "无法读取调用日志";
      break;
    }
    const data = (res.body && res.body.data) || {};
    const batch = Array.isArray(data.items) ? data.items : (Array.isArray(data) ? data : []);
    for (const it of batch) items.push(it);
    if (batch.length < LOG_PAGE_SIZE) break;
  }
  return { items, error: lastError, startTs, endTs };
}

function finishLogAccumulator(acc) {
  const ok = acc.total - acc.fail;
  return {
    successRate: acc.total ? Number(((ok / acc.total) * 100).toFixed(2)) : null,
    avgLatencyMs: acc.useTimeN ? Math.round((acc.useTimeSum / acc.useTimeN) * 1000) : null,
    avgTtftMs: acc.frtN ? Math.round(acc.frtSum / acc.frtN) : null,
    avgTps: acc.tokenTime > 0 ? Number((acc.tokens / acc.tokenTime).toFixed(2)) : null,
    recentSuccessRates: [],
    sampleCount: acc.total,
  };
}

function newLogAccumulator() {
  return { total: 0, fail: 0, useTimeSum: 0, useTimeN: 0, frtSum: 0, frtN: 0, tokens: 0, tokenTime: 0 };
}

function accumulateLogEntry(acc, it) {
  const type = Number(it && it.type);
  if (type !== LOG_TYPE_CONSUME && type !== LOG_TYPE_ERROR) return false;
  acc.total++;
  if (type === LOG_TYPE_ERROR) acc.fail++;
  const use = Number(it.use_time);
  if (Number.isFinite(use) && use > 0) {
    acc.useTimeSum += use;
    acc.useTimeN++;
  }
  const other = parseLogOther(it.other);
  const frt = other && other.frt != null ? Number(other.frt) : null;
  if (frt != null && Number.isFinite(frt) && frt > 0) {
    acc.frtSum += frt;
    acc.frtN++;
  }
  const completion = Number(it.completion_tokens);
  if (type === LOG_TYPE_CONSUME && Number.isFinite(completion) && completion > 0 && Number.isFinite(use) && use > 0) {
    acc.tokens += completion;
    acc.tokenTime += use;
  }
  return true;
}

// 聚合成与 normalizePerfEntry 同构的对象，好让左连接与渲染逻辑复用。
function aggregateLogPerf(items) {
  const byModel = new Map();
  for (const it of items) {
    const name = String((it && it.model_name) || "").trim();
    if (!name) continue;
    let acc = byModel.get(name);
    if (!acc) {
      acc = newLogAccumulator();
      byModel.set(name, acc);
    }
    accumulateLogEntry(acc, it);
  }
  const out = new Map();
  for (const [name, acc] of byModel) {
    if (acc.total > 0) out.set(name, finishLogAccumulator(acc));
  }
  return out;
}

// 按整小时分桶，产出与 perf-metrics series 同构的趋势点。
function aggregateLogSeries(items) {
  const buckets = new Map();
  for (const it of items) {
    const created = Number(it && it.created_at);
    if (!Number.isFinite(created) || created <= 0) continue;
    const bucket = Math.floor(created / 3600) * 3600;
    let acc = buckets.get(bucket);
    if (!acc) {
      acc = newLogAccumulator();
      buckets.set(bucket, acc);
    }
    accumulateLogEntry(acc, it);
  }
  return [...buckets.entries()]
    .filter(([, acc]) => acc.total > 0)
    .sort((a, b) => a[0] - b[0])
    .map(([ts, acc]) => {
      const done = finishLogAccumulator(acc);
      return {
        ts,
        success_rate: done.successRate,
        avg_latency_ms: done.avgLatencyMs,
        avg_tps: done.avgTps,
      };
    });
}

// 用日志把清单左连接成 rows（与 joinModelInsight 结构一致）
function joinLogInsight(catalog, logPerf) {
  const rows = [];
  const seen = new Set();
  for (const item of catalog) {
    const name = String((item && item.model_name) || "").trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    rows.push({
      model: name,
      vendor: String((item && item.owner_by) || ""),
      groups: Array.isArray(item && item.enable_groups) ? item.enable_groups : [],
      inCatalog: true,
      perf: logPerf.get(name) || null,
    });
  }
  for (const [name, perf] of logPerf) {
    if (seen.has(name)) continue;
    seen.add(name);
    rows.push({ model: name, vendor: "", groups: [], inCatalog: false, perf });
  }
  return rows;
}

// 站点是否可能压根没有 perf_metrics 模块：新版内核才会下发 HeaderNavModules。
function looksLikeLegacyKernel(site) {
  return !!site && !site.pricingModule.present;
}

function legacyKernelNote(site) {
  const ver = site && site.version ? "（版本 " + site.version + "）" : "";
  const kind = looksLikeLegacyKernel(site) ? "该站点是较旧的 NewAPI 分支" : "该站点";
  return kind + ver + "没有性能指标接口，下表成功率与延迟来自你自己近期的调用日志，不代表站点全局水平。";
}

// perf-metrics 返回 404 时的降级：模型清单 + 我的调用日志聚合。
async function buildLogFallbackInsight(read, platform, site, range, pricingRes) {
  const catalog = (pricingRes.ok && pricingRes.body && Array.isArray(pricingRes.body.data))
    ? pricingRes.body.data
    : [];
  const logs = await fetchSelfLogs(read, range, "");
  const logPerf = aggregateLogPerf(logs.items);
  const rows = joinLogInsight(catalog, logPerf);
  if (!rows.length) {
    return {
      ok: false,
      status: 404,
      site,
      hours: range,
      message: "该站点没有性能指标接口，也读不到模型清单和调用日志" +
        (logs.error ? "（" + logs.error + "）" : "") + "。",
    };
  }
  const warnings = [legacyKernelNote(site)];
  if (!pricingRes.ok) {
    warnings.push("模型清单不可用（" + (pricingRes.message || "接口异常") + "），仅列出你调用过的模型。");
  }
  if (logs.error) {
    warnings.push("调用日志读取不完整（" + logs.error + "）。");
  }
  if (!logPerf.size) {
    warnings.push("你在近 " + range + " 小时内没有调用记录，所以只能列出模型清单，没有可用性数据。");
  }
  if (!isTokenAuthMode(platform)) {
    warnings.push("指标经站点登录会话读取，需保持浏览器已登录该站点。");
  }
  return {
    ok: true,
    hours: range,
    site,
    metricsSource: "log",
    catalogOk: pricingRes.ok,
    catalogTotal: catalog.length,
    perfTotal: logPerf.size,
    rows,
    warnings,
    message: "已读取 " + rows.length + " 个模型（其中 " + logPerf.size + " 个有你的调用记录）",
  };
}

// 单模型明细的同源降级：把日志按小时分桶，产出一条「我的调用记录」分组。
async function buildLogFallbackDetail(read, name, range) {
  const logs = await fetchSelfLogs(read, range, name);
  const acc = newLogAccumulator();
  let counted = 0;
  for (const it of logs.items) {
    if (accumulateLogEntry(acc, it)) counted++;
  }
  if (!counted) {
    return {
      ok: false,
      status: 404,
      message: "该站点没有性能指标接口，且近 " + range + " 小时内没有你对「" + name + "」的调用记录" +
        (logs.error ? "（" + logs.error + "）" : "") + "。",
    };
  }
  const done = finishLogAccumulator(acc);
  return {
    ok: true,
    model: name,
    hours: range,
    source: "log",
    groups: [{
      group: "我的调用记录",
      avgTtftMs: done.avgTtftMs,
      avgLatencyMs: done.avgLatencyMs,
      successRate: done.successRate,
      avgTps: done.avgTps,
      series: aggregateLogSeries(logs.items),
    }],
  };
}

async function runModelInsight(platform, hours) {
  try {
    validatePlatform(platform);
  } catch (e) {
    return { ok: false, message: e && e.message ? e.message : "平台配置无效" };
  }

  const range = Number(hours) > 0 ? Number(hours) : PERF_HOURS_DEFAULT;
  try {
    return await withInsightReader(platform, async (read) => {
      const [statusRes, perfRes, pricingRes] = await Promise.all([
        read("/api/status"),
        read("/api/perf-metrics/summary", { hours: range }),
        read("/api/pricing"),
      ]);

      const statusData = statusRes.ok && statusRes.body ? statusRes.body.data : null;
      const site = {
        version: statusData ? statusData.version || "" : "",
        systemName: statusData ? statusData.system_name || "" : "",
        quotaPerUnit: statusData && statusData.quota_per_unit != null ? Number(statusData.quota_per_unit) : null,
        pricingModule: parsePricingModule(statusData),
      };

      if (!perfRes.ok) {
        // 老版内核（例如 Agent Router）没有 perf_metrics 模块，退回日志聚合而不是直接报错
        if (perfRes.status === 404) {
          return await buildLogFallbackInsight(read, platform, site, range, pricingRes);
        }
        let message = perfRes.message || "无法读取模型性能指标";
        if (perfRes.status === 401) {
          message = isTokenAuthMode(platform)
            ? "访问令牌无效或已过期：" + message
            : "站点登录状态不可用：" + message;
        } else if (perfRes.status === 403) {
          message = site.pricingModule.present && site.pricingModule.enabled === false
            ? "站点已关闭 pricing 模块，性能指标接口不对外开放。"
            : "无权访问性能指标接口：" + message;
        }
        return { ok: false, status: perfRes.status, site, hours: range, message };
      }

      const perfModels = (perfRes.body && perfRes.body.data && Array.isArray(perfRes.body.data.models))
        ? perfRes.body.data.models
        : [];
      const catalog = (pricingRes.ok && pricingRes.body && Array.isArray(pricingRes.body.data))
        ? pricingRes.body.data
        : [];

      const warnings = [];
      if (!pricingRes.ok) {
        warnings.push("模型清单不可用（" + (pricingRes.message || "接口异常") + "），仅显示近期有流量的模型。");
      }
      if (!perfModels.length) {
        warnings.push("该站点近 " + range + " 小时没有性能采样数据。");
      }
      if (!isTokenAuthMode(platform)) {
        warnings.push("指标经站点登录会话读取，需保持浏览器已登录该站点。");
      }

      const rows = joinModelInsight(catalog, perfModels);
      return {
        ok: true,
        hours: range,
        site,
        metricsSource: "perf",
        catalogOk: pricingRes.ok,
        catalogTotal: catalog.length,
        perfTotal: perfModels.length,
        rows,
        warnings,
        message: "已读取 " + rows.length + " 个模型（其中 " + perfModels.length + " 个有近期指标）",
      };
    });
  } catch (e) {
    return { ok: false, message: e && e.message ? e.message : "无法读取模型指标" };
  }
}

// 单模型明细：分组维度的首字延迟与时间序列。
async function runModelDetail(platform, model, hours) {
  const name = String(model || "").trim();
  if (!name) return { ok: false, message: "缺少模型名称" };
  try {
    validatePlatform(platform);
  } catch (e) {
    return { ok: false, message: e && e.message ? e.message : "平台配置无效" };
  }
  const range = Number(hours) > 0 ? Number(hours) : PERF_HOURS_DEFAULT;
  try {
    return await withInsightReader(platform, async (read) => {
      const res = await read("/api/perf-metrics", { model: name, hours: range });
      if (!res.ok) {
        if (res.status === 404) return await buildLogFallbackDetail(read, name, range);
        return { ok: false, status: res.status, message: res.message || "无法读取模型明细" };
      }
      const data = (res.body && res.body.data) || {};
      const groups = Array.isArray(data.groups) ? data.groups : [];
      return {
        ok: true,
        model: data.model_name || name,
        hours: range,
        groups: groups.map((g) => ({
          group: String(g.group || ""),
          avgTtftMs: g.avg_ttft_ms == null ? null : Number(g.avg_ttft_ms),
          avgLatencyMs: g.avg_latency_ms == null ? null : Number(g.avg_latency_ms),
          successRate: g.success_rate == null ? null : Number(g.success_rate),
          avgTps: g.avg_tps == null ? null : Number(g.avg_tps),
          series: Array.isArray(g.series) ? g.series : [],
        })),
      };
    });
  } catch (e) {
    return { ok: false, message: e && e.message ? e.message : "无法读取模型明细" };
  }
}

// 把统计/结果合并回单个 platform 对象
function mergeStats(platform, data, message, ok) {
  const next = { ...platform };
  next.message = message || next.message;
  next.error = ok ? "" : message;
  if (data) {
    next.stats = data.stats || next.stats || {};
    next.enabled = data.enabled;
    if (data.max_quota != null) next.stats.max_quota = data.max_quota;
    if (data.min_quota != null) next.stats.min_quota = data.min_quota;
  }
  return next;
}

// 分类签到结果：成功 / 今日已签到 / 失败
function classify(result) {
  if (result.visited) return "visited";
  if (result.reauthRequired || result.pending) return "pending";
  if (result.ok) return "ok";
  if (isAlreadyCheckinMessage(result.message))
    return "already";
  return "fail";
}

function isAlreadyCheckinMessage(message) {
  return /已签到|已经签到|签到过|重复签到|already\s+(?:checked\s+in|signed\s+in|today)|today\s+already/i.test(String(message || ""));
}

// ---------- 自动调用 API（防僵尸号保活：仅批量/自动签到链路触发） ----------
const normalizeKeepAlive = (ka) => {
  ka = (ka && typeof ka === "object") ? ka : {};
  return {
    enabled: !!ka.enabled,
    url: String(ka.url || "").trim(),
    key: String(ka.key || ""),
    format: KEEPALIVE_FORMATS.indexOf(ka.format) >= 0 ? ka.format : "chat",
    model: String(ka.model || "").trim(),
    lastDate: String(ka.lastDate || "").trim(),
  };
};
const getKeepAlive = (p) => normalizeKeepAlive(p && p.keepAlive);
const needsKeepAliveToday = (p) => {
  const ka = getKeepAlive(p);
  return !!(ka.enabled && ka.lastDate !== todayStr());
};
function keepAliveDefaultUrl(p, format) {
  const base = String((p && p.baseUrl) || "").trim().replace(/\/+$/, "");
  return base ? base + (KEEPALIVE_PATHS[format] || KEEPALIVE_PATHS.chat) : "";
}
async function keepAliveFetch(url, init) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15000);
  try {
    return await fetch(url, Object.assign({}, init, { signal: ctl.signal }));
  } catch (e) {
    if (e && e.name === "AbortError") throw new Error("请求超时（15 秒）");
    throw new Error("网络请求失败：" + ((e && e.message) || "无法连接站点"));
  } finally {
    clearTimeout(timer);
  }
}
function keepAliveHeaders(format, key) {
  const headers = { Accept: "application/json, text/plain, */*", "Content-Type": "application/json" };
  if (format === "message") {
    headers["anthropic-version"] = "2023-06-01";
    if (key) headers["x-api-key"] = key;
  } else if (key) {
    headers["Authorization"] = "Bearer " + key;
  }
  return headers;
}
function keepAliveBody(format, model) {
  if (format === "message") return { model, max_tokens: 1, messages: [{ role: "user", content: "hi" }] };
  if (format === "response") return { model, input: "hi", max_output_tokens: 1 };
  return { model, messages: [{ role: "user", content: "hi" }], max_tokens: 1 };
}
async function keepAliveResponseInfo(res) {
  let text = "";
  try { text = await res.text(); } catch {}
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch {}
  let error = "";
  if (body) {
    const e = body.error;
    error = (e && (typeof e === "string" ? e : (e.message || e.code || ""))) || body.message || "";
  }
  if (!error) error = String(text || "").slice(0, 200);
  error = String(error).slice(0, 200);
  return { ok: res.ok, status: res.status, error: error ? "HTTP " + res.status + "：" + error : "HTTP " + res.status };
}
function isModelRejection(status, message) {
  if (status === 400 || status === 404 || status === 422) return true;
  const msg = String(message || "");
  if (/model not found|no such model|invalid model|model_not_found|does not exist|不支持|不存在|not support/i.test(msg)) return true;
  // NewAPI/one-api 渠道无可用上游（HTTP 503 无可用渠道等）同样视为该模型不可用，触发自动换用可用模型
  if (status >= 400 && /无可用渠道|无可用模型|无可用通道|无可用|no available channel|no channel available|no available|distributor|渠道/i.test(msg)) return true;
  return false;
}
async function attemptKeepAlive(format, url, key, model) {
  const res = await keepAliveFetch(url, {
    method: "POST",
    credentials: "omit",
    headers: keepAliveHeaders(format, key),
    body: JSON.stringify(keepAliveBody(format, model)),
  });
  const info = await keepAliveResponseInfo(res);
  return info.ok ? { ok: true, model } : { ok: false, status: info.status, message: info.error, model };
}
function keepAliveModelsRoot(rawUrl) {
  let s = String(rawUrl || "").trim();
  if (!s) return "";
  // 去掉接口路径后缀（chat/completions、messages、responses）
  s = s.replace(/\/(chat\/completions|messages|responses)\/?$/, "");
  let u;
  try { u = new URL(s); } catch { return ""; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "";
  // 模型列表根地址：确保路径以 /v1 结尾（如 https://host/v1/chat/completions -> https://host/v1）
  let path = u.pathname.replace(/\/+$/, "");
  if (!path) path = "/v1";
  else if (!/\/v1$/i.test(path)) path = path.replace(/\/+$/, "") + "/v1";
  return u.origin + path;
}
async function fetchKeepAliveModels(format, key, url) {
  const root = keepAliveModelsRoot(url);
  if (!root) throw new Error("无法根据调用网址推导模型列表地址");
  const headers = { Accept: "application/json, text/plain, */*" };
  if (format === "message") {
    headers["anthropic-version"] = "2023-06-01";
    if (key) headers["x-api-key"] = key;
  } else if (key) {
    headers["Authorization"] = "Bearer " + key;
  }
  const res = await keepAliveFetch(root + "/models", { method: "GET", credentials: "omit", headers });
  let text = "";
  try { text = await res.text(); } catch {}
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok) {
    const msg = body && ((body.error && (body.error.message || body.error.code)) || body.message);
    throw new Error("读取模型列表失败 HTTP " + res.status + (msg ? "：" + msg : ""));
  }
  let list = [];
  if (body) {
    const data = Array.isArray(body.data) ? body.data : (Array.isArray(body.models) ? body.models : null);
    if (data) list = data.map((m) => (m && typeof m === "object" ? m.id : null)).filter((x) => x != null);
  }
  return list.filter((id) => !/embedding|text-embed|tts|whisper|audio|speech|rerank|moderation|dall|gpt-image|sora|realtime|transcription|translation/i.test(String(id)));
}
async function retryKeepAliveWithModels(format, url, key, tried) {
  let pool = [];
  try {
    pool = await fetchKeepAliveModels(format, key, url);
  } catch (e) {
    return { ok: false, tried: [], error: e && e.message ? e.message : "读取模型列表失败" };
  }
  pool = pool.filter((m) => tried.indexOf(m) < 0);
  if (!pool.length) return { ok: false, tried: [], error: "站点模型列表为空或没有可用对话模型" };
  const used = [];
  let lastError = "";
  const attempts = Math.min(3, pool.length);
  for (let i = 0; i < attempts; i++) {
    const pick = pool.splice(Math.floor(Math.random() * pool.length), 1)[0];
    used.push(pick);
    try {
      const r = await attemptKeepAlive(format, url, key, pick);
      if (r.ok) return { ok: true, model: pick };
      lastError = r.message || ("HTTP " + r.status);
    } catch (e) {
      lastError = e && e.message ? e.message : String(e);
    }
    if (i < attempts - 1) await wait(700);
  }
  return { ok: false, tried: used, error: lastError };
}
async function runKeepAliveCall(p) {
  p = await resolveSavedVisitOnly(p);
  const ka = getKeepAlive(p);
  if (!ka.enabled) return null;
  const format = ka.format;
  let url = ka.url || keepAliveDefaultUrl(p, format);
  if (!url) return { ok: false, message: "未配置调用网址", status: 0 };
  let key = ka.key || "";
  if (!key && isTokenAuthMode(p)) {
    key = String((p && p.accessToken) || "").trim();
  }
  if (!key) return { ok: false, message: "未填写 API Key（Cookie/邮箱密码/Agent Router 模式必须填写）", status: 0 };
  const tried = [];
  let first = null;
  try {
    first = await attemptKeepAlive(format, url, key, ka.model || DEFAULT_KEEPALIVE_MODEL);
  } catch (e) {
    first = { ok: false, status: 0, message: e && e.message ? e.message : "调用失败", model: ka.model || DEFAULT_KEEPALIVE_MODEL };
  }
  tried.push(first.model);
  if (first.ok) return { ok: true, model: first.model, message: "自动调用API成功" };
  if (isModelRejection(first.status, first.message)) {
    const fb = await retryKeepAliveWithModels(format, url, key, tried);
    if (fb.ok) return { ok: true, model: fb.model, message: "自动调用API成功" };
    const detail = (fb.tried && fb.tried.length)
      ? "（已尝试模型：" + tried.concat(fb.tried).join("、") + (fb.error ? "；最近错误：" + fb.error : "") + "）"
      : (fb.error ? "（" + fb.error + "）" : "");
    return { ok: false, status: first.status, message: first.message + detail };
  }
  return { ok: false, status: first.status, message: first.message };
}
async function listKeepAliveModels(p) {
  p = await resolveSavedVisitOnly(p);
  const ka = getKeepAlive(p);
  if (!ka.enabled) return { ok: false, message: "请先开启「自动调用 API」开关" };
  const format = ka.format;
  let url = ka.url || keepAliveDefaultUrl(p, format);
  if (!url) return { ok: false, message: "未配置调用网址" };
  let key = ka.key || "";
  if (!key && isTokenAuthMode(p)) {
    key = String((p && p.accessToken) || "").trim();
  }
  if (!key) return { ok: false, message: "未填写 API Key（Cookie/邮箱密码/Agent Router 模式必须填写）" };
  try {
    const models = await fetchKeepAliveModels(format, key, url);
    if (!models.length) return { ok: false, message: "站点没有可用对话模型" };
    return { ok: true, models };
  } catch (e) {
    return { ok: false, message: e && e.message ? e.message : "读取模型列表失败" };
  }
}
async function runBatchCheckinOne(partial) {
  if (!partial || partial.id == null) return await runCheckin(partial || {}, { reauth: true });
  const cur = await getPlatforms();
  const stored = cur.find((x) => x.id === partial.id);
  if (!stored) return await runCheckin(partial, { reauth: true });
  let alive = null;
  if (needsKeepAliveToday(stored)) {
    alive = await runKeepAliveCall(stored);
    if (alive && alive.ok) {
      const ka = getKeepAlive(stored);
      stored.keepAlive = normalizeKeepAlive(Object.assign({}, ka, { lastDate: todayStr() }));
      await mutatePlatforms((latest) => {
        const current = latest.find((entry) => entry.id === stored.id);
        if (current && sameTaskConfig(current, stored)) current.keepAlive = stored.keepAlive;
        return latest;
      });
    }
  }
  const r = await runCheckin(stored, { reauth: true });
  const ka = getKeepAlive(stored);
  if (alive) {
    const part = alive.ok
      ? "自动调用API成功" + (alive.model ? "（模型 " + alive.model + "）" : "")
      : "自动调用API失败：" + alive.message + "（仍执行签到）";
    r.message = part + "｜" + r.message;
  }
  if (ka.enabled) {
    r.keepAlive = {
      ok: alive ? !!alive.ok : null,
      date: getKeepAlive(stored).lastDate,
      message: alive ? (alive.ok ? "自动调用API成功" + (alive.model ? "（模型 " + alive.model + "）" : "") : "自动调用API失败：" + alive.message) : null,
    };
  }
  return r;
}
async function collectAutoTodo(platforms) {
  const unchecked = await findUncheckedPlatforms(platforms);
  const todo = unchecked.slice();
  const have = {};
  for (const p of todo) have[p.id] = true;
  for (const p of platforms) {
    if (!have[p.id] && needsKeepAliveToday(p)) todo.push(p);
  }
  return todo;
}

// ---------- 批量/自动签到（Service Worker 内执行，可脱离弹窗） ----------
async function runAutoCheckin(triggeredByUser = false, selectedPlatforms = null) {
  const settings = await getSettings();
  if (!settings.autoEnabled && !triggeredByUser) return { skipped: true };
  const explicitSelection = Array.isArray(selectedPlatforms);
  const platforms = explicitSelection ? selectedPlatforms : await getPlatforms();
  if (!platforms.length) return { skipped: true };
  const today = todayStr();
  const results = await Promise.all(platforms.map((p) => withPlatformSession(p, async () => {
    p = await resolveSavedVisitOnly(p); // 出队后重读，不能让等待期间开启的仅访问失效。
    let alive = null;
    if (needsKeepAliveToday(p)) {
      alive = await runKeepAliveCall(p);
      if (alive && alive.ok) {
        const ka = getKeepAlive(p);
        p.keepAlive = normalizeKeepAlive(Object.assign({}, ka, { lastDate: today }));
      }
    }
    const alreadyVisited = isVisitOnly(p) && p.lastVisitDate === today;
    const alreadyToday = !isVisitOnly(p) && !!(p.stats && p.stats.checked_in_today && p.statsDate === today);
    const r = explicitSelection && alreadyVisited
      ? { ok: true, visited: true, message: "今日已访问", data: null, lastVisitDate: p.lastVisitDate, lastVisitedAt: p.lastVisitedAt }
      : explicitSelection && alreadyToday
      ? { ok: true, message: "今日已签到", data: null, _alreadySkipped: true }
      : await runCheckin(p, { reauth: true });
    if (alive) {
      const part = alive.ok
        ? "自动调用API成功" + (alive.model ? "（模型 " + alive.model + "）" : "")
        : "自动调用API失败：" + alive.message + "（仍执行签到）";
      r.message = part + "｜" + r.message;
    }
    return { platform: p, result: r, alive, kind: r._alreadySkipped ? "already" : classify(r) };
  })));
  let ok = 0, already = 0, fail = 0, pending = 0, visited = 0, aliveOk = 0, aliveFail = 0;
  const list = [];
  const cur = await getPlatforms();
  for (let i = 0; i < results.length; i++) {
    const item = results[i];
    const p = item.platform;
    const r = item.result;
    const kind = item.kind;
    if (kind === "visited") visited++;
    else if (kind === "ok") ok++;
    else if (kind === "already") already++;
    else if (kind === "pending") pending++;
    else fail++;
    if (item.alive) { if (item.alive.ok) aliveOk++; else aliveFail++; }
    list.push({ id: p.id, name: p.name, ok: r.ok, message: r.message, kind, aliveOk: !!(item.alive && item.alive.ok), aliveFail: !!(item.alive && !item.alive.ok) });
    const idx = cur.findIndex((x) => x.id === p.id);
    if (idx >= 0 && sameTaskConfig(cur[idx], p)) {
      if (item.alive) cur[idx].keepAlive = normalizeKeepAlive(p.keepAlive);
      cur[idx].message = r.message;
      cur[idx].error = r.ok ? "" : r.message;
      cur[idx].reauthPending = !!r.reauthRequired;
      if (r.reauthRequired) cur[idx].reauthStartedAt = r.reauthStartedAt;
      if (r.visited) {
        cur[idx].lastVisitDate = r.lastVisitDate;
        cur[idx].lastVisitedAt = r.lastVisitedAt;
        if (r.account) cur[idx].account = Object.assign({}, cur[idx].account || {}, r.account);
      } else if (!isVisitOnly(p)) cur[idx].lastCheckinAt = new Date().toISOString();
      // 跨天"今日已签到"锚点：成功或站点明确提示重复签到即标记今天
      if (!r.visited && !isVisitOnly(p) && !r.reauthRequired && (r.ok || isAlreadyCheckinMessage(r.message))) {
        cur[idx].stats = cur[idx].stats || {};
        if (r.data && r.data.stats) Object.assign(cur[idx].stats, r.data.stats);
        cur[idx].stats.checked_in_today = true;
        cur[idx].statsDate = today;
      }
    }
  }
  await savePlatforms(cur);
  const summary = {
    time: new Date().toISOString(),
    ok,
    already,
    fail,
    pending,
    visited,
    aliveOk,
    aliveFail,
    total: platforms.length,
    list,
  };
  await setStore({ [KEY_LASTAUTO]: summary });
  if (settings.notify !== false) {
    const title = (triggeredByUser ? "手动" : "自动") + (platforms.some(isVisitOnly) ? "访问/签到任务完成" : "签到完成");
    let body = `共 ${summary.total} 个站点：成功 ${ok}，已签 ${already}，失败 ${fail}` + (visited ? `，已访问 ${visited}` : "") + (pending ? `，等待登录 ${pending}` : "");
    if (aliveOk || aliveFail) body += `；保活成功 ${aliveOk}，失败 ${aliveFail}`;
    notify(title, body);
  }
  return summary;
}

function autoTimeReached(value) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value || ""));
  if (!m) return false;
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes() >= Number(m[1]) * 60 + Number(m[2]);
}

async function findUncheckedPlatforms(platforms) {
  const results = await Promise.all(platforms.map((p) => withPlatformSession(p, async () => {
    p = await resolveSavedVisitOnly(p);
    if (isVisitOnly(p)) return p.lastVisitDate === todayStr() ? null : p;
    if (p.stats && p.stats.checked_in_today && p.statsDate === todayStr()) return null;
    // /api/user/self 本身会触发 Agent Router 签到，不能把它当作只读预检接口调用。
    if (isSelfTriggerMode(p)) return p;
    try {
      const body = await callCheckin(p, "GET", currentMonth());
      if (body && body.data && body.data.stats && body.data.stats.checked_in_today) return null;
    } catch {
      // 只读状态不可用时仍尝试签到，由签到接口返回最终结果。
    }
    return p;
  })));
  return results.filter(Boolean);
}

async function saveAutoState(date, state) {
  await setStore({ [KEY_AUTOSTATE]: { date, state } });
}

function autoConfirmNotificationId(date) {
  return "nacheckin-confirm-" + date;
}

async function checkScheduledAuto() {
  const settings = await getSettings();
  if (!settings.autoEnabled || !autoTimeReached(settings.autoTime || "08:01")) return { skipped: true };
  const date = todayStr();
  const state = await getStore(KEY_AUTOSTATE, null);
  if (state && state.date === date && state.state !== "pending") return { skipped: true };
  if (state && state.date === date && state.state === "pending") return { pending: true };

  const platforms = await getPlatforms();
  if (!platforms.length) {
    await saveAutoState(date, "done");
    return { skipped: true };
  }
  const todo = await collectAutoTodo(platforms);
  if (!todo.length) {
    await saveAutoState(date, "done");
    return { skipped: true, already: true };
  }
  const needVisit = todo.some(isVisitOnly);
  const needCheckin = todo.some((p) => !isVisitOnly(p) && !(p.stats && p.stats.checked_in_today && p.statsDate === todayStr()));
  if (settings.autoApprove) {
    await saveAutoState(date, "approved");
    await runAutoCheckin(false, todo);
    await saveAutoState(date, "done");
    return { started: true, automatic: true };
  }
  await saveAutoState(date, "pending");
  const id = autoConfirmNotificationId(date);
  chrome.notifications.create(id, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon128.png"),
    title: needVisit ? "到达自动任务时间" : "到达自动签到时间",
    message: needVisit ? "今天还有站点需要仅访问，是否执行本次访问/签到任务？" : needCheckin ? "今天还有站点未签到，是否立即执行一键签到？" : "今天还有站点需要自动调用 API 保活，是否立即执行？",
    priority: 2,
    buttons: [{ title: needVisit ? "允许执行" : "允许签到" }, { title: "跳过今天" }],
  }).catch(() => {});
  return { pending: true };
}

function notify(title, message) {
  try {
    chrome.notifications.create("nacheckin-" + Date.now(), {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon128.png"),
      title,
      message,
      priority: 2,
    });
  } catch (e) {
    /* 通知不可用时静默 */
  }
}

chrome.notifications.onButtonClicked.addListener(async (notificationId, buttonIndex) => {
  if (!notificationId.startsWith("nacheckin-confirm-")) return;
  const date = notificationId.slice("nacheckin-confirm-".length);
  await chrome.notifications.clear(notificationId).catch(() => {});
  if (buttonIndex !== 0) {
    await saveAutoState(date, "declined");
    return;
  }
  const settings = await getSettings();
  if (!settings.autoEnabled || date !== todayStr()) return;
  const todo = await collectAutoTodo(await getPlatforms());
  await saveAutoState(date, "approved");
  if (todo.length) await runAutoCheckin(false, todo);
  await saveAutoState(date, "done");
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" && !changeInfo.url) return;
  handleAgentRouterReauthTab(tabId, changeInfo.url || (tab && tab.url) || "").catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => {
  getAgentRouterPending().then(async (all) => {
    const pending = all[tabId];
    if (!pending) return;
    await updateAgentRouterPending(tabId, null);
    await saveAgentRouterLoginOutcome(pending, null, "登录页已关闭，尚未确认签到，请重新执行签到");
  }).catch(() => {});
});

// Service Worker 休眠后恢复时，继续接管所有未完成的 OAuth 标签页。
getAgentRouterPending().then(async (all) => {
  if (Object.keys(all).length) chrome.alarms.create(OAUTH_ALARM_NAME, { periodInMinutes: 1 });
  for (const pending of Object.values(all)) {
    const tab = await chrome.tabs.get(pending.tabId).catch(() => null);
    if (tab) handleAgentRouterReauthTab(tab.id, tab.url || "").catch(() => {});
    else {
      await updateAgentRouterPending(pending.tabId, null);
      await saveAgentRouterLoginOutcome(pending, null, "登录页已关闭，尚未确认签到，请重新执行签到");
    }
  }
}).catch(() => {});

// 同源会话全操作排队，不仅序列化表单填写，防止批量请求在账号切换后串号。
const platformSessionQueues = new Map();
function withPlatformSession(platform, fn) {
  if (!platform || isTokenAuthMode(platform)) return Promise.resolve().then(fn);
  let origin;
  try { origin = new URL(platform.baseUrl).origin; } catch { return Promise.resolve().then(fn); }
  const previous = platformSessionQueues.get(origin) || Promise.resolve();
  const task = previous.catch(() => {}).then(fn);
  platformSessionQueues.set(origin, task);
  task.finally(() => { if (platformSessionQueues.get(origin) === task) platformSessionQueues.delete(origin); }).catch(() => {});
  return task;
}

// ---------- 消息总线（popup <-> SW） ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!sender || sender.id !== chrome.runtime.id || !String(sender.url || "").startsWith(chrome.runtime.getURL(""))) {
    sendResponse({ ok: false, message: "只接受扩展界面的请求" });
    return false;
  }
  withPlatformSession(msg.platform, async () => {
    try {
      // 旧界面/快照遗漏新标志时，以已保存的仅访问配置为准，不能降级成签到。
      if (msg.platform && msg.platform.id && msg.type !== "test") {
        const stored = (await getPlatforms()).find((p) => p.id === msg.platform.id);
        if (isVisitOnly(stored)) msg = { ...msg, platform: stored };
      }
      if (msg.type === "getCapabilities") {
        sendResponse({ ok: true, authBuild: AUTH_CONFIG.build, authModes: [...AUTH_CONFIG.modes], version: chrome.runtime.getManifest().version });
      } else if (msg.type === "savePlatforms") {
        if (!Array.isArray(msg.platforms)) throw new Error("平台配置格式必须为数组");
        await savePlatforms(msg.platforms);
        sendResponse({ ok: true });
      } else if (msg.type === "stats" || msg.type === "test") {
        const r = await runStats(msg.platform, msg.month);
        sendResponse(r);
      } else if (msg.type === "account") {
        try {
          const acc = await fetchAccount(msg.platform, msg.month || currentMonth(), null);
          const warn = acc && acc._warn ? acc._warn : "";
          sendResponse({ ok: true, message: warn ? "额度已更新（" + warn + "）" : "额度已更新", account: acc });
        } catch (e) {
          sendResponse({ ok: false, message: e && e.message ? e.message : "无法获取账户额度" });
        }
      } else if (msg.type === "modelInsight") {
        sendResponse(await runModelInsight(msg.platform, msg.hours));
      } else if (msg.type === "modelDetail") {
        sendResponse(await runModelDetail(msg.platform, msg.model, msg.hours));
      } else if (msg.type === "testKeepAlive") {
        const aliveProbe = getKeepAlive(msg.platform).enabled ? await runKeepAliveCall(msg.platform) : null;
        sendResponse(aliveProbe ? aliveProbe : { ok: false, message: "请先开启自动调用 API" });
      } else if (msg.type === "keepAliveModels") {
        sendResponse(await listKeepAliveModels(msg.platform));
      } else if (msg.type === "checkin") {
        const r = msg.batch
          ? await runBatchCheckinOne(msg.platform)
          : await runCheckin(msg.platform, { reauth: msg.reauth !== false });
        sendResponse(r);
      } else if (msg.type === "autoRun") {
        const summary = await runAutoCheckin(true);
        sendResponse({ ok: true, summary });
      } else if (msg.type === "getSettings") {
        sendResponse({ ok: true, settings: await getSettings() });
      } else if (msg.type === "saveSettings") {
        await saveSettings(msg.settings || {});
        await syncAlarm();
        if (msg.settings && msg.settings.autoEnabled) checkScheduledAuto().catch(() => {});
        sendResponse({ ok: true, settings: msg.settings });
      } else if (msg.type === "getLastAuto") {
        const last = await getStore(KEY_LASTAUTO, null);
        sendResponse({ ok: true, last });
      } else {
        sendResponse({ ok: false, message: "未知请求" });
      }
    } catch (e) {
      sendResponse({ ok: false, message: e && e.message ? e.message : String(e) });
    }
  });
  return true; // 异步响应
});

// ---------- 定时任务 ----------
async function syncAlarm() {
  const s = await getSettings();
  await chrome.alarms.clear(ALARM_NAME);
  if (s.autoEnabled) {
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1 });
  }
}
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === OAUTH_ALARM_NAME) {
    getAgentRouterPending().then(async (all) => {
      for (const pending of Object.values(all)) {
        const tab = await chrome.tabs.get(pending.tabId).catch(() => null);
        if (tab) await handleAgentRouterReauthTab(tab.id, tab.url || "");
        else {
          await updateAgentRouterPending(pending.tabId, null);
          await saveAgentRouterLoginOutcome(pending, null, "登录页已关闭，尚未确认签到，请重新执行签到");
        }
      }
    }).catch(() => {});
  }
  if (a.name === ALARM_NAME) checkScheduledAuto().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  // 浏览器当天首次启动时，按用户设定时间补检一次。
  getSettings().then((s) => {
    if (s.autoEnabled) checkScheduledAuto().catch(() => {});
  });
});

chrome.runtime.onInstalled.addListener(async () => {
  await syncAlarm();
  await savePlatforms(await getPlatforms()); // 初始化存储键
});
// ---------- 侧边栏（Chrome / Edge sidePanel API） ----------
// 优先让浏览器原生处理工具栏点击；API 不可用时退化为宽屏管理页。
async function setupSidePanel() {
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    try {
      await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
      return true;
    } catch {}
  }
  return false;
}
let sidePanelReady = setupSidePanel();
chrome.runtime.onInstalled.addListener(() => {
  sidePanelReady = setupSidePanel();
});
chrome.action.onClicked.addListener(async (tab) => {
  // setPanelBehavior 成功时，Chrome / Edge 会自行打开侧边栏。
  if (await sidePanelReady) return;
  if (chrome.sidePanel && chrome.sidePanel.open && tab && tab.windowId != null) {
    try {
      await chrome.sidePanel.open({ windowId: tab.windowId });
      return;
    } catch {}
  }
  // 较旧的 Chrome 或其他 Chromium 浏览器没有 sidePanel 时仍可正常使用。
  chrome.tabs.create({ url: chrome.runtime.getURL("popup.html") }).catch(() => {});
});
