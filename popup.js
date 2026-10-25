// ===== NewAPI 一键签到 - 弹窗/侧边栏/宽屏页 共用逻辑 =====
const KEY_PLATFORMS = "nacheckin.platforms";
const KEY_SETTINGS = "nacheckin.settings";
const KEY_EXPANDED_GROUPS = "nacheckin.expandedAccountGroups";
let expandedAccountGroups = new Set();
const visitProgress = new Map();
const KEY_CHECKIN_STOP_VERSION = "nacheckin.checkinStopVersion";
const DEFAULT_QUOTA_PER_UNIT = 500000;
let platforms = [];
let checkinStopVersion = 0;
let editingId = null;
let connectionPromise = null;
let connectionConfig = null;
let connectionRequestId = 0;
let deletingId = null;
let keepAliveTestPromise = null;
let keepAlivePickPromise = null;
let checkinRequestSequence = 0;
let activeBatchRun = null;
let batchRunSequence = 0;
let activeAutoRun = null;
let autoRunSequence = 0;
let pendingStopRequests = 0;
const activeCheckins = new Map();
const startingCheckins = new Map();
const cancelledCheckins = new Map();

function todayStr() {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
function currentMonth() {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
}
const $ = (id) => document.getElementById(id);
const esc = (v = "") => String(v).replace(/[&<>'"]/g, (c) => "&#" + c.charCodeAt(0) + ";");
// 仅放行 http/https，避免 javascript: 等协议被写进 href
function safeHttpUrl(v) {
  const raw = String(v == null ? "" : v).trim();
  if (!raw) return "";
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : "";
  } catch (e) {
    return "";
  }
}
// ---------- 自动调用 API（防僵尸号保活）配置 ----------
const DEFAULT_KEEPALIVE_MODEL = "deepseek v4 flash";
const KEEPALIVE_FORMATS = ["chat", "message", "response"];
const KEEPALIVE_PATHS = { chat: "/v1/chat/completions", message: "/v1/messages", response: "/v1/responses" };
function normalizeKeepAlive(ka) {
  ka = (ka && typeof ka === "object") ? ka : {};
  return {
    enabled: !!ka.enabled,
    url: String(ka.url || "").trim(),
    key: String(ka.key || ""),
    format: KEEPALIVE_FORMATS.indexOf(ka.format) >= 0 ? ka.format : "chat",
    model: String(ka.model || "").trim(),
    lastDate: String(ka.lastDate || "").trim(),
  };
}
function keepAliveDefaultUrl(baseUrl, format) {
  const base = String(baseUrl || "").trim().replace(/\/+$/, "");
  return base ? base + (KEEPALIVE_PATHS[format] || KEEPALIVE_PATHS.chat) : "";
}

function quotaNumber(v) {
  if (typeof v !== "number" && typeof v !== "string") return null;
  if (typeof v === "string" && !v.trim()) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function quotaUnitFor(account) {
  if (!account || account.quotaPerUnit === undefined) return DEFAULT_QUOTA_PER_UNIT;
  const unit = quotaNumber(account.quotaPerUnit);
  return unit !== null && unit > 0 ? unit : null;
}
function formatQuota(v, quotaPerUnit = DEFAULT_QUOTA_PER_UNIT) {
  const amount = quotaNumber(v);
  const unit = quotaNumber(quotaPerUnit);
  if (amount === null || unit === null || unit <= 0) return "—";
  const value = amount / unit;
  return Number.isFinite(value) ? value.toFixed(4) : "—";
}
function fmtTokens(v, truncated) {
  if (v == null) return "—";
  const n = Number(v) || 0;
  return n.toLocaleString("en-US") + (truncated ? "+" : "");
}

function toast(text, error = false) {
  const el = $("toast");
  if (!el) return;
  el.textContent = text;
  el.className = "show" + (error ? " error" : "");
  clearTimeout(window.toastTimer);
  window.toastTimer = setTimeout(() => (el.className = ""), 1600);
}

// ---------- 主题切换 ----------
function currentTheme(){ return document.documentElement.getAttribute("data-theme")==="light"?"light":"dark"; }
function preferredTheme(){
  try{ var v=localStorage.getItem("nacheckin.theme"); if(v==="light"||v==="dark") return v; }catch(e){}
  try{ if(window.matchMedia&&window.matchMedia("(prefers-color-scheme: light)").matches) return "light"; }catch(e){}
  return "dark";
}
function applyTheme(mode){
  document.documentElement.setAttribute("data-theme",mode);
  var b=$("themeToggle");
  if(b){ b.textContent = mode==="dark"?"☾":"☀"; b.title = mode==="dark"?"切换到浅色界面":"切换到深色界面"; b.setAttribute("aria-label",b.title); }
}
function saveTheme(mode){ try{ localStorage.setItem("nacheckin.theme",mode); }catch(e){} }
function toggleTheme(){
  var next = currentTheme()==="dark"?"light":"dark";
  applyTheme(next); saveTheme(next);
}

// ---------- 与后台通讯 ----------
function sendRaw(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (resp) => {
        if (chrome.runtime.lastError) resolve({ ok: false, message: chrome.runtime.lastError.message });
        else resolve(resp);
      });
    } catch (e) {
      resolve({ ok: false, message: e.message });
    }
  });
}
const AUTH_CONFIG = globalThis.NACheckinAuth;
const AUTH_MODES = AUTH_CONFIG.modes;
const isAgentRouterMode = (p) => AUTH_CONFIG.isAgentRouterMode(p.authMode);
const AUTH_REQUEST_TYPES = new Set(["test", "stats", "account", "checkin", "modelInsight", "modelDetail", "testKeepAlive", "keepAliveModels", "savePlatforms", "autoRun", "stopCheckin"]);
// 修改源码后，现有扩展后台可能仍运行旧代码。先握手，不能将新模式交给旧 token 校验。
// 不缓存握手结果：同一页面存活期间 Service Worker 也可能更新/恢复。
async function send(msg) {
  if (AUTH_REQUEST_TYPES.has(msg.type)) {
    const capabilities = await sendRaw({ type: "getCapabilities" });
    const mode = msg.platform && (msg.platform.authMode || "token");
    if (!capabilities || !capabilities.ok || capabilities.authBuild !== AUTH_CONFIG.build ||
        !Array.isArray(capabilities.authModes) || (mode && !capabilities.authModes.includes(mode))) {
      return { ok: false, code: "BACKGROUND_UPDATE_REQUIRED", message: "扩展界面与后台版本不一致，请在扩展管理页点击本扩展的「重新加载」，再关闭并重新打开侧边栏（不要只刷新站点网页）" };
    }
  }
  return await sendRaw(msg);
}
const isVisitOnly = (p) => NACheckinAuth.isVisitOnly(p);
const slim = (p) => ({
  id: p.id, baseUrl: p.baseUrl, userId: p.userId, authMode: p.authMode, visitOnly: isVisitOnly(p),
  logoutAfterVisit: NACheckinAuth.shouldLogoutAfterVisit(p),
  accessToken: !p.authMode || p.authMode === "token" ? p.accessToken : "",
  ...(p.authMode === "password" ? { loginUsername: String(p.loginUsername || "").trim(), loginPassword: p.loginPassword } : {}),
});
const slimFull = (p) => ({ id: p.id, ...slim(p), keepAlive: normalizeKeepAlive(p.keepAlive) });
const getStats = (p, month) =>
  send({ type: "stats", platform: slim(p), month: month || $("monthInput").value || currentMonth() });
const doCheckin = (p, opts = {}) =>
  send({ type: "checkin", platform: slimFull(p), reauth: opts.reauth !== false, batch: !!opts.batch, stopVersion: opts.stopVersion });
const getAccount = (p, month) =>
  send({ type: "account", platform: slim(p), month: month || $("monthInput").value || currentMonth() });
const getModelInsight = (p, hours) => send({ type: "modelInsight", platform: slim(p), hours });
const getModelDetail = (p, model, hours) => send({ type: "modelDetail", platform: slim(p), model, hours });

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
  if (p.authMode && !AUTH_MODES.includes(p.authMode)) throw new Error("不支持的鉴权方式");
  const ka = normalizeKeepAlive(p.keepAlive);
  if (ka.enabled) {
    if (ka.url && !safeHttpUrl(ka.url))
      throw new Error("自动调用 API 的调用网址必须使用 HTTP/HTTPS");
    if (!ka.url && !p.baseUrl)
      throw new Error("开启自动调用 API 需要填写调用网址或站点地址");
    if (!ka.key && (p.authMode === "cookie" || p.authMode === "password" || isAgentRouterMode(p)))
      throw new Error("Cookie/邮箱密码/Agent Router 模式开启自动调用 API 时必须填写 API Key");
  }
  if (p.authMode === "cookie") return p;
  if (p.userId && !/^\d+$/.test(String(p.userId).trim()))
    throw new Error("请填写正确的 NewAPI 用户ID");
  if (isAgentRouterMode(p) && !/^\d+$/.test(String(p.userId || "").trim()))
    throw new Error("Agent Router 签到模式必须填写数字用户ID");
  if (isAgentRouterMode(p)) return p;
  if (p.authMode === "password") {
    if (url.protocol !== "https:" || url.username || url.password) throw new Error("邮箱密码登录必须使用无内嵌凭据的 HTTPS 地址");
    if (!String(p.loginUsername || "").trim()) throw new Error("请填写邮箱或用户名");
    if (!p.loginPassword) throw new Error("请填写登录密码");
    return p;
  }
  if (!(p.accessToken || "").trim()) throw new Error("请填写访问令牌");
  return p;
}

function isAlreadyCheckinMessage(message) {
  return /已签到|已经签到|签到过|重复签到|already\s+(?:checked\s+in|signed\s+in|today)|today\s+already/i.test(String(message || ""));
}

// ---------- 统计合并 ----------
function mergeStatsInto(id, data, message, ok, account) {
  const p = platforms.find((x) => x.id === id);
  if (!p) return;
  p.message = message || p.message;
  // 只在带 data（签到/统计响应）时才影响签到相关状态；纯刷新额度时不改动签到状态
  if (data) {
    p.error = ok ? "" : message;
    p.stats = data.stats || p.stats || {};
    p.statsDate = todayStr();
    p.enabled = data.enabled;
    if (data.max_quota != null) p.stats.max_quota = data.max_quota;
    if (data.min_quota != null) p.stats.min_quota = data.min_quota;
  } else {
    // 额度刷新独立于访问/签到结果；兼容旧版本把取数错误写入 p.error 的记录。
    if (/^获取账户额度失败[：:]/.test(p.error || "")) p.error = "";
    p.accountError = ok ? "" : message;
  }
  if (account) p.account = account;
}

function validStopVersion(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function isCancelledResult(result) {
  return !!result && (result.cancelled === true || result.code === "CHECKIN_CANCELLED");
}
function readStoredStopVersion() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(KEY_CHECKIN_STOP_VERSION, (res) => {
        const version = res && res[KEY_CHECKIN_STOP_VERSION];
        resolve(validStopVersion(version) ? version : 0);
      });
    } catch (_) {
      resolve(checkinStopVersion);
    }
  });
}
function applyStopVersion(version, announceExternal = false) {
  if (!validStopVersion(version) || version <= checkinStopVersion) return false;
  checkinStopVersion = version;
  const hadProgress = visitProgress.size > 0;
  for (const id of visitProgress.keys()) clearVisitProgress(id);
  let stoppedWork = false;
  for (const [id, operation] of startingCheckins) {
    if (operation.stopVersion < version) {
      startingCheckins.delete(id);
      operation.cancelled = true;
      const p = platforms.find((entry) => entry.id === id);
      if (p) p.loading = false;
      markCheckinCancelled(id, "签到已终止");
      stoppedWork = true;
    }
  }
  for (const [id, operation] of activeCheckins) {
    if (operation.stopVersion < version) {
      activeCheckins.delete(id);
      const p = platforms.find((entry) => entry.id === id);
      if (p) {
        p.loading = false;
        cancelledCheckins.set(id, "签到已终止");
        stoppedWork = true;
      }
    }
  }
  if (activeBatchRun && activeBatchRun.stopVersion < version) {
    activeBatchRun.cancelled = true;
    activeBatchRun = null;
    const batchButton = $("batchBtn");
    if (batchButton) batchButton.disabled = false;
    stoppedWork = true;
  }
  if (activeAutoRun && activeAutoRun.stopVersion < version) {
    activeAutoRun.cancelled = true;
    activeAutoRun = null;
    const runNowButton = $("runNowBtn");
    if (runNowButton) runNowButton.disabled = false;
    stoppedWork = true;
  }
  if (stoppedWork || hadProgress) render();
  if (announceExternal && stoppedWork && !pendingStopRequests) toast("已收到其他窗口的终止请求");
  return true;
}
async function latestStopVersion() {
  const stored = await readStoredStopVersion();
  if (stored > checkinStopVersion) applyStopVersion(stored);
  return checkinStopVersion;
}
async function stopCheckin() {
  pendingStopRequests++;
  try {
    const result = await send({ type: "stopCheckin" });
    if (!result || !result.ok || result.cancelled !== true || !validStopVersion(result.stopVersion)) {
      toast((result && result.message) || "无法确认后台已终止签到，请重新加载扩展后台后重试。", true);
      return result;
    }
    applyStopVersion(result.stopVersion);
    toast(result.message || "签到任务已终止");
    return result;
  } catch (error) {
    toast(error && error.message || "无法确认后台已终止签到，请重新加载扩展后台后重试。", true);
    return { ok: false, message: error && error.message || "终止签到失败" };
  } finally {
    pendingStopRequests--;
  }
}
function markCheckinCancelled(id, message) {
  cancelledCheckins.set(id, message || "签到已终止");
}
function releaseCheckinOperation(id, operation) {
  if (activeCheckins.get(id) !== operation) return false;
  activeCheckins.delete(id);
  return true;
}

// ---------- 渲染 ----------
function status(p) {
  if (p.loading || currentVisitProgress(p.id)) return ["处理中", "badge-muted"];
  if (cancelledCheckins.has(p.id)) return ["已终止", "badge-muted"];
  if (isVisitOnly(p)) {
    if (p.error) return [/^获取账户额度失败[：:]/.test(p.error) ? "额度刷新失败" : "访问失败", "badge-danger"];
    if (p.accountError) return ["额度刷新失败", "badge-danger"];
    return p.lastVisitDate === todayStr() ? ["今日已访问", "badge-success"] : ["仅访问", "badge-warning"];
  }
  // checked_in_today 来自缓存，必须由 statsDate 锚定当天，否则跨天后视为待签到
  if (p.stats && p.stats.checked_in_today && p.statsDate === todayStr()) return ["今日已签到", "badge-success"];
  if (p.reauthPending) return ["等待登录", "badge-warning"];
  if (p.error) return ["请求失败", "badge-danger"];
  if (p.accountError) return ["额度刷新失败", "badge-danger"];
  return ["待签到", "badge-warning"];
}

function clearVisitProgress(id) {
  const progress = visitProgress.get(id);
  if (progress) clearTimeout(progress.timer);
  visitProgress.delete(id);
}
function currentVisitProgress(id) {
  const progress = visitProgress.get(id);
  return progress && progress.stopVersion === checkinStopVersion && Date.now() - progress.at < 90000 ? progress.message : "";
}
function accountGroupKey(p) {
  try {
    const url = new URL(p.baseUrl);
    if (!/^https?:$/.test(url.protocol)) throw new Error("invalid");
    // 保留部署路径和端口；不同 API 实例不能只因域名相同而合并。
    return url.origin + url.pathname.replace(/\/+$/, "");
  } catch { return "invalid:" + p.id; }
}
function groupAccounts(list) {
  const groups = new Map();
  for (const p of list) {
    const key = accountGroupKey(p);
    if (!groups.has(key)) groups.set(key, { key, accounts: [] });
    groups.get(key).accounts.push(p);
  }
  return [...groups.values()];
}
function accountGroupSummary(accounts) {
  const unique = new Map();
  let duplicates = 0;
  for (const p of accounts) {
    // 只对在线确认过的用户 ID 去重，未确认身份的配置不猜测归属。
    const id = p.account && p.account.userId;
    const key = id != null && /^\d+$/.test(String(id)) ? "user:" + id : "config:" + p.id;
    const previous = unique.get(key);
    if (previous) {
      duplicates++;
      const time = (entry) => Date.parse(entry.account && entry.account.updatedAt || "") || 0;
      if (time(previous) > time(p)) continue;
    }
    unique.set(key, p);
  }
  let total = 0, known = 0, unknown = 0;
  for (const p of unique.values()) {
    const acc = p.account || {};
    const amount = quotaNumber(acc.available), unit = quotaUnitFor(acc);
    const value = amount !== null && unit !== null ? amount / unit : NaN;
    if (!Number.isFinite(value)) { unknown++; continue; }
    total += value; known++;
  }
  return { total, known, unknown, duplicates };
}
function accountUpdatedLabel(account) {
  const date = new Date(account && account.updatedAt || "");
  return Number.isFinite(date.getTime()) ? "余额更新时间：" + date.toLocaleString() : "余额更新时间未知";
}
function accountIdentity(p) {
  const id = p.account && p.account.userId || p.userId;
  return id ? "用户 ID " + id : "尚未确认用户 ID";
}
function renderAccountPreview(p) {
  const [label, cls] = status(p);
  const account = p.account || {};
  const busy = p.loading || startingCheckins.has(p.id) || activeCheckins.has(p.id) || !!currentVisitProgress(p.id);
  const visitOnly = isVisitOnly(p);
  const actionLabel = visitOnly ? (busy ? "访问中…" : "访问") : (busy ? "签到中…" : "签到");
  const actionName = visitOnly ? "访问" : "快捷签到";
  return '<div class="account-preview-row"><span class="account-preview-name">' + esc(p.name) + '<small>' + esc(accountIdentity(p)) + '</small></span>' +
    '<span class="account-preview-details" title="' + esc(accountUpdatedLabel(account)) + '">' +
    '<span class="account-preview-value"><button type="button" class="btn btn-primary account-preview-checkin" data-action="checkin" data-id="' + esc(p.id) + '" aria-label="' + esc(actionName + "：" + p.name) + '" title="' + esc(actionName + "：" + p.name) + '"' +
    (busy ? " disabled" : "") + '>' + esc(actionLabel) + '</button><span class="account-preview-amount">' + esc(formatQuota(account.available, quotaUnitFor(account))) + '</span></span>' +
    '<small class="' + esc(cls) + '">' + esc(label) + '</small></span></div>';
}
function renderAccountGroup(group, index) {
  if (group.accounts.length === 1) return renderPlatformCard(group.accounts[0]);
  const summary = accountGroupSummary(group.accounts);
  const expanded = expandedAccountGroups.has(group.key);
  const amount = summary.known && Number.isFinite(summary.total) ? "$" + summary.total.toFixed(4) : "—";
  const warnings = (summary.unknown ? " · " + summary.unknown + " 个余额未知" : "") +
    (summary.duplicates ? " · " + summary.duplicates + " 个重复身份配置未重复累计" : "");
  return '<section class="account-group"><button class="account-group-toggle" data-action="toggle-group" data-group="' + esc(group.key) +
    '" aria-expanded="' + expanded + '" aria-controls="account-group-' + index + '">' +
    '<span><strong>' + (expanded ? "▾ " : "▸ ") + esc(group.key) + '</strong><small>' + group.accounts.length + ' 个账号配置' + esc(warnings) + '</small></span>' +
    '<span class="account-group-total">' + amount + '<small>已知余额合计（最近快照）</small></span></button>' +
    (expanded ? "" : '<div class="account-group-preview">' + group.accounts.map(renderAccountPreview).join("") + '</div>') +
    '<div id="account-group-' + index + '" class="account-group-cards"' + (expanded ? "" : " hidden") + '>' +
    (expanded ? group.accounts.map(renderPlatformCard).join("") : "") + '</div></section>';
}
function toggleAccountGroup(key) {
  if (!groupAccounts(platforms).some((group) => group.key === key)) return;
  if (expandedAccountGroups.has(key)) expandedAccountGroups.delete(key); else expandedAccountGroups.add(key);
  chrome.storage.local.set({ [KEY_EXPANDED_GROUPS]: [...expandedAccountGroups] });
  render();
}

function render() {
  const grid = $("platformGrid");
  $("totalPlatforms").textContent = platforms.length;
  const today = todayStr();
  $("checkedPlatforms").textContent = platforms.filter((p) => !isVisitOnly(p) && p.stats && p.stats.checked_in_today && p.statsDate === today).length;
  $("monthCheckins").textContent = platforms.reduce((n, p) => n + ((!isVisitOnly(p) && p.stats && p.stats.checkin_count) || 0), 0);
  const groups = groupAccounts(platforms);
  const totals = groups.map((group) => accountGroupSummary(group.accounts));
  const totalQuota = totals.reduce((sum, group) => sum + group.total, 0);
  const hasQuota = totals.some((group) => group.known);
  $("totalQuota").innerHTML = (hasQuota && Number.isFinite(totalQuota) ? totalQuota.toFixed(4) : "—") + ' <small>$</small>';

  if (!platforms.length) {
    grid.innerHTML = '<div class="empty">还没有平台配置，点击下方「添加平台」开始使用。</div>';
    return;
  }
  grid.innerHTML = groups.map(renderAccountGroup).join("");
}
function renderPlatformCard(p) {
  const [label, cls] = status(p);
  const busy = p.loading || !!currentVisitProgress(p.id);
  const acc = p.account || {};
  const qv = (v) => formatQuota(v, quotaUnitFor(acc));
  const qt = (v, trunc) => fmtTokens(v, trunc);
  const addr = safeHttpUrl(p.baseUrl);
  return (
    '<article class="platform-card"><div class="card-top"><div>' +
    "<h3 class=\"platform-name\">" + esc(p.name) + "</h3>" +
    (addr
      ? '<a class="address address-link" href="' + esc(addr) + '" target="_blank" rel="noopener noreferrer" data-action="open-site" title="在浏览器中打开 ' + esc(p.baseUrl) + '">' + esc(p.baseUrl) + "</a>"
      : '<div class="address" title="' + esc(p.baseUrl) + '">' + esc(p.baseUrl) + "</div>") +
    "</div>" +
    '<span class="badge ' + cls + '">' + label + "</span>" + (normalizeKeepAlive(p.keepAlive).enabled ? '<span class="badge badge-keepalive" title="已开启自动调用API（防僵尸号）">保活</span>' : "") + "</div>" +
    '<div class="card-stats">' +
    '<div class="mini-stat"><strong>' + qv(acc.available) + '</strong><span>可用额度</span></div>' +
    '<div class="mini-stat"><strong>' + qv(acc.used) + '</strong><span>已用额度</span></div>' +
    '<div class="mini-stat"><strong>' + qt(acc.monthlyTokens, acc.tokensTruncated) + '</strong><span>本月Token</span></div>' +
    "</div>" +
    '<p class="account-meta">' + esc(accountIdentity(p)) + ' · ' + esc(accountUpdatedLabel(acc)) + '</p>' +
    '<p class="message' + ((p.error || p.accountError) && !currentVisitProgress(p.id) && !cancelledCheckins.has(p.id) ? " err" : "") + '">' + esc(currentVisitProgress(p.id) || cancelledCheckins.get(p.id) || p.error || p.accountError || p.message || p.note || "尚未获取最新统计") + "</p>" +
    '<div class="card-actions">' +
    '<button class="btn btn-primary" data-action="checkin" data-id="' + esc(p.id) + '"' + (busy ? " disabled" : "") + ">" + (isVisitOnly(p) ? (busy ? "访问中…" : "立即访问") : (busy ? "签到中…" : "立即签到")) + "</button>" +
    '<button class="btn btn-light" data-action="stats" data-id="' + esc(p.id) + '">刷新</button>' +
    (hasModelPanel() ? '<button class="btn btn-light" data-action="models" data-id="' + esc(p.id) + '">模型</button>' : "") +
    '<button class="btn btn-light" data-action="edit" data-id="' + esc(p.id) + '">编辑</button>' +
    '<button class="btn btn-danger" data-action="delete" data-id="' + esc(p.id) + '">删除</button>' +
    "</div></article>"
  );
}

// ---------- 操作 ----------
async function checkin(id, options) {
  options = options || {};
  const p = platforms.find((x) => x.id === id);
  if (!p || p.loading || activeCheckins.has(id) || startingCheckins.has(id)) return;
  const taskConfig = slim(p);
  const hasRunVersion = validStopVersion(options.stopVersion);
  const starting = { stopVersion: checkinStopVersion, cancelled: false };
  startingCheckins.set(id, starting);
  cancelledCheckins.delete(id);
  p.loading = true;
  p.error = "";
  render();
  const stopVersion = hasRunVersion ? options.stopVersion : await latestStopVersion();
  if (startingCheckins.get(id) !== starting || starting.cancelled) {
    return { ok: false, cancelled: true, code: "CHECKIN_CANCELLED", message: "签到已终止" };
  }
  startingCheckins.delete(id);
  if (stopVersion !== checkinStopVersion) {
    p.loading = false;
    markCheckinCancelled(id, "签到已终止");
    render();
    return { ok: false, cancelled: true, code: "CHECKIN_CANCELLED", message: "签到已终止" };
  }
  const operation = { id: ++checkinRequestSequence, stopVersion };
  activeCheckins.set(id, operation);
  const r = await doCheckin(p, Object.assign({}, options, { stopVersion: operation.stopVersion }));
  if (activeCheckins.get(id) !== operation) {
    return { ok: false, cancelled: true, code: "CHECKIN_CANCELLED", message: "签到已终止" };
  }
  if (isCancelledResult(r)) {
    releaseCheckinOperation(id, operation);
    p.loading = false;
    markCheckinCancelled(id, r.message || "签到已终止");
    render();
    toast(p.name + "：" + (r.message || "签到已终止"));
    return r;
  }
  if (operation.stopVersion !== checkinStopVersion) {
    releaseCheckinOperation(id, operation);
    p.loading = false;
    markCheckinCancelled(id, "签到已终止");
    render();
    return { ok: false, cancelled: true, code: "CHECKIN_CANCELLED", message: "签到已终止" };
  }
  const current = platforms.find((entry) => entry.id === id);
  if (!current || !sameConnectionConfig(taskConfig, slim(current))) {
    releaseCheckinOperation(id, operation);
    p.loading = false;
    render();
    toast("平台鉴权配置已变更，本次结果未覆盖当前账号", !r.ok);
    return r;
  }
  releaseCheckinOperation(id, operation);
  if (r.keepAlive && typeof r.keepAlive.date === "string") {
    p.keepAlive = normalizeKeepAlive(Object.assign({}, normalizeKeepAlive(p.keepAlive), { lastDate: r.keepAlive.date }));
  }
  p.message = r.message;
  p.error = r.ok ? "" : r.message;
  // 今日已签到判定：成功 或 站点明确提示重复签到，都锚定今天，防止跨天误显
  p.reauthPending = !!r.reauthRequired;
  if (r.reauthRequired) p.reauthStartedAt = r.reauthStartedAt;
  if (r.account) { p.account = Object.assign({}, p.account || {}, r.account); p.accountError = ""; }
  if (r.visited) {
    p.lastVisitDate = r.lastVisitDate; p.lastVisitedAt = r.lastVisitedAt;
  }
  if (!r.visited && !isVisitOnly(p) && !r.reauthRequired && (r.ok || isAlreadyCheckinMessage(r.message))) {
    p.stats = p.stats || {};
    if (r.data && r.data.stats) Object.assign(p.stats, r.data.stats);
    p.stats.checked_in_today = true;
    p.statsDate = todayStr();
  }
  p.loading = false;
  render();
  toast(p.name + "：" + r.message, !r.ok);
  await savePlatforms();
  // 后台在任务完成前已取回额度；OAuth 则由回调同步，不能在关页后再开页取数。
  return r;
}

async function fetchStats(id, btnEl) {
  const p = platforms.find((x) => x.id === id);
  if (!p || p.loading) return;
  // 刷新只拉额度，不触发签到；不改动签到的 loading 标志，避免"立即签到"按钮被牵连
  const btn = btnEl || document.querySelector('button[data-action="stats"][data-id="' + CSS.escape(String(id)) + '"]');
  if (btn) btn.disabled = true;
  try {
    await refreshStats(id, false);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function refreshStats(id, silent) {
  const p = platforms.find((x) => x.id === id);
  if (!p) return;
  // 刷新只拉账户额度三项，不调用签到/统计接口，避免触发签到或干扰签到状态
  const config = slim(p);
  const r = await getAccount(p);
  const current = platforms.find(x => x.id === id);
  if (!current || !sameConnectionConfig(config, slim(current))) return;
  mergeStatsInto(id, null, r.ok ? "额度已更新" : r.message, r.ok, r.account || null);
  await savePlatforms();
  render();
  if (!silent) toast(p.name + "：" + (r.ok ? "额度已更新" : r.message), !r.ok);
}

async function runBatch(action, operation = null) {
  for (const id of platforms.map((p) => p.id)) {
    if (operation && (operation.cancelled || operation.stopVersion !== checkinStopVersion)) {
      operation.cancelled = true;
      return { cancelled: true };
    }
    const result = await action(id);
    if (operation && isCancelledResult(result)) {
      operation.cancelled = true;
      return { cancelled: true };
    }
    if (operation && (operation.cancelled || operation.stopVersion !== checkinStopVersion)) {
      operation.cancelled = true;
      return { cancelled: true };
    }
  }
  return { cancelled: false };
}

async function refreshAll() {
  if (!platforms.length) return toast("请先添加平台", true);
  $("refreshBtn").disabled = true;
  try {
    await runBatch((id) => refreshStats(id, true));
    toast("统计刷新完成");
  } finally {
    $("refreshBtn").disabled = false;
  }
}

// ---------- 模型可用性与性能面板（只读，仅宽屏页） ----------
// 指标来自站点自身按真实流量的采样统计，不需要调用模型，也不消耗额度。
// 注意：success_rate 上游已是 0-100 的百分数，直接使用，不要再乘 100。
const hasModelPanel = () => !!$("modelModal");
let modelInsightRequest = 0;
let modelDetailRequest = 0;
let modelState = { platformId: null, hours: 24, rows: [], site: null, warnings: [], loading: false, detailModel: null };

function fmtMs(v) {
  if (v == null) return "—";
  const n = Number(v);
  if (!isFinite(n) || n <= 0) return "—";
  return n >= 1000 ? (n / 1000).toFixed(2) + " s" : Math.round(n) + " ms";
}
function fmtRate(v) {
  return v == null ? "—" : Number(v).toFixed(2) + "%";
}
function fmtTps(v) {
  return v == null || Number(v) <= 0 ? "—" : Number(v).toFixed(1);
}

// 成功率分档：上游刻度为 0-100
function healthOf(perf) {
  if (!perf || perf.successRate == null) return ["无指标", "badge-muted"];
  const r = Number(perf.successRate);
  if (r >= 99) return ["优", "badge-success"];
  if (r >= 95) return ["良", "badge-success"];
  if (r >= 85) return ["波动", "badge-warning"];
  return ["异常", "badge-danger"];
}

function visibleModelRows() {
  const kw = ($("modelSearch").value || "").trim().toLowerCase();
  const onlyTraffic = $("modelOnlyTraffic").checked;
  let rows = modelState.rows.slice();
  if (kw) rows = rows.filter((r) => r.model.toLowerCase().includes(kw));
  if (onlyTraffic) rows = rows.filter((r) => r.perf && r.perf.successRate != null);
  // 有指标的排前面并按成功率降序；无指标的按名称排序
  rows.sort((a, b) => {
    const ra = a.perf && a.perf.successRate != null ? Number(a.perf.successRate) : null;
    const rb = b.perf && b.perf.successRate != null ? Number(b.perf.successRate) : null;
    if (ra == null && rb == null) return a.model.localeCompare(b.model);
    if (ra == null) return 1;
    if (rb == null) return -1;
    return rb - ra;
  });
  return rows;
}

function renderModelTable() {
  const wrap = $("modelTableWrap");
  if (modelState.loading) {
    wrap.innerHTML = '<div class="model-empty">正在读取模型指标…</div>';
    return;
  }
  const rows = visibleModelRows();
  if (!rows.length) {
    wrap.innerHTML = '<div class="model-empty">没有符合条件的模型。</div>';
    return;
  }
  const body = rows
    .map((r) => {
      const [label, cls] = healthOf(r.perf);
      const perf = r.perf || {};
      const groups = (r.groups || []).join(", ");
      return (
        '<tr data-model="' + esc(r.model) + '"' + (modelState.detailModel === r.model ? ' class="active"' : "") + ">" +
        '<td class="m-name"><span>' + esc(r.model) + "</span>" +
        (r.inCatalog ? "" : '<em class="m-tag" title="站点清单未返回该模型，可能你的分组不可见">清单外</em>') +
        "</td>" +
        '<td class="m-status"><span class="badge ' + cls + '">' + label + "</span></td>" +
        '<td class="m-num">' + fmtRate(perf.successRate) + "</td>" +
        '<td class="m-num">' + fmtMs(perf.avgTtftMs) + "</td>" +
        '<td class="m-num">' + fmtMs(perf.avgLatencyMs) + "</td>" +
        '<td class="m-num">' + fmtTps(perf.avgTps) + "</td>" +
        '<td class="m-groups" title="' + esc(groups) + '">' + esc(groups || "—") + "</td>" +
        "</tr>"
      );
    })
    .join("");
  wrap.innerHTML =
    '<table class="model-table"><thead><tr>' +
    "<th>模型</th><th class=\"m-status\">状态</th><th class=\"m-num\">成功率</th><th class=\"m-num\">首字延迟</th>" +
    "<th class=\"m-num\">平均耗时</th><th class=\"m-num\">TPS</th><th>可用分组</th>" +
    "</tr></thead><tbody>" + body + "</tbody></table>" +
    '<p class="model-tip">共 ' + rows.length + " 行 · 点击任意行查看分组明细与时段趋势</p>";
}

function renderModelMeta() {
  const el = $("modelMeta");
  const site = modelState.site;
  const parts = [];
  if (site) {
    if (site.systemName) parts.push("站点：" + site.systemName);
    if (site.version) parts.push("内核：" + site.version);
    if (site.quotaPerUnit != null && site.quotaPerUnit !== 500000)
      parts.push("quota_per_unit=" + site.quotaPerUnit + "（额度按此站单位换算）");
  }
  const withPerf = modelState.rows.filter((r) => r.perf && r.perf.successRate != null).length;
  if (modelState.rows.length) parts.push("模型 " + modelState.rows.length + " 个，其中 " + withPerf + " 个有近期指标");
  const warn = (modelState.warnings || []).map((w) => '<span class="model-warn">' + esc(w) + "</span>").join("");
  el.innerHTML = (parts.length ? '<span>' + parts.map(esc).join("</span><span>") + "</span>" : "") + warn;
}

async function loadModelInsight() {
  const p = platforms.find((x) => x.id === modelState.platformId);
  if (!p) return;
  const request = ++modelInsightRequest;
  ++modelDetailRequest;
  const hours = modelState.hours;
  modelState.loading = true;
  modelState.detailModel = null;
  $("modelDetail").innerHTML = "";
  renderModelTable();
  const r = await getModelInsight(p, hours);
  if (request !== modelInsightRequest || modelState.platformId !== p.id || modelState.hours !== hours || !$("modelModal").classList.contains("open")) return;
  modelState.loading = false;
  if (!r || !r.ok) {
    modelState.rows = [];
    modelState.site = (r && r.site) || null;
    modelState.warnings = [];
    renderModelMeta();
    $("modelTableWrap").innerHTML =
      '<div class="model-empty err">' + esc((r && r.message) || "读取失败") + "</div>";
    return;
  }
  modelState.rows = r.rows || [];
  modelState.site = r.site || null;
  modelState.warnings = r.warnings || [];
  renderModelMeta();
  renderModelTable();
}

async function openModelPanel(id) {
  if (!hasModelPanel()) return;
  const p = platforms.find((x) => x.id === id);
  if (!p) return;
  modelState.platformId = id;
  modelState.hours = Number($("modelHours").value) || 24;
  $("modelModalTitle").textContent = "模型可用性与性能 · " + p.name;
  $("modelSearch").value = "";
  $("modelDetail").innerHTML = "";
  $("modelMeta").innerHTML = "";
  $("modelModal").classList.add("open");
  await loadModelInsight();
}

// 只切换行高亮，不重建表格，避免滚动位置跳动
function setActiveModelRow(model) {
  const wrap = $("modelTableWrap");
  if (!wrap) return;
  wrap.querySelectorAll("tr[data-model]").forEach((tr) => {
    tr.classList.toggle("active", tr.dataset.model === model);
  });
}

async function showModelDetail(model) {
  const p = platforms.find((x) => x.id === modelState.platformId);
  if (!p) return;
  const box = $("modelDetail");
  const request = ++modelDetailRequest;
  const hours = modelState.hours;
  // 再次点击同一行时收起明细
  if (modelState.detailModel === model) {
    modelState.detailModel = null;
    setActiveModelRow(null);
    box.innerHTML = "";
    return;
  }
  modelState.detailModel = model;
  setActiveModelRow(model);
  box.innerHTML = '<div class="model-empty">正在读取「' + esc(model) + '」明细…</div>';
  const r = await getModelDetail(p, model, hours);
  // 期间用户已收起或切换到别的模型，丢弃本次结果
  if (request !== modelDetailRequest || modelState.detailModel !== model || modelState.platformId !== p.id || modelState.hours !== hours || !$("modelModal").classList.contains("open")) return;
  if (!r || !r.ok) {
    box.innerHTML = '<div class="model-empty err">' + esc((r && r.message) || "明细读取失败") + "</div>";
    return;
  }
  if (!r.groups.length) {
    box.innerHTML = '<div class="model-empty">「' + esc(model) + '」在近 ' + r.hours + " 小时内没有分组采样数据。</div>";
    return;
  }
  const groupRows = r.groups
    .map((g) => {
      const [label, cls] = healthOf({ successRate: g.successRate });
      return (
        "<tr><td>" + esc(g.group || "default") + "</td>" +
        '<td class="m-status"><span class="badge ' + cls + '">' + label + "</span></td>" +
        '<td class="m-num">' + fmtRate(g.successRate) + "</td>" +
        '<td class="m-num">' + fmtMs(g.avgTtftMs) + "</td>" +
        '<td class="m-num">' + fmtMs(g.avgLatencyMs) + "</td>" +
        '<td class="m-num">' + fmtTps(g.avgTps) + "</td>" +
        '<td class="m-num">' + g.series.length + "</td></tr>"
      );
    })
    .join("");
  box.innerHTML =
    '<h3 class="model-detail-title">' + esc(r.model) + " · 分组明细（近 " + r.hours + " 小时）</h3>" +
    '<table class="model-table"><thead><tr>' +
    "<th>分组</th><th class=\"m-status\">状态</th><th class=\"m-num\">成功率</th><th class=\"m-num\">首字延迟</th>" +
    "<th class=\"m-num\">平均耗时</th><th class=\"m-num\">TPS</th><th class=\"m-num\">采样点</th>" +
    "</tr></thead><tbody>" + groupRows + "</tbody></table>" +
    renderSparkline(r.groups[0]);
}

// 用纯 CSS 柱状条画成功率趋势，避免引入图表库
function renderSparkline(group) {
  if (!group || !group.series || !group.series.length) return "";
  const pts = group.series.slice(-24);
  const bars = pts
    .map((pt) => {
      const rate = pt.success_rate == null ? null : Number(pt.success_rate);
      const h = rate == null ? 4 : Math.max(4, Math.round(rate));
      const cls = rate == null ? "na" : rate >= 95 ? "ok" : rate >= 85 ? "warn" : "bad";
      const when = pt.ts ? new Date(Number(pt.ts) * 1000).toLocaleString() : "";
      const title = when + " 成功率 " + (rate == null ? "无数据" : rate.toFixed(2) + "%") +
        " · 延迟 " + fmtMs(pt.avg_latency_ms) + " · TPS " + fmtTps(pt.avg_tps);
      return '<i class="' + cls + '" style="height:' + h + '%" title="' + esc(title) + '"></i>';
    })
    .join("");
  return '<div class="model-spark"><span class="model-spark-label">成功率趋势（' + esc(group.group || "default") +
    "，最近 " + pts.length + " 个时段）</span><div class=\"model-spark-bars\">" + bars + "</div></div>";
}

// ---------- 添加/编辑 ----------
function keepAliveFromForm() {
  return {
    enabled: $("keepAliveEnabled") ? $("keepAliveEnabled").checked : false,
    url: $("keepAliveUrl") ? $("keepAliveUrl").value.trim() : "",
    key: $("keepAliveKey") ? $("keepAliveKey").value : "",
    format: $("keepAliveFormat") && KEEPALIVE_FORMATS.indexOf($("keepAliveFormat").value) >= 0 ? $("keepAliveFormat").value : "chat",
    model: $("keepAliveModel") ? $("keepAliveModel").value.trim() : "",
  };
}
function formData() {
  const prev = platforms.find((x) => x.id === editingId) || null;
  return {
    name: $("name").value.trim(),
    baseUrl: $("baseUrl").value.trim().replace(/\/+$/, ""),
    userId: $("userId").value.trim(),
    accessToken: $("authMode").value === "token" ? $("accessToken").value.trim() : "",
    loginUsername: $("authMode").value === "password" ? $("loginUsername").value.trim() : "",
    loginPassword: $("authMode").value === "password" ? $("loginPassword").value : "",
    visitOnly: $("visitOnly").checked,
    logoutAfterVisit: $("logoutAfterVisit").checked,
    note: $("note").value.trim(),
    authMode: $("authMode") ? $("authMode").value : "token",
    keepAlive: Object.assign({}, normalizeKeepAlive(prev && prev.keepAlive), keepAliveFromForm()),
  };
}

function openModal(p) {
  invalidateConnectionTest();
  editingId = p ? p.id : null;
  $("modalTitle").textContent = p ? "编辑平台" : "添加平台";
  $("name").value = p ? p.name || "" : "";
  $("baseUrl").value = p ? p.baseUrl || "" : "";
  $("userId").value = p ? p.userId || "" : "";
  $("accessToken").value = p ? p.accessToken || "" : "";
  $("loginUsername").value = p ? p.loginUsername || "" : "";
  $("loginPassword").value = p ? p.loginPassword || "" : "";
  $("visitOnly").checked = isVisitOnly(p);
  $("logoutAfterVisit").checked = NACheckinAuth.shouldLogoutAfterVisit(p);
  $("note").value = p ? p.note || "" : "";
  const keepKa = normalizeKeepAlive(p && p.keepAlive);
  $("keepAliveEnabled").checked = keepKa.enabled;
  $("keepAliveUrl").value = keepKa.url || keepAliveDefaultUrl($("baseUrl").value, keepKa.format);
  $("keepAliveKey").value = keepKa.key || "";
  $("keepAliveFormat").value = keepKa.format;
  $("keepAliveModel").value = keepKa.model;
  if ($("keepAliveFormat")) $("keepAliveFormat").dataset.prevFmt = keepKa.format;
  syncKeepAliveFields();
  // Agent Router 使用网站原生退出与 GitHub OAuth 登录回调签到。
  if (p && p.authMode) {
    $("authMode").value = AUTH_MODES.includes(p.authMode) ? p.authMode : "token";
  } else {
    const u = $("baseUrl").value.trim();
    $("authMode").value = /agentrouter\.org|ps\.air-outer\.com/i.test(u) ? "agentrouter_token" : "token";
  }
  toggleAuthFields();
  $("connectionStatus").className = "connection-status";
  $("connectionStatus").textContent = "";
  const ksEl = $("keepAliveStatus");
  if (ksEl) { ksEl.className = "connection-status"; ksEl.textContent = ""; }
  const mlEl = $("keepAliveModelList");
  if (mlEl) { mlEl.className = "keepalive-model-list"; mlEl.textContent = ""; }
  $("modal").classList.add("open");
  $("name").focus();
}
// 鉴权方式切换：Cookie 模式时令牌/用户ID可留空，并提示
function toggleAuthFields() {
  const mode = $("authMode").value;
  const password = mode === "password";
  const agent = isAgentRouterMode({ authMode: mode });
  $("visitOnlyField").style.display = "";
  const visit = $("visitOnly").checked;
  $("logoutAfterVisitField").style.display = visit ? "" : "none";
  $("keepAliveEnabled").disabled = false;
  syncKeepAliveFields();
  $("testBtn").textContent = "检测连接";
  $("accessToken").required = mode === "token";
  $("accessTokenField").style.display = mode === "token" ? "" : "none";
  $("loginUsernameField").style.display = password ? "" : "none";
  $("loginPasswordField").style.display = password ? "" : "none";
  $("loginUsername").required = password;
  $("loginPassword").required = password;
  $("userId").required = agent;
  const provider = mode === "agentrouter_linuxdo" ? "Linux DO" : "GitHub";
  $("authHint").textContent = visit
    ? "仅访问：正常登录后刷新首页一次，读取最新额度并更新卡片后关闭临时页；只跳过签到接口，额度、模型及已配置的保活保持正常。" + (password ? "邮箱密码会自动补登录；验证码需手动完成。" : agent ? provider + " 会启动本站 OAuth 登录，必要时请手动授权。" : "Cookie/令牌不能代替网页登录；会话失效时需在打开的页面手动登录。") + "访问结束后默认不退出账号，仅关闭本轮临时页；开启“访问结束后退出账号”才在收尾时退出（同站其他页面也会受影响）。切换账号或重新授权前的必要退出不受此开关影响；保存不自动测试账号，执行任务时核验身份和额度。"
    : password
    ? "邮箱密码模式：仅支持 HTTPS，扩展会在本站 /login 页面打开邮箱/用户名表单并填写登录。密码仅存本地（未加密），导出不含密码；验证码需手动完成。"
    : agent
      ? "Agent Router 模式：填写数字用户ID，确保浏览器已登录对应账号；扩展会退出当前会话并通过 " + provider + " 重新登录。只有登录回调确认签到后才标记成功；Linux DO 本轮匹配的“允许”会自动点击，其他授权、登录或验证码需手动完成。"
      : mode === "cookie"
        ? "Cookie 模式：需已在浏览器登录该站点；agentrouter.org 使用 GitHub 重登录签到，需要授权或验证码时请手动完成。"
        : "令牌模式：填「个人设置」生成的系统访问令牌（约32位），非「令牌管理」的 API 令牌(sk-xxx)。";
}

function syncKeepAliveFields() {
  if (!$("keepAliveEnabled")) return;
  const on = $("keepAliveEnabled").checked;
  if ($("keepAliveFields")) $("keepAliveFields").style.display = on ? "" : "none";
  if (on) {
    const base = $("baseUrl").value.trim().replace(/\/+$/, "");
    const urlEl = $("keepAliveUrl");
    if (urlEl && base && !urlEl.value.trim()) {
      urlEl.value = keepAliveDefaultUrl(base, $("keepAliveFormat") ? $("keepAliveFormat").value : "chat");
    }
  }
}
function onKeepAliveFormatChange() {
  const fmtEl = $("keepAliveFormat");
  const urlEl = $("keepAliveUrl");
  if (!fmtEl || !urlEl) return;
  const prevFmt = fmtEl.dataset.prevFmt || "chat";
  const base = $("baseUrl").value.trim().replace(/\/+$/, "");
  const expected = base ? base + (KEEPALIVE_PATHS[prevFmt] || "") : "";
  if (!urlEl.value.trim() || (expected && urlEl.value.trim() === expected)) {
    urlEl.value = keepAliveDefaultUrl(base, fmtEl.value);
  }
  fmtEl.dataset.prevFmt = fmtEl.value;
}

function editPlatform(id) {
  openModal(platforms.find((p) => p.id === id));
}

function connectionStatus(text, type) {
  const el = $("connectionStatus");
  el.textContent = text;
  el.className = "connection-status show " + (type || "loading");
}

function sameConnectionConfig(a, b) {
  return ["baseUrl", "authMode", "userId", "accessToken", "loginUsername", "loginPassword", "visitOnly"].every((key) => a[key] === b[key]);
}
function invalidateConnectionTest() {
  ++connectionRequestId;
  connectionPromise = null;
  connectionConfig = null;
  $("testBtn").disabled = false;
  connectionStatus("", "");
  $("connectionStatus").className = "connection-status";
}
async function testConnection() {
  const data = formData();
  if (connectionPromise && connectionConfig && sameConnectionConfig(data, connectionConfig)) return connectionPromise;
  try { validatePlatform(data); }
  catch (e) { connectionStatus(e.message, "error"); throw e; }
  const requestId = ++connectionRequestId;
  connectionConfig = data;
  const current = () => requestId === connectionRequestId && sameConnectionConfig(data, formData());
  $("testBtn").disabled = true;
  connectionStatus(data.authMode === "password" ? "正在检测登录会话，必要时将打开本站登录表单…" : "正在检测站点连接，请稍候…");
  connectionPromise = (async () => {
    try {
      const r = await send({ type: "test", platform: slim(data), month: $("monthInput").value || currentMonth() });
      if (!current()) throw new Error("鉴权配置已变更，请按当前配置重新检测连接");
      if (r.ok) {
        const needsUserId = data.userId ? "当前站点已使用用户ID鉴权。" : "当前站点无需用户ID即可连接。";
        if (r.needsLogin) connectionStatus(r.message, "loading");
        else connectionStatus("连接成功：" + (r.message || "账户接口可用") + " " + needsUserId, "success");
        return r;
      }
      throw new Error(r.message || "未收到有效检测结果");
    } catch (e) {
      if (current()) connectionStatus("连接失败：" + (e.message || "未知错误"), "error");
      throw e;
    } finally {
      if (requestId === connectionRequestId) {
        connectionPromise = null;
        connectionConfig = null;
        $("testBtn").disabled = false;
      }
    }
  })();
  return connectionPromise;
}

function keepAliveStatusText(text, type) {
  const el = $("keepAliveStatus");
  if (!el) return;
  el.textContent = text;
  el.className = "connection-status full show " + (type || "loading");
  el.style.display = "block";
  // 若折叠区域仍处于隐藏状态，强制展开，确保结果文字可见
  const wrap = el.closest ? el.closest("#keepAliveFields") : null;
  if (wrap && wrap.style && wrap.style.display === "none") wrap.style.display = "";
  if (el.scrollIntoView) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
}
async function testKeepAlive() {
  if (keepAliveTestPromise) return keepAliveTestPromise;
  const btn = $("keepAliveTestBtn");
  const fail = (msg) => {
    try {
      keepAliveStatusText("API 调用失败：" + msg, "error");
      toast("检测API调用失败：" + msg, true);
    } catch (err) {
      try { console.error("[保活检测] 显示失败信息时出错：", err); } catch (_) {}
    }
  };
  try {
    const data = formData();
    const ka = normalizeKeepAlive(data.keepAlive);
    validatePlatform(data);
    if (!ka.enabled) throw new Error("请先开启「自动调用 API」开关");
    if (btn) { btn.disabled = true; btn.dataset.label = btn.textContent; btn.textContent = "检测中…"; }
    keepAliveStatusText("正在发送一次 API 调用，请稍候…", "loading");
    keepAliveTestPromise = (async () => {
      const r = await Promise.race([
        send({
          type: "testKeepAlive",
          platform: { baseUrl: data.baseUrl, accessToken: data.accessToken, authMode: data.authMode, keepAlive: ka },
        }),
        new Promise((resolve) => setTimeout(() => resolve({ ok: false, message: "后台无响应（超时 25 秒），请到扩展管理页重新加载扩展后重试。" }), 25000)),
      ]);
      if (r && r.ok) {
        const okMsg = "API 调用成功" + (r.model ? "（模型 " + r.model + "）" : "");
        keepAliveStatusText(okMsg, "success");
        toast(okMsg);
      } else {
        fail((r && r.message) || "未知错误");
      }
      return r;
    })();
    return await keepAliveTestPromise;
  } catch (e) {
    try { console.error("[保活检测] 点击检测失败：", e); } catch (_) {}
    fail(e && e.message ? e.message : "未知错误");
    return null;
  } finally {
    keepAliveTestPromise = null;
    if (btn) {
      btn.disabled = false;
      if (btn.dataset.label) { btn.textContent = btn.dataset.label; delete btn.dataset.label; }
    }
  }
}
async function pickKeepAliveModels() {
  if (keepAlivePickPromise) return keepAlivePickPromise;
  const box = $("keepAliveModelList");
  const setLoading = (txt) => {
    if (!box) return;
    box.className = "keepalive-model-list loading";
    box.textContent = txt || "";
  };
  const clearBox = () => {
    if (!box) return;
    box.className = "keepalive-model-list";
    box.textContent = "";
  };
  keepAlivePickPromise = (async () => {
    try {
      const data = formData();
      const ka = normalizeKeepAlive(data.keepAlive);
      validatePlatform(data);
      if (!ka.enabled) throw new Error("请先开启「自动调用 API」开关");
      setLoading("正在读取模型列表…");
      const r = await send({
        type: "keepAliveModels",
        platform: { baseUrl: data.baseUrl, accessToken: data.accessToken, authMode: data.authMode, keepAlive: ka },
      });
      if (!r || !r.ok) throw new Error((r && r.message) || "读取模型列表失败");
      const models = Array.isArray(r.models) ? r.models : [];
      if (!models.length) throw new Error("站点没有可用对话模型");
      renderKeepAliveModelChoices(models);
      if (box) box.scrollIntoView({ block: "nearest", behavior: "smooth" });
      return r;
    } catch (e) {
      try { console.error("[保活] 选择模型失败：", e); } catch (_) {}
      keepAliveStatusText("读取模型列表失败：" + ((e && e.message) || "未知错误"), "error");
      clearBox();
      return null;
    }
  })();
  try {
    return await keepAlivePickPromise;
  } finally {
    keepAlivePickPromise = null;
  }
}
function renderKeepAliveModelChoices(models) {
  const box = $("keepAliveModelList");
  if (!box) return;
  box.className = "keepalive-model-list";
  box.textContent = "";
  const seen = {};
  const items = models.filter((m) => {
    const s = String(m == null ? "" : m).trim();
    if (!s || seen[s]) return false;
    seen[s] = 1;
    return true;
  });
  const choose = (model) => {
    const input = $("keepAliveModel");
    if (!input) return;
    input.value = model || "";
    box.className = "keepalive-model-list";
    box.textContent = "";
    if (model) {
      keepAliveStatusText("已选择模型：" + model + "（保存后保活调用将直接使用该模型）", "success");
      toast("已选择模型 " + model);
    } else {
      keepAliveStatusText("模型已留空：默认 deepseek v4 flash，不支持时自动检测", "success");
      toast("模型已留空（自动检测）");
    }
  };
  const addBtn = (label, value) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "keepalive-model-chip";
    b.textContent = label;
    b.title = value ? "点击使用该模型" : "清空模型输入，按默认规则自动选择";
    b.onclick = () => choose(value);
    box.appendChild(b);
  };
  addBtn("留空（自动检测）", "");
  items.forEach((m) => addBtn(m, m));
}
function removePlatform(id) {
  const p = platforms.find((x) => x.id === id);
  if (!p) return;
  deletingId = id;
  $("deleteMessage").textContent = '确定删除"' + p.name + '"吗？删除后无法恢复。';
  $("deleteModal").classList.add("open");
}
function closeDelete() {
  deletingId = null;
  $("deleteModal").classList.remove("open");
}

// ---------- 设置 ----------
async function applySettings(s) {
  if (!s) s = { autoEnabled: false, autoTime: "08:01", autoApprove: false, notify: true };
  $("autoEnabled").checked = !!s.autoEnabled;
  $("autoTime").value = /^([01]\d|2[0-3]):[0-5]\d$/.test(s.autoTime || "") ? s.autoTime : "08:01";
  $("autoApprove").checked = !!s.autoApprove;
  $("notifyEnabled").checked = s.notify !== false;
  $("checkinIntervalSeconds").value = String(AUTH_CONFIG.normalizeCheckinInterval(s.checkinIntervalSeconds));
}
async function saveSettings() {
  const settings = {
    autoEnabled: $("autoEnabled").checked,
    autoTime: $("autoTime").value || "08:01",
    autoApprove: $("autoApprove").checked,
    notify: $("notifyEnabled").checked,
    checkinIntervalSeconds: AUTH_CONFIG.normalizeCheckinInterval($("checkinIntervalSeconds").value),
  };
  $("checkinIntervalSeconds").value = String(settings.checkinIntervalSeconds);
  const result = await send({ type: "saveSettings", settings });
  if (!result || !result.ok) { toast(result && result.message || "设置保存失败", true); return; }
  toast("设置已保存；签到间隔 " + settings.checkinIntervalSeconds + " 秒");
}
async function renderLastAuto() {
  const r = await send({ type: "getLastAuto" });
  const el = $("lastAutoMsg");
  if (r && r.last) {
    const t = new Date(r.last.time);
    let lastTxt = "上次签到：" + t.toLocaleString() + " · 成功 " + r.last.ok + " / 已签 " + r.last.already + " / 失败 " + r.last.fail + (r.last.pending ? " / 等待登录 " + r.last.pending : "") + (r.last.visited ? " / 已访问 " + r.last.visited : "");
    if (r.last.aliveOk || r.last.aliveFail) lastTxt += " · 保活成功 " + r.last.aliveOk + " / 失败 " + r.last.aliveFail;
    el.textContent = lastTxt;
  } else {
    el.textContent = "尚未执行过自动签到。";
  }
}

// ---------- 导入/导出 ----------
function exportConfig() {
  const clean = platforms.map(({ loading, error, loginPassword, reauthPending, reauthStartedAt, reauthCompletedAt, ...rest }) => rest);
  const blob = new Blob([JSON.stringify(clean, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "newapi-checkin-config.json";
  a.click();
  URL.revokeObjectURL(a.href);
  toast("配置已导出");
}
async function importConfig(file) {
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data)) throw new Error("配置格式必须是数组");
    const ids = new Set();
    platforms = data.map((p) => {
      if (!p || typeof p !== "object" || Array.isArray(p)) throw new Error("平台配置项必须是对象");
      let id = typeof p.id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(p.id) ? p.id : crypto.randomUUID();
      if (ids.has(id)) id = crypto.randomUUID();
      ids.add(id);
      return {
        id,
        authMode: AUTH_MODES.includes(p.authMode) ? p.authMode : "token",
        name: p.name || "",
        baseUrl: p.baseUrl || "",
        userId: String(p.userId || ""),
        accessToken: p.accessToken || "",
        loginUsername: p.authMode === "password" ? String(p.loginUsername || "").trim() : "",
        visitOnly: p.visitOnly === true,
        logoutAfterVisit: NACheckinAuth.shouldLogoutAfterVisit(p),
        loginPassword: "", // 永远不信任导入文件里的密码；需要在本地重新填写。
        note: p.note || "",
        keepAlive: normalizeKeepAlive(p.keepAlive),
        stats: p.stats || {},
        message: p.message || "",
      };
    });
    await savePlatforms(true);
    render();
    toast("已导入 " + platforms.length + " 个平台" + (platforms.some((p) => p.authMode === "password") ? "；邮箱密码平台需编辑补填密码" : ""));
  } catch (e) {
    toast("导入失败：" + e.message, true);
  }
}

// ---------- 存储 ----------
function loadStorage() {
  return new Promise((resolve) => {
    chrome.storage.local.get([KEY_PLATFORMS, KEY_SETTINGS, KEY_CHECKIN_STOP_VERSION, KEY_EXPANDED_GROUPS], (res) => {
      platforms = Array.isArray(res[KEY_PLATFORMS]) ? res[KEY_PLATFORMS].map(p => ({ ...p, loading: false })) : [];
      expandedAccountGroups = new Set(Array.isArray(res[KEY_EXPANDED_GROUPS]) ? res[KEY_EXPANDED_GROUPS].filter((key) => typeof key === "string") : []);
      const storedStopVersion = validStopVersion(res[KEY_CHECKIN_STOP_VERSION]) ? res[KEY_CHECKIN_STOP_VERSION] : 0;
      checkinStopVersion = Math.max(checkinStopVersion, storedStopVersion);
       resolve(res[KEY_SETTINGS] || { autoEnabled: false, autoTime: "08:01", autoApprove: false, notify: true });
    });
  });
}
async function savePlatforms(resetState = false) {
  const stored = await new Promise((resolve) => chrome.storage.local.get(KEY_PLATFORMS, (res) => resolve(res[KEY_PLATFORMS] || [])));
  for (const next of platforms) {
    const previous = stored.find((p) => p.id === next.id);
    if (next.reauthPending && previous && previous.reauthCompletedAt && Number(previous.reauthCompletedAt) >= Number(next.reauthStartedAt || 0) &&
        next.authMode === previous.authMode && next.userId === previous.userId && next.baseUrl === previous.baseUrl) {
      for (const key of ["reauthPending", "reauthCompletedAt", "message", "error", "accountError", "stats", "statsDate", "account", "lastCheckinAt"]) next[key] = previous[key];
    }
  }
  const r = await send({ type: "savePlatforms", resetState, platforms: platforms.map(({ loading, ...p }) => p) });
  if (!r || !r.ok) throw new Error(r && r.message || "保存平台配置失败");
}

// ---------- 初始化 ----------
async function init() {
  applyTheme(preferredTheme());
  // 用事件委托绑定「检测API调用 / 选择模型」，即使后续初始化步骤出错，按钮点击仍能给出反馈
  document.addEventListener("click", (e) => {
    const t = e.target && e.target.closest ? e.target.closest("#keepAliveTestBtn, #keepAlivePickBtn") : null;
    if (!t) return;
    e.preventDefault();
    const pr = t.id === "keepAliveTestBtn" ? testKeepAlive() : pickKeepAliveModels();
    if (pr && pr.catch) {
      pr.catch((err) => {
        try { console.error("[保活] 操作异常：", err); } catch (_) {}
        try { keepAliveStatusText("操作异常：" + ((err && err.message) || String(err)), "error"); } catch (_) {}
      });
    }
  });
  document.addEventListener("click", (e) => {
    const trigger = e.target && e.target.closest ? e.target.closest("#historyBtn, #historyBtnSidebar") : null;
    if (!trigger) return;
    e.preventDefault();
    const view = globalThis.HistoryView;
    if (view && typeof view.open === "function") view.open(platforms, trigger);
  });
  // 宽屏管理页（popup.html，body 始终带 tab-mode）：隐藏「展开」按钮
  // 侧边栏（sidebar.html，body 带 sidebar-mode）：保留「展开」按钮，打开宽屏页
  if (
    new URLSearchParams(location.search).get("tab") === "1" ||
    document.body.classList.contains("tab-mode")
  ) {
    document.body.classList.add("tab-mode");
    $("openTabBtn").style.display = "none";
  }

  const settings = await loadStorage();
  await applySettings(settings);
  $("monthInput").value = currentMonth();
  render();
  renderLastAuto();

  // 事件委托：所有卡片按钮统一处理
  $("platformGrid").addEventListener("click", (e) => {
    // 站点网址：点击在浏览器新标签页打开（侧边栏里 target="_blank" 不一定生效，统一走 chrome.tabs）
    const link = e.target.closest('a[data-action="open-site"]');
    if (link) {
      const url = safeHttpUrl(link.getAttribute("href"));
      if (url) {
        e.preventDefault();
        chrome.tabs.create({ url });
      }
      return;
    }
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    const action = btn.dataset.action;
    const id = btn.dataset.id;
    if (action === "toggle-group") toggleAccountGroup(btn.dataset.group);
    else if (action === "checkin") checkin(id);
    else if (action === "stats") fetchStats(id, btn);
    else if (action === "edit") editPlatform(id);
    else if (action === "models") openModelPanel(id);
    else if (action === "delete") removePlatform(id);
  });

  $("authMode").onchange = () => { toggleAuthFields(); invalidateConnectionTest(); };
  $("visitOnly").onchange = () => { toggleAuthFields(); invalidateConnectionTest(); };
  for (const id of ["baseUrl", "userId", "accessToken", "loginUsername", "loginPassword"]) {
    $(id).addEventListener("input", invalidateConnectionTest);
  }
  if ($("keepAliveEnabled")) {
    $("keepAliveEnabled").addEventListener("change", syncKeepAliveFields);
    if ($("keepAliveFormat")) $("keepAliveFormat").addEventListener("change", onKeepAliveFormatChange);
  }
  // 不根据地址输入自动覆盖用户主动选择的鉴权方式。
  $("addBtn").onclick = () => openModal();
  $("closeBtn").onclick = () => $("modal").classList.remove("open");
  $("cancelBtn").onclick = () => $("modal").classList.remove("open");
  $("modal").onclick = (e) => {
    if (e.target === $("modal")) $("modal").classList.remove("open");
  };
  $("testBtn").onclick = () => testConnection().catch(() => {});
  $("platformForm").onsubmit = async (e) => {
    e.preventDefault();
    const data = formData();
    const submit = e.submitter;
    if (submit) submit.disabled = true;
    try {
      validatePlatform(data);
      const previousConfig = editingId && platforms.find((p) => p.id === editingId);
      const sameAccount = previousConfig && sameConnectionConfig(slim(previousConfig), slim(data));
      data.stats = sameAccount ? previousConfig.stats || {} : {};
      if (!sameAccount) data.account = null;
      if (editingId) {
        const previous = platforms.find((p) => p.id === editingId) || {};
        if (!sameConnectionConfig(slim(previous), slim(data))) {
          previous.lastVisitDate = "";
          previous.lastVisitedAt = "";
        }
        Object.assign(previous, data);
      } else {
        platforms.push({ id: crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(), ...data });
      }
      await savePlatforms();
      render();
      $("modal").classList.remove("open");
      toast("平台配置已保存（尚未验证登录），未自动检测账号；执行任务时将验证登录");
    } catch (e) {
      toast(e && e.message || "保存失败，请检查配置", true);
    } finally {
      if (submit) submit.disabled = false;
    }
  };

  $("deleteCloseBtn").onclick = closeDelete;
  $("deleteCancelBtn").onclick = closeDelete;
  $("deleteModal").onclick = (e) => {
    if (e.target === $("deleteModal")) closeDelete();
  };
  $("deleteConfirmBtn").onclick = async () => {
    if (!deletingId) return;
    platforms = platforms.filter((p) => p.id !== deletingId);
    await savePlatforms();
    render();
    closeDelete();
    toast("平台已删除");
  };

  if (hasModelPanel()) {
    const closeModel = () => {
      ++modelInsightRequest; ++modelDetailRequest;
      $("modelModal").classList.remove("open");
      modelState.detailModel = null;
      $("modelDetail").innerHTML = "";
    };
    $("modelCloseBtn").onclick = closeModel;
    $("modelModal").onclick = (e) => {
      if (e.target === $("modelModal")) closeModel();
    };
    $("modelSearch").addEventListener("input", renderModelTable);
    $("modelOnlyTraffic").onchange = renderModelTable;
    $("modelHours").onchange = () => {
      modelState.hours = Number($("modelHours").value) || 24;
      loadModelInsight();
    };
    $("modelReloadBtn").onclick = loadModelInsight;
    $("modelTableWrap").addEventListener("click", (e) => {
      const tr = e.target.closest("tr[data-model]");
      if (tr) showModelDetail(tr.dataset.model);
    });
  }

  if ($("stopCheckinBtn")) $("stopCheckinBtn").onclick = () => stopCheckin();
  $("batchBtn").onclick = async () => {
    if (!platforms.length) return toast("请先添加平台", true);
    if (activeBatchRun) return;
    const run = { id: ++batchRunSequence, stopVersion: checkinStopVersion, cancelled: false };
    activeBatchRun = run;
    $("batchBtn").disabled = true;
    try {
      run.stopVersion = await latestStopVersion();
      if (activeBatchRun !== run || run.cancelled) return;
      // 逐项等待后台全局队列完成登录、额度取数与保存，不并发发起签到。
      const outcome = await runBatch((id) => checkin(id, { batch: true, stopVersion: run.stopVersion }), run);
      if (activeBatchRun === run) toast(outcome.cancelled ? "批量签到已终止" : "批量签到完成");
    } finally {
      if (activeBatchRun === run) {
        activeBatchRun = null;
        $("batchBtn").disabled = false;
      }
    }
  };
  $("refreshBtn").onclick = refreshAll;

  $("exportBtn").onclick = exportConfig;
  $("importBtn").onclick = () => $("fileInput").click();
  $("fileInput").onchange = async (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) await importConfig(file);
    e.target.value = "";
  };

  // 「展开」：在标签页打开宽屏管理页
  $("openTabBtn").onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL("popup.html") });
  if ($("themeToggle")) $("themeToggle").onclick = toggleTheme;

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    for (const mid of ["modelModal", "modal", "deleteModal"]) {
      const el = $(mid);
      if (el && el.classList.contains("open")) { el.classList.remove("open"); break; }
    }
  });

  $("autoEnabled").onchange = saveSettings;
  $("autoTime").onchange = saveSettings;
  $("autoApprove").onchange = saveSettings;
  $("notifyEnabled").onchange = saveSettings;
  $("checkinIntervalSeconds").onchange = saveSettings;
  $("runNowBtn").onclick = async () => {
    if (activeAutoRun) return;
    const run = { id: ++autoRunSequence, stopVersion: checkinStopVersion, cancelled: false };
    activeAutoRun = run;
    $("runNowBtn").disabled = true;
    try {
      run.stopVersion = await latestStopVersion();
      if (activeAutoRun !== run || run.cancelled) return;
      const r = await send({ type: "autoRun", stopVersion: run.stopVersion });
      if (activeAutoRun !== run || run.cancelled) return;
      if (isCancelledResult(r)) {
        toast(r.message || "自动签到已终止");
        return;
      }
      if (r && r.ok && r.summary) {
        let doneMsg = "执行完成：成功 " + r.summary.ok + " / 已签 " + r.summary.already + " / 失败 " + r.summary.fail + (r.summary.pending ? " / 等待登录 " + r.summary.pending : "") + (r.summary.visited ? " / 已访问 " + r.summary.visited : ""); if (r.summary.aliveOk || r.summary.aliveFail) doneMsg += "；保活成功 " + r.summary.aliveOk + " / 失败 " + r.summary.aliveFail; toast(doneMsg);
      } else if (r && !r.ok) {
        toast(r.message || "自动签到执行失败", true);
      } else {
        toast("没有需要签到的平台", true);
      }
      // 后台/回调已同步账户信息；再次统一取数会重开刚关闭的登录页，并可能串到下一账号。
      renderLastAuto();
    } finally {
      if (activeAutoRun === run) {
        activeAutoRun = null;
        $("runNowBtn").disabled = false;
      }
    }
  };
}
// OAuth 回调由后台异步确认；侧边栏和宽屏页同步显示最终结果。
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[KEY_CHECKIN_STOP_VERSION]) {
    applyStopVersion(changes[KEY_CHECKIN_STOP_VERSION].newValue, true);
  }
  if (changes[KEY_SETTINGS]) applySettings(changes[KEY_SETTINGS].newValue);
  if (changes[KEY_EXPANDED_GROUPS]) {
    const keys = changes[KEY_EXPANDED_GROUPS].newValue;
    expandedAccountGroups = new Set(Array.isArray(keys) ? keys.filter((key) => typeof key === "string") : []);
    render();
  }
  if (!changes[KEY_PLATFORMS]) return;
  const next = changes[KEY_PLATFORMS].newValue;
  if (!Array.isArray(next)) return;
  platforms = next.map((entry) => {
    const previous = platforms.find((p) => p.id === entry.id);
    if (previous && entry.taskResultRevision !== previous.taskResultRevision) clearVisitProgress(entry.id);
    // Storage delivers a full snapshot: missing fields must disappear in every open window.
    // Keep the object identity because in-flight actions hold a reference to this account.
    if (previous) for (const key of Object.keys(previous)) if (!Object.hasOwn(entry, key)) delete previous[key];
    return Object.assign(previous || {}, entry, { loading: activeCheckins.has(entry.id) || startingCheckins.has(entry.id) });
  });
  render();
});
// 只接收本扩展后台的短期阶段提示，不将运行状态写进账号配置。
if (chrome.runtime.onMessage) chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!sender || sender.id !== chrome.runtime.id || msg.type !== "visitProgress" ||
      msg.stopVersion !== checkinStopVersion || !platforms.some((p) => p.id === msg.id)) return;
  clearVisitProgress(msg.id);
  if (msg.phase !== "done" && typeof msg.message === "string") {
    const progress = { message: msg.message, at: Date.now(), stopVersion: msg.stopVersion };
    progress.timer = setTimeout(() => {
      if (visitProgress.get(msg.id) !== progress) return;
      clearVisitProgress(msg.id);
      render();
    }, 90000);
    visitProgress.set(msg.id, progress);
  }
  render();
});
init();
