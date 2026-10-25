// ===== NewAPI 中转站一键签到 - 后台 Service Worker =====
// 原理：直接用 host 权限跨域调用目标站 /api/user/checkin，无需任何服务端代理。
//   GET  /api/user/checkin?month=YYYY-MM  -> 获取签到开关/额度上下限/本月统计
//   POST /api/user/checkin               -> 执行当日签到
//   鉴权：Authorization: Bearer <系统访问令牌/PAT>，令牌唯一标识用户。

importScripts("auth-config.js");
importScripts("account-history.js");
const AUTH_CONFIG = globalThis.NACheckinAuth;
const ACCOUNT_HISTORY = globalThis.AccountHistory;

const KEY_PLATFORMS = "nacheckin.platforms";
const KEY_SETTINGS = "nacheckin.settings";
const KEY_LASTAUTO = "nacheckin.lastAuto";
const KEY_AUTOSTATE = "nacheckin.autoState";
const KEY_AGENTROUTER_REAUTH = "nacheckin.agentRouterReauth";
const KEY_CHECKIN_STOP_VERSION = "nacheckin.checkinStopVersion";
const KEY_CHECKIN_FINISHED_AT = "nacheckin.checkinFinishedAt";
const CHECKIN_IDLE_LIMIT_MS = 60000;
const ALARM_NAME = "nacheckin.auto";
const OAUTH_ALARM_NAME = "nacheckin.oauth";
const DEFAULT_KEEPALIVE_MODEL = "deepseek v4 flash";
const KEEPALIVE_FORMATS = ["chat", "message", "response"];
const KEEPALIVE_PATHS = { chat: "/v1/chat/completions", message: "/v1/messages", response: "/v1/responses" };
let activeCheckinControl = null;
const detachedOauthControls = new Set();
let latestCheckinStopVersion = 0;
let checkinStopVersionReadyResolve;
const checkinStopVersionReady = new Promise((resolve) => { checkinStopVersionReadyResolve = resolve; });
chrome.storage.local.get(KEY_CHECKIN_STOP_VERSION, (res) => {
  latestCheckinStopVersion = normalizeStopVersion(res && res[KEY_CHECKIN_STOP_VERSION]);
  checkinStopVersionReadyResolve(latestCheckinStopVersion);
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes[KEY_CHECKIN_STOP_VERSION]) return;
  latestCheckinStopVersion = normalizeStopVersion(changes[KEY_CHECKIN_STOP_VERSION].newValue);
  const current = activeCheckinControl;
  if (current && current.stopVersion !== latestCheckinStopVersion) current.controller.abort();
  for (const control of detachedOauthControls) {
    if (control.stopVersion !== latestCheckinStopVersion) control.controller.abort();
  }
});

function broadcastCheckinPageStop(control) {
  if (!control) return;
  for (const tabId of control.pageTabIds || []) {
    const world = control.pageWorlds && control.pageWorlds.get(tabId);
    chrome.scripting.executeScript({ target: { tabId }, ...(world ? { world } : {}), func: tabCancelCheckinPage, args: [control.token] }).catch(() => {});
  }
}

function normalizeStopVersion(value) {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}
function makeCheckinError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.cancelled = code === "CHECKIN_CANCELLED";
  return error;
}
function checkinCancelledError() {
  return makeCheckinError("CHECKIN_CANCELLED", "本轮签到已停止");
}
function checkinIdleError(control = activeCheckinControl) {
  if (control && control.visitOnly) return makeCheckinError("CHECKIN_IDLE_TIMEOUT",
    "仅访问任务连续 60 秒无有效进展（未调用签到接口）" + (control.stageLabel ? "：" + control.stageLabel : "") + "；已停止任务");
  return makeCheckinError("CHECKIN_IDLE_TIMEOUT", "同一签到动作连续 60 秒无有效进展，已停止并保留页面");
}
function markCheckinProgress(control = activeCheckinControl, phase = null, realProgress = false) {
  if (!control || control.waitingToStart) return;
  const phaseChanged = phase != null && phase !== control.phase;
  if (!phaseChanged && !realProgress) return;
  control.phase = phase || control.phase;
  control.lastProgressAt = Date.now();
  if (control.idleTimer) clearTimeout(control.idleTimer);
  const arm = () => {
    const remaining = CHECKIN_IDLE_LIMIT_MS - (Date.now() - control.lastProgressAt);
    control.idleTimer = setTimeout(() => {
      if (Date.now() - control.lastProgressAt < CHECKIN_IDLE_LIMIT_MS) { arm(); return; }
      control.timedOut = true;
      control.controller.abort();
    }, Math.max(1, remaining));
  };
  arm();
}
function markCheckinIdentity(control, userId) {
  if (!control || userId == null || !/^\d+$/.test(String(userId))) return;
  const identity = String(userId);
  if (control.lastOnlineIdentity === identity) return;
  control.lastOnlineIdentity = identity;
  markCheckinProgress(control, "online-identity:" + identity, true);
}
function markCheckinQuota(control, account) {
  if (!control || !account || account.available == null || account.quotaPerUnit == null) return;
  const key = [account.available, account.used, account.quotaPerUnit].join("|");
  if (control.lastQuotaKey === undefined) {
    control.lastQuotaKey = key;
    markCheckinProgress(control, "quota-first-valid", true);
    return;
  }
  if (control.lastQuotaKey === key) return;
  control.lastQuotaKey = key;
  markCheckinProgress(control, "quota-change", true);
}
function isCheckinControlError(error) {
  return !!error && (error.code === "CHECKIN_CANCELLED" || error.code === "CHECKIN_IDLE_TIMEOUT");
}
function assertCheckinActive(control = activeCheckinControl) {
  if (!control) return;
  if (!control.waitingToStart && (control.timedOut || Date.now() - control.lastProgressAt >= CHECKIN_IDLE_LIMIT_MS)) {
    control.timedOut = true;
    control.controller.abort();
    throw checkinIdleError(control);
  }
  if (control.controller.signal.aborted || control.stopVersion !== latestCheckinStopVersion) {
    control.controller.abort();
    throw checkinCancelledError();
  }
}
function finishCheckinControl(control) {
  if (control && control.idleTimer) clearTimeout(control.idleTimer);
  if (control && control.abortListener) control.controller.signal.removeEventListener("abort", control.abortListener);
  if (activeCheckinControl === control) activeCheckinControl = null;
}
async function checkinFetch(input, init = {}, control = null) {
  assertCheckinActive(control);
  const options = { ...init };
  if (control) options.signal = control.controller.signal;
  try {
    const response = await fetch(input, options);
    assertCheckinActive(control);
    return response;
  } catch (error) {
    assertCheckinActive(control);
    throw error;
  }
}
function awaitReadOrStop(promise, control) {
  if (!control) return promise;
  return new Promise((resolve, reject) => {
    const signal = control.controller.signal;
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", stopped);
      fn(value);
    };
    const stopped = () => { try { assertCheckinActive(control); } catch (error) { finish(reject, error); } };
    signal.addEventListener("abort", stopped, { once: true });
    if (signal.aborted) stopped();
    Promise.resolve(promise).then((value) => finish(resolve, value), (error) => finish(reject, error));
  });
}
async function withLogReadBudget(read, parent, milliseconds) {
  assertCheckinActive(parent);
  if (milliseconds <= 0) throw makeCheckinError("ACCOUNT_LOG_TIMEOUT", "本月 Token 统计达到 20 秒预算");
  const control = { stopVersion: parent ? parent.stopVersion : latestCheckinStopVersion,
    token: (parent ? parent.token : "account") + "-log-" + Math.random().toString(36).slice(2),
    controller: new AbortController(), waitingToStart: true, pageTabIds: new Set(), pageWorlds: new Map() };
  const stop = () => control.controller.abort();
  control.controller.signal.addEventListener("abort", () => broadcastCheckinPageStop(control), { once: true });
  if (parent) parent.controller.signal.addEventListener("abort", stop, { once: true });
  let expired = false;
  const timer = setTimeout(() => { expired = true; stop(); }, milliseconds);
  try {
    return await awaitReadOrStop(Promise.resolve().then(() => { assertCheckinActive(parent); return read(control); }), control);
  } catch (error) {
    assertCheckinActive(parent); // 用户停止/主任务超时不能降级成日志警告。
    if (expired) throw makeCheckinError("ACCOUNT_LOG_TIMEOUT", "本月 Token 统计超时，已保留余额");
    throw error;
  } finally {
    clearTimeout(timer);
    if (parent) parent.controller.signal.removeEventListener("abort", stop);
  }
}

// Account reads support both legacy Cookie sessions and modern refresh-cookie/Bearer sessions.
// Only retry read-only account endpoints; never replay check-in, login or OAuth writes.
async function executeCheckinScript(spec, control = null) {
  if (spec.func === tabLogout) {
    const page = await chrome.tabs.get(spec.target.tabId);
    const origin = (spec.args && spec.args[1]) || new URL(page.url).origin;
    const key = sessionTokenKey(origin, "tab:" + spec.target.tabId);
    const bearer = readSessionToken(key);
    const args = [...(spec.args || [])];
    args[1] = origin;
    if (bearer) { args[2] = bearer; args[3] = sessionTokenCache.get(key).sessionId || ""; }
    try {
      let out = await executeCheckinScriptRaw({ ...spec, args }, control);
      const result = out && out[0] && out[0].result;
      if (!bearer && result && [404, 405].includes(result.status)) {
        const got = await acquireSessionToken(spec.target.tabId, key, "", control, origin);
        if (got.ok) {
          args[2] = got.token; args[3] = sessionTokenCache.get(key).sessionId || "";
          out = await executeCheckinScriptRaw({ ...spec, args }, control);
        } else if (got.status === 401 && !got.htmlResponse) {
          // The modern refresh endpoint confirms there is no live session to log out.
          // An absent legacy endpoint must not prevent a subsequent fresh login.
          out = [{ result: { ok: true, alreadyLoggedOut: true, status: 401 } }];
        }
      }
      return out;
    } finally { clearSiteSessionTokens(origin); }
  }
  const first = await executeCheckinScriptRaw(spec, control);
  const response = first && first[0] && first[0].result;
  if (spec.func !== tabFetchCheckin || !isAccountReadRequest(spec.args[0], spec.args[1]) ||
      !response || response.status !== 401 || response.htmlResponse) return first;
  const page = await chrome.tabs.get(spec.target.tabId);
  const origin = spec.args[7] || new URL(page.url).origin;
  if (new URL(page.url).origin !== origin) throw new Error("账户页面已跳转到其他站点，已停止取数");
  const key = sessionTokenKey(origin, "tab:" + spec.target.tabId);
  const read = (bearer) => {
    const args = [...spec.args]; args[7] = origin; args[8] = bearer;
    return executeCheckinScriptRaw({ ...spec, args }, control);
  };
  const cached = readSessionToken(key);
  if (cached) {
    const out = await read(cached);
    if (!out[0] || !out[0].result || out[0].result.status !== 401) return out;
  }
  const got = await acquireSessionToken(spec.target.tabId, key, cached, control, origin);
  assertCheckinActive(control);
  if (got.ok) return await read(got.token);
  // Old kernels have no refresh endpoint. A real expired refresh session still needs login.
  if (got.timedOut) return [{ result: { ...response, timedOut: true } }];
  if (!got.htmlResponse && [401, 404, 405].includes(got.status)) {
    if (got.status === 401 && got.message) response.body = { success: false, message: got.message };
    return first;
  }
  return [{ result: { ok: false, status: got.status || 0, htmlResponse: got.htmlResponse,
    body: { success: false, message: got.message || "会话认证失败" } } }];
}

async function executeCheckinScriptRaw(spec, control = null) {
  assertCheckinActive(control);
  const injection = { ...spec };
  if (control) {
    const args = [...(spec.args || [])];
    const name = spec.func && spec.func.name;
    if (name === "tabFetchCheckin") args[6] = control.token;
    else if (name === "tabRefreshAuthToken") args[1] = control.token;
    else if (name === "tabFetchAgentRouterAccount") args[2] = control.token;
    else if (name === "tabBuildAgentRouterOauthUrl") args[2] = control.token;
    else if (name === "tabClickLinuxDoApprove") args[2] = control.token;
    else if (name === "tabSubmitPasswordLogin") args[3] = control.token;
    else if (name === "tabLogout") args[0] = control.token;
    else if (name === "tabDismissSiteNotice") args[1] = control.token;
    else if (name === "tabFetchTurnstileCheckin") args[2] = control.token;
    injection.args = args;
    if (spec.target && spec.target.tabId != null) {
      control.pageTabIds.add(spec.target.tabId);
      control.pageWorlds.set(spec.target.tabId, spec.world || "ISOLATED");
    }
  }
  // Chrome 的注入参数不接受 undefined 或稀疏数组。追加取消令牌/站点地址
  // 可能跳过可选参数，用 null 补齐空位，不移动已有参数或吞掉其他非法值。
  if (Array.isArray(injection.args)) {
    injection.args = Array.from(injection.args, (value) => value === undefined ? null : value);
  }
  let result;
  try {
    const pending = chrome.scripting.executeScript(injection);
    // 只读请求可以立即退出等待；写操作仍等待原调用返回，避免放行后重复提交。
    result = (spec.func === tabRefreshAuthToken || (spec.func === tabFetchCheckin && String(spec.args[1]).toUpperCase() === "GET"))
      ? await awaitReadOrStop(pending, control) : await pending;
  }
  finally {
    if (control && spec.target && spec.target.tabId != null) {
      control.pageTabIds.delete(spec.target.tabId);
      control.pageWorlds.delete(spec.target.tabId);
    }
  }
  // executeScript itself cannot be aborted; injected request/wait bodies listen for stop,
  // and their returned values are checked before any follow-up click, navigation or write.
  assertCheckinActive(control);
  return result;
}
// 只处理目标站点的公告专用按钮，绝不按泛化的“关闭/允许”文本点击。
async function dismissSiteNotice(tabId, base, control = null, observeLate = true) {
  assertCheckinActive(control);
  const origin = new URL(base).origin;
  const page = await chrome.tabs.get(tabId);
  if (!page.url || new URL(page.url).origin !== origin) throw new Error("公告检查页面已跳转到其他站点");
  if (page.status && page.status !== "complete") await waitTabComplete(tabId, control);
  const out = await executeCheckinScript({ target: { tabId }, func: tabDismissSiteNotice,
    args: [origin, control && control.token || "", observeLate] }, control);
  const result = out && out[0] && out[0].result;
  if (result && result.cancelled) throw checkinCancelledError();
  if (!result || result.ok !== true) throw new Error(result && result.message || "站点公告未能关闭，请手动关闭后重试");
}
function tabDismissSiteNotice(expectedOrigin, operationToken = "", observeLate = true) {
  if (location.origin !== expectedOrigin) return { ok: false, message: "公告检查页面不属于目标站点" };
  const token = String(operationToken || "");
  const cancelled = () => !!token && window.__nacheckinCancelledCheckinToken === token;
  if (cancelled()) return { ok: false, cancelled: true };
  const visible = (node) => {
    if (!node || !node.isConnected || !node.getClientRects().length) return false;
    const style = getComputedStyle(node);
    return style.display !== "none" && style.visibility !== "hidden" && style.visibility !== "collapse" && style.opacity !== "0";
  };
  const usable = (node) => visible(node) && !node.disabled && node.getAttribute("aria-disabled") !== "true";
  const find = () => {
    for (const id of ["notice-dialog-close-today", "notice-dialog-close"]) {
      const node = Array.from(document.querySelectorAll('button[data-testid="' + id + '"]')).find(usable);
      if (node) return node;
    }
    return null;
  };
  // 登录/导航边界观察 SPA 挂载；连续只读取数仅检查当前公告，不每页重复空等。
  // 不缓存“没有公告”，下一次调用仍会检查新出现的公告。
  if (!observeLate && !find()) return { ok: true, dismissed: false };
  return new Promise((resolve) => {
    let observer, timer, closed = false, clicked = null, dialog = null;
    const finish = (result) => {
      if (closed) return;
      closed = true;
      if (observer) observer.disconnect();
      clearTimeout(timer);
      window.removeEventListener("nacheckin:checkin-stop", onStop);
      resolve(result);
    };
    const onStop = (event) => {
      if (token && String(event.detail || "") === token) finish({ ok: false, cancelled: true });
    };
    const check = () => {
      if (closed) return;
      if (cancelled()) { finish({ ok: false, cancelled: true }); return; }
      if (location.origin !== expectedOrigin) { finish({ ok: false, message: "公告检查期间页面已跳转" }); return; }
      if (clicked) {
        if (!visible(dialog || clicked)) finish({ ok: true, dismissed: true });
        return;
      }
      const button = find();
      if (!button) return;
      clicked = button;
      dialog = button.closest('[role="dialog"], [data-slot="dialog-content"], .semi-modal-content');
      // 点击之后另给弹窗最多 1.2 秒卸载/动画时间，不重复提交同一个按钮。
      clearTimeout(timer);
      timer = setTimeout(() => {
        check();
        if (!closed) finish({ ok: false, message: "站点公告仍未关闭，请手动关闭后重试" });
      }, 1200);
      try { button.click(); } catch { finish({ ok: false, message: "无法点击站点公告关闭按钮" }); return; }
      if (!visible(dialog || clicked)) finish({ ok: true, dismissed: true });
    };
    window.addEventListener("nacheckin:checkin-stop", onStop);
    observer = new MutationObserver(check);
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    timer = setTimeout(() => {
      check();
      if (!closed && !clicked) finish({ ok: true, dismissed: false });
    }, 1200);
    check();
  });
}
function tabCancelCheckinPage(token) {
  try { window.__nacheckinCancelledCheckinToken = String(token || ""); } catch {}
  try { window.dispatchEvent(new CustomEvent("nacheckin:checkin-stop", { detail: String(token || "") })); } catch {}
  return { ok: true };
}
const wait = (ms, control = null) => {
  if (!control) return new Promise((resolve) => setTimeout(resolve, ms));
  assertCheckinActive(control);
  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => control.controller.signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      clearTimeout(timer); cleanup();
      try { assertCheckinActive(control); reject(checkinCancelledError()); } catch (error) { reject(error); }
    };
    timer = setTimeout(() => { cleanup(); try { assertCheckinActive(control); resolve(); } catch (error) { reject(error); } }, ms);
    control.controller.signal.addEventListener("abort", onAbort, { once: true });
  });
};

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
// 独立串行化 read-modify-write，防止并发额度刷新互相覆盖历史；历史故障不阻断业务。
let accountHistoryWriteQueue = Promise.resolve();
function enqueueAccountHistoryWrite(action) {
  const operation = accountHistoryWriteQueue.catch(() => {}).then(async () => {
    try { return await action(); }
    catch { return false; }
  });
  accountHistoryWriteQueue = operation.then(() => undefined, () => undefined);
  return operation;
}
function readAccountHistory() {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(ACCOUNT_HISTORY.STORAGE_KEY, (result) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message || "无法读取本地账户历史"));
      else resolve(result && result[ACCOUNT_HISTORY.STORAGE_KEY] != null ? result[ACCOUNT_HISTORY.STORAGE_KEY] : null);
    });
  });
}
function clearAccountHistoryEntries(platformIds) {
  if (!ACCOUNT_HISTORY) return Promise.resolve(false);
  const ids = new Set((platformIds || []).map((id) => String(id)));
  if (!ids.size) return Promise.resolve(true);
  return enqueueAccountHistoryWrite(async () => {
    const current = await readAccountHistory();
    if (!current) return true;
    const now = Date.now();
    const history = ACCOUNT_HISTORY.sanitizeHistory(current, now);
    let changed = false;
    for (const id of ids) {
      if (Object.prototype.hasOwnProperty.call(history.accounts, id)) {
        delete history.accounts[id];
        changed = true;
      }
    }
    if (!changed) return true;
    if (!Object.keys(history.accounts).length) history.startedAt = now;
    await setStore({ [ACCOUNT_HISTORY.STORAGE_KEY]: history });
    return true;
  });
}
function recordAccountHistorySample(platform, account, month) {
  return enqueueAccountHistoryWrite(async () => {
    if (!ACCOUNT_HISTORY || !platform || platform.id == null || !account) return false;
    const currentPlatforms = await getPlatforms();
    const currentPlatform = currentPlatforms.find((entry) => String(entry.id) === String(platform.id));
    // A result from a task that finished after its config changed/was deleted is stale.
    if (!currentPlatform || !sameHistoryTaskConfig(currentPlatform, platform)) return false;
    const now = Date.now();
    const identity = ACCOUNT_HISTORY.identityFor({
      ...platform,
      // Use this online response, not a potentially stale cached platform.account snapshot.
      account,
    });
    const sample = ACCOUNT_HISTORY.createSample(account, month, now);
    if (!identity || !sample) return false;
    const current = await readAccountHistory();
    const next = ACCOUNT_HISTORY.appendSample(current, String(platform.id), identity, sample, now);
    await setStore({ [ACCOUNT_HISTORY.STORAGE_KEY]: next });
    return true;
  });
}
const getPlatforms = () => getStore(KEY_PLATFORMS, []);
// 旧的批量/页面快照不能覆盖刚确认的 OAuth 结果。
function preserveCompletedReauth(next, stored) {
  if (!stored || !next.reauthPending || !stored.reauthCompletedAt ||
      Number(stored.reauthCompletedAt) < Number(next.reauthStartedAt || 0) || next.authMode !== stored.authMode ||
      String(next.userId || "") !== String(stored.userId || "") || next.baseUrl !== stored.baseUrl) return next;
  return { ...next, reauthPending: false, reauthCompletedAt: stored.reauthCompletedAt,
    reauthCheckedIn: stored.reauthCheckedIn, reauthAccountUpdated: stored.reauthAccountUpdated, message: stored.message,
    error: stored.error, accountError: stored.accountError || "", stats: stored.stats, statsDate: stored.statsDate, account: stored.account, lastCheckinAt: stored.lastCheckinAt };
}
const PLATFORM_STATE_FIELDS = ["message", "error", "accountError", "account", "stats", "statsDate", "enabled",
  "lastVisitDate", "lastVisitedAt", "lastCheckinAt", "reauthPending", "reauthStartedAt", "reauthCompletedAt",
  "reauthCheckedIn", "reauthAccountUpdated", "taskResultRevision"];
const stateRevision = (p) => Number.isSafeInteger(p && p.stateRevision) && p.stateRevision >= 0 ? p.stateRevision : 0;
const platformState = (p) => JSON.stringify([PLATFORM_STATE_FIELDS.map(key => p[key]), p.keepAlive && p.keepAlive.lastDate]);
function preserveNewerPlatformState(next, stored) {
  if (!stored || !sameTaskConfig(next, stored) || stateRevision(next) >= stateRevision(stored)) return preserveCompletedReauth(next, stored);
  const merged = { ...next, stateRevision: stored.stateRevision };
  for (const key of PLATFORM_STATE_FIELDS) {
    if (Object.hasOwn(stored, key)) merged[key] = stored[key]; else delete merged[key];
  }
  if (merged.keepAlive && stored.keepAlive) merged.keepAlive = { ...merged.keepAlive, lastDate: stored.keepAlive.lastDate };
  return merged;
}
let platformWriteQueue = Promise.resolve();
function mutatePlatforms(fn) {
  const update = platformWriteQueue.then(async () => {
    const current = await getPlatforms();
    const before = new Map(current.map(p => [p.id, { state: platformState(p), revision: stateRevision(p) }]));
    const next = await fn(current);
    for (const p of next) {
      const previous = before.get(p.id);
      const revision = previous ? previous.revision : 0;
      if (!previous || previous.state !== platformState(p)) p.stateRevision = revision + 1;
      else if (revision) p.stateRevision = revision;
    }
    await setStore({ [KEY_PLATFORMS]: next });
  });
  platformWriteQueue = update.catch(() => {});
  return update;
}
async function savePlatforms(list, resetState = false) {
  const historyIdsToClear = new Set();
  await mutatePlatforms((current) => {
    const next = list.map(({ loading, ...p }) => p);
    const nextById = new Map(next.map((p) => [String(p.id), p]));
    if (resetState) {
      for (const p of current) historyIdsToClear.add(String(p.id));
      for (const p of next) historyIdsToClear.add(String(p.id));
    } else {
      for (const previous of current) {
        const key = String(previous.id);
        const replacement = nextById.get(key);
        if (!replacement || !sameHistoryTaskConfig(replacement, previous)) historyIdsToClear.add(key);
      }
    }
    return next.map((p) => resetState ? p : preserveNewerPlatformState(p, current.find((x) => x.id === p.id)));
  });
  // Config is committed first. The shared history queue ensures an in-flight old sample
  // finishes before this cleanup, while later samples see the new/missing config above.
  await clearAccountHistoryEntries([...historyIdsToClear]);
}
function normalizeSettings(s) {
  return { autoEnabled: false, autoTime: "08:01", autoApprove: false, notify: true,
    ...(s || {}), checkinIntervalSeconds: AUTH_CONFIG.normalizeCheckinInterval(s && s.checkinIntervalSeconds) };
}
const getSettings = async () => normalizeSettings(await getStore(KEY_SETTINGS, {}));
const saveSettings = (s) => setStore({ [KEY_SETTINGS]: normalizeSettings(s) });

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
  if (!a || !b || isVisitOnly(a) !== isVisitOnly(b)) return false;
  const mode = a.authMode || "token";
  if (mode !== (b.authMode || "token") ||
      String(a.baseUrl || "").trim().replace(/\/+$/, "") !== String(b.baseUrl || "").trim().replace(/\/+$/, "") ||
      String(a.userId || "").trim() !== String(b.userId || "").trim()) return false;
  // 表单保存空密码字段，非密码消息会省略它们；不能因此误判 OAuth 配置变化。
  if (mode === "password") return String(a.loginUsername || "").trim() === String(b.loginUsername || "").trim() &&
    a.loginPassword === b.loginPassword;
  if (mode === "token") return String(a.accessToken || "").trim() === String(b.accessToken || "").trim();
  return true;
}
function historyIdentityBase(platform) {
  const raw = String(platform && platform.baseUrl || "").trim();
  if (!raw || !ACCOUNT_HISTORY) return raw;
  // Use a fixed valid ID to ask the shared identity normalizer for only the site prefix.
  const identity = ACCOUNT_HISTORY.identityFor({ ...platform, id: "history-config-check", userId: "0", account: null });
  const suffix = "|user:0";
  return typeof identity === "string" && identity.endsWith(suffix) ? identity.slice(0, -suffix.length) : raw;
}
function sameHistoryTaskConfig(a, b) {
  if (!a || !b) return false;
  return sameTaskConfig(
    { ...a, baseUrl: historyIdentityBase(a) },
    { ...b, baseUrl: historyIdentityBase(b) },
  );
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
  const id = body && body.data ? body.data.id : null;
  const actual = (typeof id === "number" || typeof id === "string") && /^\d+$/.test(String(id).trim()) ? String(id).trim() : "";
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
function samePendingGeneration(current, expected) {
  if (!current || !expected) return false;
  if (expected.createdAt != null && Number(current.createdAt) !== Number(expected.createdAt)) return false;
  if (expected.stopVersion != null && Number(current.stopVersion) !== Number(expected.stopVersion)) return false;
  if (expected.token != null && current.token !== expected.token) return false;
  return true;
}
function updateAgentRouterPending(tabId, pending, expectedTask = null, allowCreate = false) {
  const update = agentRouterPendingWrite.then(async () => {
    await checkinStopVersionReady;
    if (pending && pending.stopVersion != null && normalizeStopVersion(pending.stopVersion) !== latestCheckinStopVersion) return false;
    const all = await getAgentRouterPending();
    const current = all[tabId];
    if (expectedTask && !samePendingGeneration(current, expectedTask)) return false;
    if (pending) {
      if (!current && !allowCreate) return false;
      if (current && !samePendingGeneration(current, pending)) return false;
      if (pending.stopVersion != null) {
        const storedVersion = normalizeStopVersion(await getStore(KEY_CHECKIN_STOP_VERSION, latestCheckinStopVersion));
        latestCheckinStopVersion = storedVersion;
        if (normalizeStopVersion(pending.stopVersion) !== storedVersion) return false;
      }
      all[tabId] = { ...(current || {}), ...pending };
    } else {
      if (!current || (expectedTask && !samePendingGeneration(current, expectedTask))) return false;
      delete all[tabId];
    }
    await setStore({ [KEY_AGENTROUTER_REAUTH]: all });
    if (Object.keys(all).length) chrome.alarms.create(OAUTH_ALARM_NAME, { periodInMinutes: 1 });
    else await chrome.alarms.clear(OAUTH_ALARM_NAME);
    return true;
  });
  agentRouterPendingWrite = update.catch(() => {});
  return update;
}
function patchAgentRouterPending(pending, patch) {
  return updateAgentRouterPending(pending.tabId, {
    ...patch, createdAt: pending.createdAt, stopVersion: pending.stopVersion, token: pending.token,
  }, pending);
}
async function acceptedCheckinStopVersion(requested) {
  await checkinStopVersionReady;
  const stored = normalizeStopVersion(await getStore(KEY_CHECKIN_STOP_VERSION, latestCheckinStopVersion));
  latestCheckinStopVersion = stored;
  if (requested !== undefined && requested !== null &&
      (typeof requested !== "number" || !Number.isSafeInteger(requested) || requested !== stored)) throw checkinCancelledError();
  return stored;
}
function errorResponse(error, fallback) {
  if (error && error.code === "CHECKIN_CANCELLED") return { ok: false, cancelled: true, pending: false, reauthRequired: false, outcome: "fail", code: "CHECKIN_CANCELLED", message: error.message || "本轮签到已停止" };
  if (error && error.code === "CHECKIN_IDLE_TIMEOUT") return { ok: false, cancelled: false, pending: false, reauthRequired: false, outcome: "fail", code: "CHECKIN_IDLE_TIMEOUT", message: error.message || "同一签到动作连续 60 秒无有效进展，已停止并保留页面" };
  return { ok: false, message: error && error.message ? error.message : fallback };
}
let stopCheckinQueue = Promise.resolve();
function stopCheckinNow() {
  const task = stopCheckinQueue.catch(() => {}).then(async () => {
    await checkinStopVersionReady;
    const stored = normalizeStopVersion(await getStore(KEY_CHECKIN_STOP_VERSION, latestCheckinStopVersion));
    const stopVersion = Math.min(Number.MAX_SAFE_INTEGER, Math.max(stored, latestCheckinStopVersion) + 1);
    latestCheckinStopVersion = stopVersion;
    // 在存储 await 前取消旧代控制；写完后新代任务可能已启动，不能无条件误停它。
    const controls = [activeCheckinControl, ...detachedOauthControls];
    for (const control of controls) {
      if (control && control.stopVersion !== stopVersion) control.controller.abort();
    }
    await setStore({ [KEY_CHECKIN_STOP_VERSION]: stopVersion });
    // 清理异步进行；停止响应不等待 OAuth 页面读取/注入，页面本身始终保留。
    cleanupStoppedOauthTasks(stopVersion).catch(() => {});
    return { ok: true, cancelled: true, stopVersion, message: "已停止当前签到并取消排队任务；已发出的请求无法撤回" };
  });
  stopCheckinQueue = task.catch(() => {});
  return task;
}
async function cleanupStoppedOauthTasks(stopVersion) {
  const pending = await getAgentRouterPending();
  for (const item of Object.values(pending)) {
    if (item.stopVersion != null && Number(item.stopVersion) >= stopVersion) continue;
    await updateAgentRouterPending(item.tabId, null, item);
    if (item.visitOnly) continue;
    await mutatePlatforms(async (list) => {
      if (stopVersion !== latestCheckinStopVersion) return list;
      const p = list.find((entry) => entry.id === item.platformId && Number(entry.reauthStartedAt) === Number(item.createdAt));
      if (p) {
        p.reauthPending = false;
        p.message = "本轮签到已停止";
        p.error = "本轮签到已停止";
        // 不修改 stats/account/lastCheckinAt：保留此前已确认结果。
      }
      return list;
    });
  }
}
async function isAgentRouterReauthPending(p) {
  if (!isAgentRouterReauthMode(p)) return false;
  const all = await getAgentRouterPending();
  const origin = new URL(p.baseUrl).origin;
  return Object.values(all).some((pending) => pending.origin === origin && Date.now() - Number(pending.lastProgressAt || pending.createdAt || 0) < CHECKIN_IDLE_LIMIT_MS);
}

// 同一个站点只有一个网页登录会话；不同账号/提供方必须等上一轮回调处理结束再切换。
function sameOauthTask(pending, platform) {
  return (!pending.platformId || pending.platformId === platform.id) &&
    (!pending.authMode || pending.authMode === platform.authMode) &&
    pending.provider === agentRouterProvider(platform) &&
    String(pending.userId || "").trim() === String(platform.userId || "").trim() &&
    !!pending.visitOnly === isVisitOnly(platform);
}
async function waitForAgentRouterTurn(platform, reuse = false, control = null) {
  const origin = new URL(platform.baseUrl).origin;
  while (true) {
    assertCheckinActive(control);
    const pending = Object.values(await getAgentRouterPending()).find((item) => item.origin === origin);
    if (!pending) return null;
    const tab = await chrome.tabs.get(pending.tabId).catch(() => null);
    const idleSince = Number(pending.lastProgressAt || pending.createdAt || Date.now());
    if (!tab || Date.now() - idleSince >= CHECKIN_IDLE_LIMIT_MS) {
      const message = tab ? "登录等待同一阶段连续 60 秒无有效进展，请重新执行" : "登录页已关闭，请重新执行";
      await saveAgentRouterLoginOutcome(pending, null, message);
      await updateAgentRouterPending(pending.tabId, null, pending);
      continue;
    }
    if (reuse && sameOauthTask(pending, platform)) return pending;
    await wait(Math.min(1200, Math.max(1, CHECKIN_IDLE_LIMIT_MS - (Date.now() - idleSince))), control);
  }
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
  const control = opts && opts.control;
  assertCheckinActive(control);
  await assertApiAllowed(p);
  validatePlatform(p);
  const base = (p.baseUrl || "").trim().replace(/\/+$/, "");
  if (isAgentRouterReauthMode(p)) {
    if (opts && opts.reauth) return await runAgentRouterOauthCheckin(p, base, control);
    const account = await callAgentRouterAccountViaTab(p, base, false, control);
    if (account.warning) account.body._accountWarn = account.warning;
    return account.body;
  }
  if (p.authMode === "password") {
    const user = await ensurePasswordSession(p, !!(opts && opts.reauth && isSelfTriggerMode(p)), control);
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
    res = await checkinFetch(url.toString(), init, control);
  } catch (e) {
    if (isCheckinControlError(e)) throw e;
    throw new Error("网络请求失败：" + (e && e.message ? e.message : "无法连接站点"));
  }
  let body;
  try {
    body = await res.json();
    assertCheckinActive(control);
  } catch (e) {
    if (isCheckinControlError(e)) throw e;
    assertCheckinActive(control);
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

async function callAgentRouterAccountViaTab(p, base, strict = false, control = null) {
  const { tab, createdTabId } = await getAgentRouterPage(base);
  let result = null;
  try {
    await dismissSiteNotice(tab.id, base, control);
    const out = await executeCheckinScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: tabFetchAgentRouterAccount,
      args: [String(p.userId || "").trim(), strict],
    }, control);
    result = out && out[0] && out[0].result;
  } catch (e) {
    if (isCheckinControlError(e)) throw e;
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
  if (result && ([401, 403].includes(result.status) || result.htmlResponse || result.invalidIdentity)) error.code = "AUTH_NOT_LOGGED_IN";
  throw error;
}

// Agent Router 的当前前端在 OAuth/密码登录响应中通过 data.checked_in 返回签到结果。
// 正确流程是退出当前 Cookie 会话后重新登录，不需要预先用访问令牌请求 /api/user/self。
async function runAgentRouterOauthCheckin(p, base, control = null) {
  const origin = new URL(base).origin;
  if (visitOnlyOrigins.has(origin) || passwordLoginInflight.has(origin) || agentRouterStarting.has(origin)) throw new Error("本站有其他登录任务正在启动，请稍后重试");
  agentRouterStarting.add(origin); // 在首次 await 前预留，防止两种提供方同时启动。
  try {
    const old = await waitForAgentRouterTurn(p, true, control);
    if (old) {
      await chrome.tabs.update(old.tabId, { active: true }).catch(() => {});
      return { success: true, message: "正在等待 " + agentRouterProviderLabel(old.provider) + " 登录完成", _reauthRequired: true, _reauthStartedAt: old.createdAt, _reauthTabId: old.tabId, _oauthLoginStarted: old.oauthStarted, _githubLoginStarted: old.provider === "github" && old.oauthStarted };
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
    const reauthTab = await startAgentRouterReauth(base, p, control);
    if (!reauthTab) throw new Error("Agent Router 登录页启动失败");
    return {
      success: true,
      message: "已打开 " + agentRouterProviderLabel(agentRouterProvider(p)) + " 登录页，等待登录回调确认签到",
      data: { id: configured || null },
      _reauthRequired: true,
      _reauthStartedAt: reauthTab.createdAt,
      _reauthTabId: reauthTab.id,
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
function waitTabComplete(tabId, control = null) {
  return waitVisitComplete(tabId, null, control, 12000);
}

// 内容脚本内同源 fetch（自动携带站点登录 Cookie；MV3 无法在 SW 直接设 Cookie 头）
// 站点内的同源请求（自动携带登录 Cookie；含浏览器伪装头，绕过部分站点 UA/Referer 校验）
// args: [reqPath, method, month, userId, apiUserKey]
function tabFetchCheckin(reqPath, method, month, userId, apiUserKey, query, checkinToken = "", expectedOrigin = "", bearer = "") {
  return (async () => {
    // 后台检查与注入之间仍可能导航；在实际执行的文档内再次锁定目标站点。
    if (expectedOrigin && location.origin !== expectedOrigin) return { ok: false, status: 0, body: { success: false, message: "账户页面已跳转到其他站点，已停止取数" } };
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
    if (bearer) headers.Authorization = "Bearer " + bearer;
    if (checkinToken && window.__nacheckinCancelledCheckinToken === String(checkinToken)) {
      return { ok: false, status: 0, cancelled: true, body: { success: false, message: "本轮签到已停止" } };
    }
    const controller = new AbortController();
    let stopped = false;
    const onStop = (event) => {
      if (checkinToken && event && event.detail === String(checkinToken)) { stopped = true; controller.abort(); }
    };
    const abortResult = () => {
      const cancelled = stopped || !!(checkinToken && window.__nacheckinCancelledCheckinToken === String(checkinToken));
      return { ok: false, status: 0, cancelled, timedOut: !cancelled,
        body: { success: false, message: cancelled ? "本轮签到已停止" : "账户请求超时，请稍后重试" } };
    };
    window.addEventListener("nacheckin:checkin-stop", onStop);
    const requestLimit = (method || "GET").toUpperCase() === "GET" ? 12000 : 60000;
    const requestTimer = setTimeout(() => controller.abort(), requestLimit);
    let res, text;
    try {
      res = await fetch(url.toString(), { method, headers, credentials: "include", mode: "same-origin", signal: controller.signal });
      if (controller.signal.aborted || (checkinToken && window.__nacheckinCancelledCheckinToken === String(checkinToken))) return abortResult();
      const contentType = String(res.headers.get("content-type") || "").toLowerCase();
      text = await res.text();
      if (controller.signal.aborted) return abortResult();
      // Preserve content type below while keeping timeout active through response-body reading.
      return { ok: res.ok, status: res.status, body: parseResponseBody(text, contentType), htmlResponse: isHtmlResponse(text, contentType) };
    } catch (e) {
      if (controller.signal.aborted) return abortResult();
      return { ok: false, status: 0, body: { success: false, message: "网络请求失败：" + (e && e.message ? e.message : "无法连接站点") } };
    } finally {
      clearTimeout(requestTimer);
      window.removeEventListener("nacheckin:checkin-stop", onStop);
    }
    function parseResponseBody(responseText, type) {
      let parsed = null;
      try { parsed = responseText ? JSON.parse(responseText) : null; } catch {}
      const html = isHtmlResponse(responseText, type);
      if (!parsed && html) parsed = { success: false, message: "登录会话已失效或站点触发了安全验证，请打开目标站点重新登录或完成验证后重试" };
      else if (!parsed) parsed = { success: false, message: responseText ? "站点返回了非 JSON 数据，请稍后重试" : "站点返回了空响应，请稍后重试" };
      return parsed;
    }
    function isHtmlResponse(responseText, type) {
      return type.includes("text/html") || /^\s*<!doctype\s+html|^\s*<html[\s>]/i.test(responseText);
    }
  })();
}

function tabReadAgentRouterStoredUser() {
  try {
    const user = JSON.parse(localStorage.getItem("user") || "null");
    if (!user || !["number", "string"].includes(typeof user.id) || !/^\d+$/.test(String(user.id))) return null;
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
function tabFetchAgentRouterAccount(configuredUserId, strict = false, checkinToken = "") {
  const readStoredUser = () => {
    try {
      const user = JSON.parse(localStorage.getItem("user") || "null");
      if (!user || !["number", "string"].includes(typeof user.id) || !/^\d+$/.test(String(user.id))) return null;
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
        quota_per_unit: user.quota_per_unit ?? user.quotaPerUnit ?? localStorage.getItem("quota_per_unit"),
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
      let xhr, stopped = false;
      const onStop = (event) => { if (checkinToken && event && event.detail === String(checkinToken)) { stopped = true; try { xhr.abort(); } catch {} } };
      if (checkinToken) window.addEventListener("nacheckin:checkin-stop", onStop);
      const done = (result) => { if (checkinToken) window.removeEventListener("nacheckin:checkin-stop", onStop); resolveRequest(result); };
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
        done({ ok: false, message: e && e.message ? e.message : "无法创建账户请求" });
        return;
      }

      xhr.onload = () => {
        const text = String(xhr.responseText || "");
        const contentType = String(xhr.getResponseHeader("content-type") || "").toLowerCase();
        let body = null;
        try { body = text ? JSON.parse(text) : null; } catch {}
        if (xhr.status >= 200 && xhr.status < 300 && body && body.success !== false && body.data) {
          done({ ok: true, status: xhr.status, responseUrl: xhr.responseURL, contentType, body });
          return;
        }
        const htmlResponse = contentType.includes("text/html") || /^\s*<!doctype\s+html|^\s*<html[\s>]/i.test(text);
        const message = body && body.message
          ? body.message
          : htmlResponse
            ? "用户接口被重定向到网页（HTTP " + xhr.status + "，" + (xhr.responseURL || "/api/user/self") + "）"
            : "用户接口返回无效数据（HTTP " + xhr.status + "）";
        done({ ok: false, status: xhr.status, responseUrl: xhr.responseURL, contentType, htmlResponse, message });
      };
      xhr.onerror = () => done({ ok: false, status: xhr.status || 0, message: "用户接口网络请求失败" });
      xhr.ontimeout = () => done({ ok: false, status: 0, message: "用户接口请求超时" });
      try { xhr.send(); }
      catch (e) { done({ ok: false, status: 0, message: e && e.message ? e.message : "用户接口请求失败" }); }
    });

    let result = await requestUser(false);
    if (checkinToken && window.__nacheckinCancelledCheckinToken === String(checkinToken)) return { ok: false, cancelled: true, message: "本轮签到已停止" };
    if (!result.ok || (cachedHasBalance && looksLikeEmptyAccount(result.body && result.body.data))) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      if (checkinToken && window.__nacheckinCancelledCheckinToken === String(checkinToken)) return { ok: false, cancelled: true, message: "本轮签到已停止" };
      const retry = await requestUser(true);
      if (retry.ok || !result.ok) result = retry;
    }

    // && 的短路结果可能是 false；请求失败不是“用户 ID 为 false”。
    const onlineData = result && result.ok && result.body ? result.body.data : null;
    const id = onlineData ? onlineData.id : null;
    const onlineId = (typeof id === "number" || typeof id === "string") && /^\d+$/.test(String(id).trim()) ? String(id).trim() : null;
    if (configured && onlineId !== null && configured !== onlineId) {
      return { userMismatch: true, configuredUserId: configured, actualUserId: String(onlineId) };
    }
    // 回调/检测必须使用在线响应，不能用旧 user 缓存补额度或证明当前会话。
    if (strict && result.ok && onlineId === null) return { ...result, ok: false, invalidIdentity: true,
      message: "在线账户响应缺少有效用户ID，尚未确认登录", cachedUser: null };
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
    } else if (result.ok && !(checkinToken && window.__nacheckinCancelledCheckinToken === String(checkinToken))) {
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
async function tabSubmitPasswordLogin(expectedOrigin, username, password, checkinToken = "") {
  const onLoginPage = () => location.origin === expectedOrigin && location.protocol === "https:" && /^\/login\/?$/.test(location.pathname);
  const cancelled = () => !!checkinToken && window.__nacheckinCancelledCheckinToken === String(checkinToken);
  if (cancelled()) return { ok: false, cancelled: true, message: "本轮邮箱密码登录已停止" };
  const visible = (el) => !!el && !el.disabled && el.getClientRects().length > 0;
  if (!onLoginPage()) return { ok: false, message: "登录页地址已变化，已停止填写密码" };
  for (let i = 0; i < 30; i++) {
    if (cancelled()) return { ok: false, cancelled: true, message: "本轮邮箱密码登录已停止" };
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
      if (cancelled()) return { ok: false, cancelled: true, message: "本轮邮箱密码登录已停止" };
      if (!onLoginPage()) return { ok: false, message: "登录页地址已变化，已停止提交" };
      const submit = Array.from(form.querySelectorAll('button, input[type="submit"]')).find((el) => visible(el) &&
        (el.type === "submit" || /^(继续|登录|登\s*录|sign\s*in|log\s*in|continue)$/i.test(String(el.textContent || el.value || "").trim())));
      if (!submit) return { ok: false, message: "登录按钮尚不可用，请完成本站验证后手动登录" };
      // button 的 formaction 可以覆盖 form.action；同样必须检查。
      // 必须重新读取 action：输入事件及 React 更新可能已替换提交目标。
      const explicitMethod = (submit.getAttribute("formmethod") || form.getAttribute("method") || "").toLowerCase();
      if (cancelled()) return { ok: false, cancelled: true, message: "本轮邮箱密码登录已停止" };
      if (!safeSubmission(submit) || (explicitMethod && explicitMethod !== "post")) {
        return { ok: false, message: "登录提交目标不安全，已停止提交" };
      }
      submit.click();
      return { ok: true };
    }
    // AnyRouter/NewAPI 的 OAuth 首页需要先展开“使用邮箱或用户名进行登录”。
    const reveal = Array.from(document.querySelectorAll("button")).find((el) => visible(el) &&
      /(?:邮箱|用户名|email|username)/i.test(el.textContent || "") && /(?:登录|登陆|log\s*in|sign\s*in|continue)/i.test(el.textContent || ""));
    if (reveal && !cancelled()) reveal.click();
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
// 只有明确未登录才进入登录流程；网络、权限和协议错误不能伪装成“还在登录”。
function sessionProbeUser(probe, allowUnauthenticated = false) {
  if (probe && probe.cancelled) throw makeCheckinError("CHECKIN_CANCELLED", "本轮签到已停止");
  if (probe && probe.timedOut) throw makeCheckinError("SESSION_REQUEST_TIMEOUT", "账户接口请求超时（不是登录失效），页面已保留");
  const status = Number(probe && probe.status || 0);
  const body = probe && probe.body;
  const detail = body && typeof body.message === "string" ? body.message.slice(0, 240) : "";
  if (probe && probe.htmlResponse) throw makeCheckinError("SESSION_CHALLENGE", "账户接口返回网页而非账户数据，请在保留的页面完成登录或安全验证");
  if (status === 401) {
    if (allowUnauthenticated) return null;
    throw makeCheckinError("SESSION_EXPIRED", "账户接口 HTTP 401：登录会话已失效，请重新登录" + (detail ? "（" + detail + "）" : ""));
  }
  if (!probe || !probe.ok || !body || body.success === false) {
    throw makeCheckinError("SESSION_REQUEST_FAILED", "账户接口" + (status ? " HTTP " + status : "") + "：" + (detail || "未返回有效响应，请检查网络或站点权限"));
  }
  const user = body.data;
  if (!user || !["string", "number"].includes(typeof user.id) || !/^\d+$/.test(String(user.id))) {
    throw makeCheckinError("SESSION_RESPONSE_INVALID", "账户接口返回格式不兼容：缺少有效用户 ID");
  }
  return user;
}

async function loginPasswordOnTab(p, tab, force = false, control = null) {
  const origin = new URL(p.baseUrl).origin;
  const login = String(p.loginUsername || "").trim();
  const inject = async (func, args = [], main = false) => {
    const current = await chrome.tabs.get(tab.id);
    if (!current.url || new URL(current.url).origin !== origin) throw new Error("站点跳转到其他地址，已停止邮箱密码登录");
    await dismissSiteNotice(tab.id, origin, control);
    const out = await executeCheckinScript({ target: { tabId: tab.id }, ...(main ? { world: "MAIN" } : {}), func, args }, control);
    return out && out[0] && out[0].result;
  };
  const probe = await inject(tabFetchCheckin, ["/api/user/self", "GET", null, String(p.userId || ""), "New-Api-User"]);
  const currentUser = sessionProbeUser(probe, true);
  if (!force && passwordUserMatches(p, currentUser)) return currentUser;
  // 不沿用其他账号/无法确认归属的会话，也不能以旧 localStorage 证明登录成功。
  const logout = await inject(tabLogout, [], true);
  if (!logout || !logout.ok) throw new Error("无法退出旧登录会话，请在本站手动退出后重试");
  clearSiteSessionTokens(origin);
  await chrome.tabs.update(tab.id, { url: origin + "/login", active: true });
  await waitTabComplete(tab.id, control);
  if (control) control.pageTabIds.add(tab.id);
  let submitted;
  try { submitted = await inject(tabSubmitPasswordLogin, [origin, login, p.loginPassword, control && control.token || ""], true); }
  finally { if (control) control.pageTabIds.delete(tab.id); }
  assertCheckinActive(control);
  if (!submitted || !submitted.ok) throw new Error(submitted && submitted.message || "无法填写本站登录表单");
  // 成功必须同时有新的页面登录数据和在线 self，不能仅以提交按钮/跳转判断。
  for (let i = 0; i < 25; i++) {
    await wait(800, control);
    let stored = null, online = null;
    try {
      stored = await inject(tabReadAgentRouterStoredUser);
      online = await inject(tabFetchCheckin, ["/api/user/self", "GET", null, String(stored && stored.id || p.userId || ""), "New-Api-User"]);
    } catch (error) { assertCheckinActive(control); if (!isRemovedDocumentError(error)) throw error; continue; } // 仅导航中断可重试。
    const user = online ? sessionProbeUser(online, true) : null;
    if (!user || (stored && String(user.id) !== String(stored.id))) continue;
    verifyConfiguredUser(p, online.body);
    // 新表单登录完成后，若站点提供邮箱/用户名，进一步拒绝明确串号。
    if ((!login.includes("@") || user.email) && !passwordUserMatches(p, user)) throw new Error("本站登录账号与配置的邮箱/用户名不一致");
    return { ...user, checked_in: !!stored && stored.checked_in === true, _freshLogin: true };
  }
  throw new Error("邮箱密码登录尚未完成：请在打开的页面检查密码、验证码或二次验证，完成后重试");
}

async function ensurePasswordSession(p, force = false, control = null) {
  validatePlatform(p);
  const origin = new URL(p.baseUrl).origin;
  if (visitOnlyOrigins.has(origin) || agentRouterStarting.has(origin)) throw new Error("本站有访问或 OAuth 登录任务正在启动，请完成后重试");
  await waitForAgentRouterTurn(p, false, control);
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
      const user = await loginPasswordOnTab(p, tab, force, control);
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

function tabLogout(checkinToken = "", expectedOrigin = "", bearer = "", sessionId = "") {
  return (async () => {
    let requestTimer, controller, onStop;
    try {
      if (expectedOrigin && location.origin !== expectedOrigin) return { ok: false, body: { message: "退出页面已跳转到其他站点" } };
      let userId = "-1";
      try {
        const user = JSON.parse(localStorage.getItem("user") || "null");
        if (user && user.id != null) userId = String(user.id);
      } catch {}
      if (checkinToken && window.__nacheckinCancelledCheckinToken === String(checkinToken)) return { ok: false, cancelled: true };
      controller = new AbortController();
      onStop = (event) => { if (checkinToken && event && event.detail === String(checkinToken)) controller.abort(); };
      if (checkinToken) window.addEventListener("nacheckin:checkin-stop", onStop);
      requestTimer = setTimeout(() => controller.abort(), 12000);
      const res = await fetch(bearer ? "/api/user/auth/logout" : "/api/user/logout", {
        method: bearer ? "POST" : "GET", signal: controller.signal, mode: "same-origin",
        credentials: "include",
        headers: {
          "Accept": "application/json, text/plain, */*",
          "Cache-Control": "no-store",
          ...(bearer ? { "Authorization": "Bearer " + bearer } : { "New-API-User": userId }),
          ...(bearer && sessionId ? { "X-Auth-Session": sessionId } : {}),
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
    } finally {
      clearTimeout(requestTimer);
      if (checkinToken && onStop) window.removeEventListener("nacheckin:checkin-stop", onStop);
    }
  })();
}

// 参数来自站点公开配置，不硬编码 client_id；Cookie/state 始终由站点页面生成。
async function tabBuildAgentRouterOauthUrl(provider, expectedOrigin, checkinToken = "") {
  const controller = new AbortController();
  const onStop = (event) => { if (checkinToken && event && event.detail === String(checkinToken)) controller.abort(); };
  let requestTimer;
  if (checkinToken) window.addEventListener("nacheckin:checkin-stop", onStop);
  try {
    if (location.origin !== expectedOrigin) return { ok: false, message: "登录页跳转到其他站点，已停止 OAuth" };
    if (!["github", "linuxdo"].includes(provider)) return { ok: false, message: "不支持的 OAuth 登录方式" };
    if (checkinToken && window.__nacheckinCancelledCheckinToken === String(checkinToken)) return { ok: false, cancelled: true };
    const headers = { "Accept": "application/json, text/plain, */*", "Cache-Control": "no-store" };
    requestTimer = setTimeout(() => controller.abort(), 60000);
    const statusRes = await fetch("/api/status", { credentials: "include", headers, signal: controller.signal });
    const statusBody = await statusRes.json();
    if (controller.signal.aborted || (checkinToken && window.__nacheckinCancelledCheckinToken === String(checkinToken))) return { ok: false, cancelled: !!checkinToken };
    const status = statusRes.ok && statusBody && statusBody.success !== false && statusBody.data;
    const clientId = status && status[provider === "linuxdo" ? "linuxdo_client_id" : "github_client_id"];
    if (!clientId) return { ok: false, message: "站点未提供 " + (provider === "linuxdo" ? "Linux DO" : "GitHub") + " OAuth 配置" };
    const params = new URLSearchParams({ mode: "login" });
    const aff = localStorage.getItem("aff");
    if (aff) params.set("aff", aff);
    const stateRes = await fetch("/api/oauth/state?" + params.toString(), { credentials: "include", headers, signal: controller.signal });
    const stateBody = await stateRes.json();
    if (controller.signal.aborted || (checkinToken && window.__nacheckinCancelledCheckinToken === String(checkinToken))) return { ok: false, cancelled: !!checkinToken };
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
  } catch (e) {
    const cancelled = controller.signal.aborted && !!checkinToken;
    return { ok: false, cancelled, message: cancelled ? "本轮 OAuth 已停止" : controller.signal.aborted ? "OAuth 请求超时" : "无法启动 OAuth，可能需要先在本站完成安全验证" };
  } finally {
    clearTimeout(requestTimer);
    if (checkinToken) window.removeEventListener("nacheckin:checkin-stop", onStop);
  }
}

// 只在本轮动态 client_id/state 与当前授权 URL 完全匹配时寻找 Linux DO 同意链接。
function tabClickLinuxDoApprove(expectedState, expectedClientId, checkinToken = "") {
  let clickAttempted = false;
  const fail = (reason) => ({ ok: false, clicked: clickAttempted, reason });
  const cancelled = () => !!checkinToken && window.__nacheckinCancelledCheckinToken === String(checkinToken);
  try {
    if (cancelled()) return fail("checkin_cancelled");
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
    if (cancelled()) return fail("checkin_cancelled");
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
    if (!user || !["number", "string"].includes(typeof user.id) || !/^\d+$/.test(String(user.id))) return { ok: false };
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
  await checkinStopVersionReady;
  if (pending.stopVersion != null && Number(pending.stopVersion) !== latestCheckinStopVersion) return;
  return await mutatePlatforms(async (list) => {
    if (pending.stopVersion != null && Number(pending.stopVersion) !== latestCheckinStopVersion) return list;
    if (pending.token != null) {
      const currentPending = (await getAgentRouterPending())[pending.tabId];
      if (!samePendingGeneration(currentPending, pending) || pending.stopVersion !== latestCheckinStopVersion) return list;
    }
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
      p.reauthCheckedIn = !!(login && login.ok && login.checkedIn === true);
      p.reauthAccountUpdated = !!(login && login.ok && login.account);
      p.message = message;
      p.error = login && login.ok ? "" : message;
      p.lastCheckinAt = new Date().toISOString();
      // 登录与签到分开确认：未获签到奖励也应更新已在线核验的额度。
      if (login && login.ok && login.account) {
        p.account = { ...(p.account || {}), ...login.account };
        p.accountError = "";
      }
      if (login && login.ok && login.checkedIn === true) {
        p.stats = { ...(p.stats || {}), checked_in_today: true };
        p.statsDate = todayStr();
      }
    }
    return list;
  });
}

async function startAgentRouterReauth(base, platform, control = null) {
  assertCheckinActive(control);
  markCheckinProgress(control, "oauth-starting");
  const origin = new URL(base).origin;
  const tab = await chrome.tabs.create({ url: origin + "/login", active: true });
  const pending = {
    tabId: tab.id, base, origin, platformId: platform.id || null,
    userId: String(platform.userId || ""), authMode: platform.authMode || "cookie",
    provider: agentRouterProvider(platform), oauthStarted: false, createdAt: Date.now(),
    stopVersion: control ? control.stopVersion : latestCheckinStopVersion,
    token: control ? control.token : null, lastProgressAt: Date.now(), phase: "oauth-starting",
  };
  await updateAgentRouterPending(tab.id, pending, null, true);
  assertCheckinActive(control);
  await mutatePlatforms((list) => {
    assertCheckinActive(control);
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
  assertCheckinActive(control);
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
  await checkinStopVersionReady;
  const pending = (await getAgentRouterPending())[tabId];
  if (!pending) return;
  const active = activeCheckinControl;
  if (active && !active.waitingToStart && (pending.stopVersion == null || active.stopVersion === Number(pending.stopVersion))) {
    return processAgentRouterReauthTabControlled(tabId, tabUrl, active);
  }
  // 恢复中的回调不借用下一项的冷却 control，但仍有独立的停止代数/token。
  // 这里只传播取消，OAuth pending 自身的 lastProgressAt 继续负责登录闲置超时。
  const control = { stopVersion: pending.stopVersion == null ? latestCheckinStopVersion : normalizeStopVersion(pending.stopVersion),
    controller: new AbortController(), waitingToStart: true, timedOut: false, idleTimer: null,
    token: pending.token || String(Date.now()) + "-oauth-" + Math.random().toString(36).slice(2),
    pageTabIds: new Set(), pageWorlds: new Map() };
  control.abortListener = () => broadcastCheckinPageStop(control);
  control.controller.signal.addEventListener("abort", control.abortListener, { once: true });
  detachedOauthControls.add(control);
  try { return await processAgentRouterReauthTabControlled(tabId, tabUrl, control); }
  finally { detachedOauthControls.delete(control); finishCheckinControl(control); }
}
async function processAgentRouterReauthTabControlled(tabId, tabUrl, control) {
  let pending = (await getAgentRouterPending())[tabId];
  if (!pending) return;
  assertCheckinActive(control);

  let reportedUrl;
  try { reportedUrl = new URL(tabUrl); } catch {}
  const callbackStates = reportedUrl ? reportedUrl.searchParams.getAll("state") : [];
  const callbackCodes = reportedUrl ? reportedUrl.searchParams.getAll("code") : [];
  if (reportedUrl && reportedUrl.origin === pending.origin && reportedUrl.pathname.replace(/\/$/, "") === "/oauth/" + pending.provider &&
      pending.oauthStarted === true && String(pending.oauthState || "").trim() && callbackStates.length === 1 &&
      callbackStates[0] === pending.oauthState && callbackCodes.length === 1 && callbackCodes[0] && pending.callbackSeen !== true) {
    pending.callbackSeen = true;
    pending.callbackSettleUntil = Date.now() + 1500;
    pending.lastProgressAt = Date.now();
    pending.phase = "oauth-callback";
    markCheckinProgress(control, "oauth-callback");
    if (!await patchAgentRouterPending(pending, { callbackSeen: true, callbackSettleUntil: pending.callbackSettleUntil,
      lastProgressAt: pending.lastProgressAt, phase: pending.phase })) return;
  }
  const label = agentRouterProviderLabel(pending.provider);
  const lastProgressAt = Number(pending.lastProgressAt || pending.createdAt || Date.now());
  if (Date.now() - lastProgressAt >= CHECKIN_IDLE_LIMIT_MS) {
    const message = label + " 登录同一阶段连续 60 秒无有效进展，页面已保留，请完成验证后重新签到";
    await saveAgentRouterLoginOutcome(pending, null, message);
    await updateAgentRouterPending(tabId, null, pending);
    return; // 不关闭需要用户交互的页面。
  }
  let url;
  try { url = new URL(tabUrl); } catch { return; }

  if (pending.provider === "linuxdo" && pending.authMode === "agentrouter_linuxdo" &&
      url.protocol === "https:" && url.origin === "https://connect.linux.do" && url.pathname === "/oauth2/authorize") {
    if (pending.approveClickStarted === true || pending.oauthStarted !== true ||
        !String(pending.oauthState || "").trim() || !String(pending.oauthClientId || "").trim()) return;
    const validAuthorizeUrl = (value) => {
      let candidate;
      try { candidate = new URL(value); } catch { return false; }
      const states = candidate.searchParams.getAll("state");
      const clientIds = candidate.searchParams.getAll("client_id");
      const responseTypes = candidate.searchParams.getAll("response_type");
      return candidate.protocol === "https:" && candidate.origin === "https://connect.linux.do" && candidate.pathname === "/oauth2/authorize" &&
        states.length === 1 && states[0] === pending.oauthState && clientIds.length === 1 && clientIds[0] === pending.oauthClientId &&
        responseTypes.length === 1 && responseTypes[0] === "code";
    };
    if (!validAuthorizeUrl(tabUrl)) return;
    const authorizeTab = await chrome.tabs.get(tabId).catch(() => null);
    if (!authorizeTab || authorizeTab.status !== "complete" || !validAuthorizeUrl(authorizeTab.url)) return;

    const authorizeUrl = new URL(authorizeTab.url);
    const approvalWaitKey = JSON.stringify([authorizeUrl.origin, authorizeUrl.pathname,
      authorizeUrl.searchParams.get("state"), authorizeUrl.searchParams.get("client_id"), authorizeUrl.searchParams.get("response_type")]);
    if (pending.approvalWaitKey !== approvalWaitKey) {
      pending.approvalWaitKey = approvalWaitKey;
      pending.approvalWaitUntil = Date.now() + 1500;
      pending.lastProgressAt = Date.now();
      pending.phase = "linuxdo-authorize-settling";
      markCheckinProgress(control, "linuxdo-authorize:" + approvalWaitKey, true);
      if (!await patchAgentRouterPending(pending, { approvalWaitKey: pending.approvalWaitKey,
        approvalWaitUntil: pending.approvalWaitUntil, lastProgressAt: pending.lastProgressAt, phase: pending.phase })) return;
    }
    const settleMs = Math.max(0, Number(pending.approvalWaitUntil || 0) - Date.now());
    if (settleMs) await wait(settleMs, control);
    assertCheckinActive(control);
    const latestTab = await chrome.tabs.get(tabId).catch(() => null);
    const latestPending = (await getAgentRouterPending())[tabId];
    if (!latestTab || latestTab.status !== "complete" || !samePendingGeneration(latestPending, pending) ||
        latestPending.approveClickStarted === true || !validAuthorizeUrl(latestTab.url)) return;
    pending = latestPending;
    // 先持久化预留：注入结果丢失或 worker 中断时不重复提交授权。
    if (!await patchAgentRouterPending(pending, { approveClickStarted: true })) return;
    let approval;
    try {
      const spec = { target: { tabId }, world: "MAIN", func: tabClickLinuxDoApprove,
        args: [pending.oauthState, pending.oauthClientId] };
      const out = control ? await executeCheckinScript(spec, control) : await chrome.scripting.executeScript(spec);
      approval = out && out[0] && out[0].result;
    } catch (error) {
      assertCheckinActive(control);
      return; // 结果不确定时保留页面供人工处理，不重试可能已发生的点击。
    }
    assertCheckinActive(control);
    if (approval && approval.ok === false && approval.clicked === false) {
      await patchAgentRouterPending(pending, { approveClickStarted: false });
    }
    return;
  }
  if (url.origin !== pending.origin) return; // 其他 provider / 外站页面不注入本站代码。
  const noticePage = await chrome.tabs.get(tabId).catch(() => null);
  // 已排队的旧 URL 事件可能在页面进入授权站之后才处理，不能据它向外站注入。
  if (!noticePage || !noticePage.url || new URL(noticePage.url).origin !== pending.origin) return;
  await dismissSiteNotice(tabId, pending.origin, control);
  if (/^\/login\/?$/.test(url.pathname) && !pending.oauthStarted) {
    let oauth = null;
    try {
      const spec = { target: { tabId }, world: "MAIN", func: tabBuildAgentRouterOauthUrl, args: [pending.provider, pending.origin] };
      const out = control ? await executeCheckinScript(spec, control) : await chrome.scripting.executeScript(spec);
      oauth = out && out[0] && out[0].result;
    } catch (error) { assertCheckinActive(control); }
    assertCheckinActive(control);
    if (!oauth || !oauth.ok || !oauth.url) {
      if (!oauth || !oauth.cancelled) notify("Agent Router 自动登录未启动", (oauth && oauth.message) || "请在本站登录页手动使用 " + label + " 登录");
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
      pending.oauthClientId = clientIds[0];
      pending.approveClickStarted = false;
    }
    pending.oauthStarted = true;
    pending.oauthState = states[0];
    pending.lastProgressAt = Date.now();
    pending.phase = "oauth-launched";
    markCheckinProgress(control, "oauth-launched");
    if (!await patchAgentRouterPending(pending, pending)) return;
    const updated = await chrome.tabs.update(tabId, { url: oauth.url, active: true }).catch(() => null);
    assertCheckinActive(control);
    if (!updated) await patchAgentRouterPending(pending, { oauthStarted: false, phase: "oauth-launch-failed" });
    return;
  }
  if (pending.visitOnly || !pending.callbackSeen) return;

  const settleUntil = Number(pending.callbackSettleUntil || 0);
  if (settleUntil > Date.now()) await wait(settleUntil - Date.now(), control);
  assertCheckinActive(control);
  const afterSettle = await chrome.tabs.get(tabId).catch(() => null);
  if (!afterSettle || !afterSettle.url || new URL(afterSettle.url).origin !== pending.origin) return;

  let login = null, mismatch = null, mismatchSamples = 0;
  for (let i = 0; i < 12; i++) {
    assertCheckinActive(control);
    if (i) await wait(1200, control);
    mismatch = null;
    try {
      const current = await chrome.tabs.get(tabId);
      if (!current.url || new URL(current.url).origin !== pending.origin) return;
      if (current.status !== "complete") { mismatchSamples = 0; continue; }
      await dismissSiteNotice(tabId, pending.origin, control);
      const cachedOut = await chrome.scripting.executeScript({ target: { tabId }, func: tabCheckAgentRouterLogin, args: [pending.userId] });
      const cached = cachedOut && cachedOut[0] && cachedOut[0].result;
      const onlineSpec = { target: { tabId }, world: "MAIN", func: tabFetchAgentRouterAccount, args: [pending.userId, true] };
      const onlineOut = control ? await executeCheckinScript(onlineSpec, control) : await chrome.scripting.executeScript(onlineSpec);
      const online = onlineOut && onlineOut[0] && onlineOut[0].result;
      const liveData = online && online.ok && online.body && online.body.success !== false ? online.body.data : null;
      const live = liveData && ["number", "string"].includes(typeof liveData.id) && /^\d+$/.test(String(liveData.id)) ? liveData : null;
      const expected = String(pending.userId || cached && cached.userId || "").trim();
      if (online && (online.userMismatch || (live && live.id != null && expected && String(live.id) !== expected))) {
        mismatch = { ok: false, userMismatch: true, userId: String(online.actualUserId || live && live.id || "") };
        mismatchSamples++;
        continue;
      }
      mismatch = null;
      mismatchSamples = 0;
      if (!live || live.id == null || !cached || !cached.ok || String(live.id) !== String(cached.userId)) continue;
      markCheckinIdentity(control, live.id);
      if (pending.lastVerifiedIdentity !== String(live.id)) {
        pending.lastVerifiedIdentity = String(live.id);
        pending.lastProgressAt = Date.now();
        pending.phase = "oauth-online-identity";
        if (!await patchAgentRouterPending(pending, { lastVerifiedIdentity: pending.lastVerifiedIdentity,
          lastProgressAt: pending.lastProgressAt, phase: pending.phase })) return;
      }
      const latest = await chrome.tabs.get(tabId);
      if (!latest.url || new URL(latest.url).origin !== pending.origin) return;
      if (latest.status !== "complete" || /^\/(login|signin|register|oauth)(\/|$)/i.test(new URL(latest.url).pathname)) continue;
      login = { ...cached, account: null };
      break;
    } catch (error) {
      assertCheckinActive(control);
      mismatchSamples = 0;
    }
  }
  if (!login && mismatch && mismatchSamples >= 12) {
    const current = await chrome.tabs.get(tabId).catch(() => null);
    if (current && current.status === "complete" && current.url && new URL(current.url).origin === pending.origin &&
        !/^\/(login|signin|register|oauth)(\/|$)/i.test(new URL(current.url).pathname)) login = mismatch;
  }
  if (!login) return;
  assertCheckinActive(control);
  let accountWarning = "";
  if (login.ok) {
    const platforms = await getPlatforms();
    const platform = platforms.find((p) => pending.platformId ? p.id === pending.platformId :
      isAgentRouterReauthMode(p) && new URL(p.baseUrl).origin === pending.origin && sameOauthTask(pending, p));
    if (!platform || !sameOauthTask(pending, platform) ||
        (platform.reauthStartedAt != null && Number(platform.reauthStartedAt) !== Number(pending.createdAt))) {
      await updateAgentRouterPending(tabId, null, pending);
      return;
    }
    await mutatePlatforms((list) => {
      assertCheckinActive(control);
      const current = list.find((p) => p.id === platform.id);
      if (current && sameOauthTask(pending, current) && Number(current.reauthStartedAt) === Number(pending.createdAt)) {
        current.message = label + " 登录已确认，正在刷新看板并读取页面余额（最多 5 次）";
      }
      return list;
    });
    try {
      login.account = await refreshLoginAccountOnTab(platform, tabId, () => waitAgentRouterAccountOnTab(platform, tabId, control), control);
    } catch (error) {
      assertCheckinActive(control);
      accountWarning = "；最新额度刷新失败：" + error.message + "（页面已保留）";
    }
  }
  const message = (login.userMismatch
    ? "登录账号与配置的用户ID不一致（当前 " + login.userId + "，配置 " + pending.userId + "），未确认签到；请切换正确账号后重试"
    : login.checkedIn === true
      ? label + " 重登录回调已确认签到成功" + (login.account ? "，看板余额已更新" : "")
      : label + " 登录已完成，但本站回调未确认签到；请检查站点签到规则") + accountWarning;
  assertCheckinActive(control);
  await saveAgentRouterLoginOutcome(pending, login, message);
  await updateAgentRouterPending(tabId, null, pending);
  notify("Agent Router 登录结果", message);
  assertCheckinActive(control);
  if (login.ok && login.checkedIn === true && !accountWarning) await chrome.tabs.remove(tabId).catch(() => {});
  else await chrome.tabs.update(tabId, { active: true }).catch(() => {});
}

// 在目标站点页面内完成 Turnstile 验证，再用同一页面上下文提交签到。
// Turnstile site key 受域名限制，不能在 Service Worker 或扩展页面中渲染。
function tabFetchTurnstileCheckin(accessToken, userId, checkinToken = "") {
  return new Promise((resolve) => {
    const overlayId = "__nacheckin_turnstile_overlay";
    const old = document.getElementById(overlayId);
    if (old) old.remove();
    let settled = false;
    let cancelled = false;
    const onStop = (event) => {
      if (checkinToken && event && event.detail === String(checkinToken)) { cancelled = true; finish({ ok: false, status: 0, body: { success: false, message: "本轮签到已停止" }, verified: false }); }
    };
    window.addEventListener("nacheckin:checkin-stop", onStop);
    const finish = (value) => {
      if (settled) return;
      settled = true;
      const el = document.getElementById(overlayId);
      if (el) el.remove();
      window.removeEventListener("nacheckin:checkin-stop", onStop);
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
      if (submitted || cancelled || (checkinToken && window.__nacheckinCancelledCheckinToken === String(checkinToken))) return;
      submitted = true;
      try {
        if (cancelled || (checkinToken && window.__nacheckinCancelledCheckinToken === String(checkinToken))) return;
        const controller = new AbortController();
        const requestTimer = setTimeout(() => controller.abort(), 55000);
        const res = await fetch("/api/user/checkin?turnstile=" + encodeURIComponent(token), {
          method: "POST", headers, credentials: "include", signal: controller.signal,
        });
        clearTimeout(requestTimer);
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
    setTimeout(() => fail("等待 Turnstile 验证超时"), 55000);
  });
}

function isTurnstileMissingMessage(message) {
  return /Turnstile\s*(?:token\s*)?(?:为空|empty|missing)|turnstile token is empty/i.test(String(message || ""));
}

async function runTurnstileCheckin(platform, control = null) {
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
  if (control) control.pageTabIds.add(tab.id);
  try {
    await dismissSiteNotice(tab.id, base, control);
    const out = await executeCheckinScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: tabFetchTurnstileCheckin,
      args: [isTokenAuthMode(platform) ? String(platform.accessToken || "").trim() : "", String(platform.userId || "").trim(), control && control.token || ""],
    }, control);
    result = out && out[0] && out[0].result;
  } catch (e) {
    if (control) control.pageTabIds.delete(tab.id);
    assertCheckinActive(control);
    throw new Error("无法在站点页面启动 Turnstile 验证：" + (e && e.message ? e.message : "请先打开目标站点"));
  }
  const verified = !!(result && result.verified);
  try {
    return throwOnBadResult(result, "POST", { triggerSelf: false });
  } finally {
    if (control) control.pageTabIds.delete(tab.id);
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
    await dismissSiteNotice(tab.id, base, opts && opts.control);
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
      const out = await executeCheckinScript({
        target: { tabId: tab.id },
        func: tabFetchCheckin,
        args: [reqUrl, reqMethod, st.triggerSelf ? null : (month || currentMonth() || null), String(p.userId || "").trim(), st.apiUserKey || null],
      }, opts && opts.control);
      result = out && out[0] && out[0].result;
    } catch (e) {
      if (isCheckinControlError(e)) throw e;
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
        await dismissSiteNotice(tab.id, base, opts && opts.control);
        const retry = await executeCheckinScript({
          target: { tabId: tab.id },
          func: tabFetchCheckin,
          args: [reqUrl, reqMethod, st.triggerSelf ? null : (month || currentMonth() || null), String(p.userId || "").trim(), st.apiUserKey || null],
        }, opts && opts.control);
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

// 只恢复账户/日志的 GET 读取，绝不重放签到、登录、授权或其他写请求。
function isAccountReadRequest(reqPath, method) {
  return String(method || "GET").toUpperCase() === "GET" &&
    /^\/api\/(?:user\/self|log\/self(?:\/stat)?)\/?$/.test(reqPath);
}
function isRemovedDocumentError(error) {
  return !!error && (error.code === "ACCOUNT_DOCUMENT_CHANGED" ||
    /Frame with ID \d+ was removed|The frame was removed|The document was unloaded|Execution context was destroyed/i.test(error.message || ""));
}
async function executeAccountReadOnTab(platform, spec, control = null) {
  if (spec.func !== tabFetchCheckin || !isAccountReadRequest(spec.args[0], spec.args[1])) {
    throw new Error("页面恢复仅允许账户和日志的只读请求");
  }
  const tabId = spec.target.tabId;
  const origin = new URL(platform.baseUrl).origin;
  const deadline = Date.now() + 12000;
  const getPage = async () => {
    assertCheckinActive(control);
    const page = await chrome.tabs.get(tabId).catch(() => null);
    if (!page) throw new Error("账户页面已关闭，已停止取数，请重新打开站点后重试");
    for (const url of [page.url, page.pendingUrl].filter(Boolean)) {
      if (new URL(url).origin !== origin) throw new Error("账户页面已跳转到其他站点，已停止取数");
      if (/^\/(login|signin|register|oauth)(\/|$)/i.test(new URL(url).pathname)) {
        throw new Error("账户页面已返回登录或授权页，请完成登录后重试");
      }
    }
    if (!page.url) throw new Error("无法确认账户页面地址，已停止取数");
    return page;
  };
  const readyPage = async () => {
    for (;;) {
      const page = await getPage();
      if (page.status === "complete" && !page.pendingUrl) return page;
      if (Date.now() >= deadline) throw new Error("账户页面加载超时，已停止取数，请稍后重试");
      await wait(200, control);
    }
  };
  const changedError = () => {
    const error = new Error("账户页面在取数期间发生导航");
    error.code = "ACCOUNT_DOCUMENT_CHANGED";
    return error;
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await readyPage();
    let changed = false;
    const updated = (id, info) => {
      if (id === tabId && (info.status === "loading" || (info.url && info.url !== before.url))) changed = true;
    };
    const removed = (id) => { if (id === tabId) changed = true; };
    chrome.tabs.onUpdated.addListener(updated);
    chrome.tabs.onRemoved.addListener(removed);
    try {
      await dismissSiteNotice(tabId, origin, control, spec.args[0] !== "/api/log/self");
      const page = await getPage();
      if (changed || page.status !== "complete" || page.pendingUrl) throw changedError();
      const args = [...spec.args];
      args[7] = origin;
      const out = await executeCheckinScript({ ...spec, args }, control);
      const after = await getPage();
      if (changed || after.status !== "complete" || after.pendingUrl || after.url !== before.url) throw changedError();
      return out;
    } catch (error) {
      assertCheckinActive(control);
      // 关闭、跨站/登录跳转、权限和业务失败不属于可恢复的框架中断。
      await getPage();
      if (!isRemovedDocumentError(error) || attempt === 2 || Date.now() >= deadline) throw error;
    } finally {
      chrome.tabs.onUpdated.removeListener(updated);
      chrome.tabs.onRemoved.removeListener(removed);
    }
    await wait(350, control);
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
      tab = await chrome.tabs.create({ url: origin + "/", active: false });
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
      const spec = {
        target: { tabId: tab.id },
        func: tabFetchCheckin,
        args: [reqPath, (method || "GET").toUpperCase(), opts && opts.month != null ? opts.month : null, String(p.userId || "").trim(), apiUserKey, opts && opts.query ? opts.query : null, "", origin],
      };
      let out;
      if (isAccountReadRequest(reqPath, method)) out = await executeAccountReadOnTab(p, spec, opts && opts.control);
      else {
        await dismissSiteNotice(tab.id, base, opts && opts.control);
        out = await executeCheckinScript(spec, opts && opts.control);
      }
      result = out && out[0] && out[0].result;
    } catch (e) {
      if (isCheckinControlError(e)) throw e;
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
  const control = opts && opts.control;
  assertCheckinActive(control);
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
    res = await checkinFetch(url.toString(), { method, headers, credentials: "omit" }, control);
  } catch (e) {
    if (isCheckinControlError(e)) throw e;
    throw new Error("网络请求失败：" + (e && e.message ? e.message : "无法连接站点"));
  }
  const contentType = String(res.headers && res.headers.get ? (res.headers.get("content-type") || "") : "").toLowerCase();
  let text = "";
  try { text = await res.text(); } catch { text = ""; }
  assertCheckinActive(control);
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
  if (p.authMode === "password") await ensurePasswordSession(p, false, opts && opts.control);
  const base = (p.baseUrl || "").trim().replace(/\/+$/, "");
  if (p.authMode === "cookie" || p.authMode === "password" || isAgentRouterMode(p)) {
    const st = cookieStrategy(p, base);
    const merged = Object.assign({ apiUserKey: st.apiUserKey }, opts || {});
    return await callViaTabRaw(p, base, reqPath, method, merged);
  }
  return await callApiPath(p, reqPath, method, opts);
}

// 仅访问：始终创建独立临时页，不复用或关闭用户原有标签页。
function waitVisitComplete(tabId, startNavigation = null, control = null, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (control) control.controller.signal.removeEventListener("abort", aborted);
      chrome.tabs.onUpdated.removeListener(updated);
      chrome.tabs.onRemoved.removeListener(removed);
      if (error) reject(error); else resolve();
    };
    const aborted = () => { try { assertCheckinActive(control); } catch (error) { finish(error); } };
    const updated = (id, info) => { if (id === tabId && info.status === "complete") finish(); };
    const removed = (id) => { if (id === tabId) finish(new Error("访问页面在加载完成前已关闭")); };
    chrome.tabs.onUpdated.addListener(updated);
    chrome.tabs.onRemoved.addListener(removed);
    timer = setTimeout(() => finish(new Error("访问页面加载超时，页面已保留，请检查站点后重试")), timeoutMs);
    if (control) {
      control.controller.signal.addEventListener("abort", aborted, { once: true });
      if (control.controller.signal.aborted) { aborted(); return; }
    }
    if (startNavigation) {
      // 先订阅事件再触发刷新，不能把刷新前旧文档的 complete 当作刷新完成。
      Promise.resolve().then(() => {
        assertCheckinActive(control);
        if (!settled) return startNavigation();
      }).catch((e) => finish(e));
    } else {
      chrome.tabs.get(tabId).then((tab) => {
        if (tab && tab.status === "complete") finish();
      }).catch(() => finish(new Error("无法读取访问页面")));
    }
  });
}
// 必须在线验证 Cookie 会话；不能以页面加载、旧 localStorage 或配置令牌当作网页登录成功。
async function readVisitSession(platform, tabId, allowAccountSwitch = false, allowLoginPage = false, control = null) {
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
  if (current.status !== "complete") throw makeCheckinError("SESSION_PAGE_PENDING", "账户页面仍在导航，请稍候");
  try { await dismissSiteNotice(tabId, origin, control); }
  catch (error) { assertCheckinActive(control); if (isRemovedDocumentError(error)) throw makeCheckinError("SESSION_PAGE_PENDING", "账户页面正在切换文档"); throw error; }
  let probe;
  try {
    const out = await executeCheckinScript({ target: { tabId }, world: "MAIN", func: tabFetchCheckin,
      args: ["/api/user/self", "GET", null, String(platform.userId || ""), cookieStrategy(platform, platform.baseUrl).apiUserKey, null, "", origin] }, control);
    probe = out && out[0] && out[0].result;
  } catch (error) {
    assertCheckinActive(control);
    if (isRemovedDocumentError(error)) throw makeCheckinError("SESSION_PAGE_PENDING", "账户页面正在切换文档");
    throw error;
  }
  const user = sessionProbeUser(probe, allowAccountSwitch || allowLoginPage);
  if (!user) return null;
  if (allowAccountSwitch && platform.authMode === "password" && !passwordUserMatches(platform, user)) return null;
  if (allowAccountSwitch && isAgentRouterReauthMode(platform) && platform.userId && String(platform.userId).trim() !== String(user.id)) return null;
  verifyConfiguredUser(platform, probe.body);
  if (platform.authMode === "password" && !passwordUserMatches(platform, user)) {
    throw new Error("本站登录账号与配置的邮箱/用户名不一致，页面已保留");
  }
  if (!platform.userId || String(platform.userId).trim() === String(user.id)) markCheckinIdentity(control, user.id);
  // 登录/回调页面还未完成前端导航，不能立即关闭。
  const latest = await chrome.tabs.get(tabId).catch(() => null);
  if (!latest) throw new Error("访问页面已关闭，未确认登录");
  const latestUrl = new URL(latest.url);
  if (latestUrl.origin !== origin) throw new Error("身份核验期间页面跳转到其他站点，未确认登录");
  if (latest.status !== "complete") throw makeCheckinError("SESSION_PAGE_PENDING", "身份核验期间页面正在导航");
  if (!allowLoginPage && /^\/(login|signin|register|oauth)(\/|$)/i.test(latestUrl.pathname)) throw makeCheckinError("SESSION_PAGE_PENDING", "在线身份已确认，正在等待登录页面完成跳转");
  return user;
}

async function waitVisitSession(platform, tabId, oauth = false, allowLoginPage = false, requireQuota = false, control = null) {
  const startedAt = Date.now();
  const deadline = startedAt + CHECKIN_IDLE_LIMIT_MS;
  let mismatchSamples = 0, timeoutAttempts = 0;
  while (Date.now() < (control ? control.lastProgressAt + CHECKIN_IDLE_LIMIT_MS : deadline)) {
    assertCheckinActive(control);
    if (oauth) {
      const current = await chrome.tabs.get(tabId).catch(() => null);
      if (!current) throw new Error("访问登录页已关闭，未确认登录");
      await handleAgentRouterReauthTab(tabId, current.url);
      const pending = (await getAgentRouterPending())[tabId];
      if (!pending || !pending.callbackSeen) { await wait(800, control); continue; }
      const page = await chrome.tabs.get(tabId);
      if (page.status !== "complete" || new URL(page.url).origin !== pending.origin ||
          /^\/(login|signin|register|oauth)(\/|$)/i.test(new URL(page.url).pathname)) { await wait(800, control); continue; }
    }
    try {
      const user = await readVisitSession(platform, tabId, false, allowLoginPage, control);
      if (user && (!requireQuota || hasAccountQuota(user))) {
        if (!platform.userId || String(platform.userId).trim() === String(user.id)) markCheckinIdentity(control, user.id);
        if (requireQuota) markCheckinQuota(control, accountFromSelf(user));
        return user;
      }
      if (user && requireQuota) throw makeCheckinError("ACCOUNT_QUOTA_INVALID", "获取账户额度失败：账户已登录，但接口缺少有效余额或额度单位");
      mismatchSamples = 0;
    } catch (e) {
      assertCheckinActive(control);
      if (e.code === "SESSION_REQUEST_TIMEOUT") {
        if (++timeoutAttempts >= 3) throw e;
      } else if (e.code !== "SESSION_PAGE_PENDING" && (!oauth || e.code !== "ACCOUNT_MISMATCH" || ++mismatchSamples >= 12)) throw e;
      // 已导航的页面也可能先读到旧会话，给本站登录状态一个短暂的收敛窗口。
    }
    await wait(requireQuota ? 2000 : 800, control);
  }
  if (control) assertCheckinActive(control);
  throw checkinIdleError();
}

// 所有账户/日志请求固定使用本轮临时页，不重新开登录页或读取其他账号的页面。
async function readVisitApi(platform, tabId, reqPath, query, control = null) {
  await assertApiAllowed(platform, reqPath);
  const origin = new URL(platform.baseUrl).origin;
  const checkPage = async () => {
    const page = await chrome.tabs.get(tabId);
    if (!page.url || new URL(page.url).origin !== origin || page.status !== "complete" ||
        /^\/(login|signin|register|oauth)(\/|$)/i.test(new URL(page.url).pathname)) {
      throw new Error("刷新账户时页面登录状态已变化，页面已保留");
    }
  };
  const st = cookieStrategy(platform, platform.baseUrl);
  const spec = { target: { tabId }, world: "MAIN", func: tabFetchCheckin,
    args: [reqPath, "GET", null, String(platform.userId || ""), st.apiUserKey, query || null, "", origin] };
  let out;
  if (isAccountReadRequest(reqPath, "GET")) out = await executeAccountReadOnTab(platform, spec, control);
  else {
    await checkPage();
    await dismissSiteNotice(tabId, origin, control);
    out = await executeCheckinScript(spec, control);
  }
  await checkPage();
  const result = out && out[0] && out[0].result;
  if (!result || !result.ok || !result.body || result.body.success === false) {
    throw new Error(result && result.body && result.body.message || "无法获取最新账户数据");
  }
  return result.body;
}

function visitStage(platform, control, phase, message) {
  assertCheckinActive(control);
  markCheckinProgress(control, phase);
  if (control) control.stageLabel = message;
  try {
    chrome.runtime.sendMessage({ type: "visitProgress", id: platform.id, phase, message,
      stopVersion: control ? control.stopVersion : latestCheckinStopVersion }, () => { void chrome.runtime.lastError; });
  } catch {}
}
async function publishVisitBalance(platform, account, control) {
  assertCheckinActive(control);
  if (platform.id == null) return;
  await mutatePlatforms((list) => {
    assertCheckinActive(control);
    const current = list.find((entry) => entry.id === platform.id);
    if (current && sameTaskConfig(current, platform)) {
      current.account = { ...account };
      current.accountError = "";
    }
    return list;
  });
}

// 登录完成后只刷新本轮页面一次；所有取数均复用它，关闭后不再开页补取。
async function refreshLoginAccountOnTab(platform, tabId, readUser = null, control = null) {
  const page = await chrome.tabs.get(tabId);
  const origin = new URL(platform.baseUrl).origin;
  if (!page.url || new URL(page.url).origin !== origin) throw new Error("账户页面已跳转到其他站点");
  const onLoginPage = /^\/(login|signin|register|oauth)(\/|$)/i.test(new URL(page.url).pathname);
  const dashboard = isAgentRouterReauthMode(platform);
  visitStage(platform, control, "visit-refresh", "登录已确认，正在刷新本轮页面（仅一次）");
  // OAuth 常落在令牌页；在本轮页硬导航到看板，已在看板时只刷新一次。
  await waitVisitComplete(tabId, () => dashboard && !/^\/console\/?$/.test(new URL(page.url).pathname)
    ? chrome.tabs.update(tabId, { url: origin + "/console", active: false })
    : onLoginPage
      ? chrome.tabs.update(tabId, { url: origin + "/", active: false })
      : chrome.tabs.reload(tabId, { bypassCache: true }), control);
  // 公告由下面的身份/看板读取循环检查，避免一次性注入在刷新竞态中提前终止任务。
  const user = readUser || (dashboard
    ? () => waitAgentRouterAccountOnTab(platform, tabId, control)
    : () => waitVisitSession(platform, tabId, false, false, true, control));
  visitStage(platform, control, "visit-balance", "登录已确认，正在核验刷新后的账号并读取余额");
  const freshUser = await user();
  // 余额独立落盘；日志失败或最终复核失败不丢失这个已核验、有时间戳的快照。
  await publishVisitBalance(platform, accountFromSelf(freshUser), control);
  visitStage(platform, control, "visit-logs", "余额已获取，正在统计本月 Token（最多 20 秒）");
  const read = (reqPath, query, readControl = control) => readVisitApi(platform, tabId, reqPath, query, readControl);
  const account = await fetchAccount(platform, currentMonth(), freshUser, read, control);
  if (freshUser._dashboardWarning) account._warn = [freshUser._dashboardWarning, account._warn].filter(Boolean).join("；");
  // 日志取数期间会话可能变化；关闭前再次核验同一页面显示的身份及余额。
  visitStage(platform, control, "visit-final-identity", "余额已保存，正在最终核验账号");
  const finalUser = await user();
  return Object.assign(account, accountFromSelf(finalUser, account.monthlyTokens, account.tokensTruncated, account._warn));
}

// 只读刷新后的数据看板 DOM；localStorage 仅用于身份/显示单位，不从中取余额。
function tabReadAgentRouterDashboard(expectedOrigin, configuredUserId) {
  const fail = (message) => ({ ok: false, message });
  if (location.origin !== expectedOrigin || !/^\/console\/?$/.test(location.pathname)) {
    return fail("尚未进入本站数据看板");
  }
  if (document.readyState !== "complete") return fail("数据看板仍在加载");
  let user;
  try { user = JSON.parse(localStorage.getItem("user") || "null"); } catch {}
  if (!user || !["number", "string"].includes(typeof user.id) || !/^\d+$/.test(String(user.id))) {
    return fail("数据看板未显示有效登录账号");
  }
  const actual = String(user.id), configured = String(configuredUserId || "").trim();
  if (configured && actual !== configured) {
    return { ok: false, userMismatch: true, configuredUserId: configured, actualUserId: actual };
  }
  const visible = (el) => {
    if (!el || !el.getClientRects().length) return false;
    const style = getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
  };
  // 缓存身份须与页面正在显示的用户名共同匹配，不能只凭旧 localStorage 判断账号。
  const names = [user.username, user.display_name].filter((name) => typeof name === "string" && name.trim());
  const identityShown = [...document.querySelectorAll("h1, h2, h3, button, .semi-dropdown span")].some((el) =>
    visible(el) && names.some((name) => String(el.textContent || "").split(/[\s,，:：!！]+/).includes(name)));
  if (!identityShown) return fail("数据看板显示的账号尚未与登录账号一致");
  const cards = [...document.querySelectorAll(".semi-card")].filter(visible);
  const valueFor = (labels) => {
    for (const card of cards) {
      if (card.getAttribute("aria-busy") === "true" || card.querySelector('[aria-busy="true"], .semi-skeleton, .semi-spin-spinning')) continue;
      for (const label of card.querySelectorAll("div, span, p")) {
        if (label.children.length || !visible(label) || !labels.includes(String(label.textContent || "").trim())) continue;
        // 标签和金额必须是同一行的相邻节点，不能混入别的卡片/统计周期。
        const value = label.nextElementSibling;
        if (visible(value)) return String(value.textContent || "").trim();
      }
    }
    return null;
  };
  const parseNumber = (text, money = false) => {
    if (!text) return null;
    const compact = text.replace(/\s/g, "");
    const match = compact.match(/^([+-]?)(\$|US\$|USD)?([+-]?)(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?([kKmMbB])?$/);
    if (!match || (match[1] && match[3]) || (!money && (match[2] || match[6]))) return null;
    const sign = (match[1] || match[3]) === "-" ? -1 : 1;
    let value = sign * Number(match[4].replace(/,/g, "") + (match[5] ? "." + match[5] : ""));
    if (match[2]) {
      if (match[6]) return null; // 拒绝币种与缩写混合，避免倍率歧义。
      const unitText = String(localStorage.getItem("quota_per_unit") || "").trim();
      if (!/^[1-9]\d*$/.test(unitText)) return null;
      const unit = Number(unitText);
      if (!Number.isSafeInteger(unit) || unit <= 0) return null;
      value *= unit;
    } else if (match[6]) {
      value *= { k: 1e3, m: 1e6, b: 1e9 }[match[6].toLowerCase()];
    } else if (money && localStorage.getItem("display_in_currency") === "true") {
      return null; // 开启金额显示却缺少币种，可能是尚未渲染的占位符。
    }
    return Number.isFinite(value) ? value : null;
  };
  const balanceText = valueFor(["当前余额", "Current balance", "Current Balance"]);
  const quota = parseNumber(balanceText, true);
  if (quota === null) return fail("数据看板尚未显示有效当前余额（或显示单位不可识别）");
  const usedText = valueFor(["历史消耗", "Consumption", "Historical consumption", "Total consumption"]);
  const requestsText = valueFor(["请求次数", "Request count", "Request Count", "Requests"]);
  return { ok: true, body: { success: true, data: {
    id: user.id, username: user.username || "", display_name: user.display_name || "",
    quota, used_quota: parseNumber(usedText, true), request_count: parseNumber(requestsText),
    quota_per_unit: Number(localStorage.getItem("quota_per_unit")),
    _accountSource: "dashboard", _availableDisplay: balanceText,
    _dashboardWarning: "额度来自刷新后的看板显示，精度以页面为准（金额通常保留两位小数）",
  } } };
}

async function waitAgentRouterAccountOnTab(platform, tabId, control = null) {
  let lastMessage = "";
  for (let i = 0; i < 5; i++) {
    const page = await chrome.tabs.get(tabId);
    if (!page.url || new URL(page.url).origin !== new URL(platform.baseUrl).origin) throw new Error("账户页面已跳转到其他站点");
    if (page.status === "complete" && !/^\/(login|signin|register|oauth)(\/|$)/i.test(new URL(page.url).pathname)) {
      let result;
      try {
        await dismissSiteNotice(tabId, platform.baseUrl, control);
        const out = await executeCheckinScript({ target: { tabId }, world: "MAIN", func: tabReadAgentRouterDashboard,
          args: [new URL(platform.baseUrl).origin, String(platform.userId || "").trim()] }, control);
        result = out && out[0] && out[0].result;
      } catch {} // 刷新后的 SPA 可能仍在初始化，不能退回缓存。
      if (result && result.message) lastMessage = result.message;
      if (result && result.userMismatch) throw accountMismatchError(platform.userId, result.actualUserId);
      const body = result && result.ok && result.body && result.body.success !== false && result.body;
      if (body && body.data && ["number", "string"].includes(typeof body.data.id) && /^\d+$/.test(String(body.data.id))) {
        verifyConfiguredUser(platform, body);
        const latest = await chrome.tabs.get(tabId);
        if (!latest.url || new URL(latest.url).origin !== new URL(platform.baseUrl).origin) throw new Error("身份核验期间页面已跳转到其他站点");
        if (latest.status === "complete" && !/^\/(login|signin|register|oauth)(\/|$)/i.test(new URL(latest.url).pathname) && hasAccountQuota(body.data)) {
          const account = accountFromSelf(body.data);
          const usedIsNumber = typeof account.used === "number" ||
            (typeof account.used === "string" && account.used.trim() !== "");
          // 双零可能是看板尚未更新的初始值；不要立刻确认成功或覆盖已保存额度。
          if (Number(account.available) === 0 && usedIsNumber && Number(account.used) === 0) {
            lastMessage = "可用余额和已用余额都为 0，尚未确认余额加载完成";
          } else {
            return body.data;
          }
        }
      }
    }
    if (i < 4) await wait(2000, control);
  }
  throw new Error("数据看板余额读取已尝试 5 次仍未完成" + (lastMessage ? "：" + lastMessage : "") + "，请检查页面登录状态、加载或安全验证后重试");
}

async function initialVisitSession(platform, tabId, control) {
  const deadline = Date.now() + CHECKIN_IDLE_LIMIT_MS;
  let navigationDeadline = null, timeoutAttempts = 0;
  for (;;) {
    try { return await readVisitSession(platform, tabId, true, false, control); }
    catch (error) {
      assertCheckinActive(control);
      if (error.code === "SESSION_REQUEST_TIMEOUT") {
        if (++timeoutAttempts >= 3 || Date.now() >= deadline) throw error;
      } else if (error.code !== "SESSION_PAGE_PENDING") throw error;
      else {
        if (navigationDeadline == null) navigationDeadline = Date.now() + 12000;
        if (Date.now() >= navigationDeadline) throw new Error("账户页面导航未稳定，已保留页面；未退出登录或重复刷新");
      }
      if (Date.now() >= deadline) throw new Error("账户页面导航未稳定，已保留页面；未退出登录或重复刷新");
      await wait(300, control);
    }
  }
}

// Always close owned pages and discard in-memory tokens; server logout is explicitly opt-in.
// Cleanup is independent of cancellation. Never inject logout into an OAuth provider.
async function cleanupVisitSession(platform, tabId) {
  const origin = new URL(platform.baseUrl).origin;
  let cleanupTabId = tabId;
  const warnings = [];
  try {
    if (AUTH_CONFIG.shouldLogoutAfterVisit(platform)) {
      const page = await chrome.tabs.get(tabId).catch(() => null);
      if (!page || !page.url || new URL(page.url).origin !== origin) {
        const page = await chrome.tabs.create({ url: origin + "/", active: false });
        cleanupTabId = page.id;
        await waitVisitComplete(cleanupTabId, null, null, 12000);
      }
      let timer, out;
      try {
        out = await Promise.race([
          executeCheckinScript({ target: { tabId: cleanupTabId }, world: "MAIN", func: tabLogout, args: ["", origin] }),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("退出请求超时")), 15000); }),
        ]);
      } finally { clearTimeout(timer); }
      if (!out || !out[0] || !out[0].result || !out[0].result.ok) {
        const result = out && out[0] && out[0].result;
        const detail = result && result.body && result.body.message;
        warnings.push("退出账号未确认成功，请检查本站会话" + (result && result.status ? "（HTTP " + result.status + "）" : "") +
          (typeof detail === "string" ? "：" + detail.slice(0, 240) : ""));
      }
    }
  } catch (error) {
    warnings.push("退出账号失败：" + (error.message || "请求失败"));
  } finally {
    clearSiteSessionTokens(origin);
    for (const id of new Set([tabId, cleanupTabId])) {
      try { await chrome.tabs.remove(id); }
      catch { if (await chrome.tabs.get(id).catch(() => null)) warnings.push("临时页关闭失败，请手动关闭"); }
    }
  }
  return warnings.join("；");
}

async function runVisitOnly(platform, options, control = null) {
  validatePlatform(platform);
  const origin = new URL(platform.baseUrl).origin;
  const home = origin + "/";
  if (visitOnlyOrigins.has(origin) || passwordLoginInflight.has(origin) || agentRouterStarting.has(origin)) {
    throw new Error("本站有其他访问或登录任务尚未完成，请稍后重试");
  }
  visitOnlyOrigins.add(origin);
  let tab, outcome, failure, oauth = false;
  try {
    await waitForAgentRouterTurn(platform, false, control);
    assertCheckinActive(control);
    visitStage(platform, control, "visit-open", "正在打开本站页面");
    tab = await chrome.tabs.create({ url: home, active: false });
    if (!tab || tab.id == null) throw new Error("无法创建访问页面");
    await waitVisitComplete(tab.id, null, control);
    visitStage(platform, control, "visit-session", "页面已打开，正在检查公告和登录账号");
    const user = await initialVisitSession(platform, tab.id, control);
    // 与普通任务一致：依赖登录回调的站点需要重新登录，不能用旧会话跳过该动作。
    const reauth = !!(options && options.reauth);
    const forceLogin = reauth && (isAgentRouterReauthMode(platform) ||
      (platform.authMode === "password" && isSelfTriggerMode(platform)));
    if (!user || forceLogin) {
      visitStage(platform, control, "visit-login", user && forceLogin ? "账号已登录，正在按站点策略重新登录或授权" : "需要登录，请完成本站登录或授权");
      if (platform.authMode === "password") {
        await loginPasswordOnTab(platform, tab, forceLogin, control);
      } else {
        if (isAgentRouterReauthMode(platform)) {
          // 进入 OAuth 就必须退出旧站点会话，即使它属于另一提供方/账号。
          const out = await executeCheckinScript({ target: { tabId: tab.id }, world: "MAIN", func: tabLogout }, control);
          if (!out || !out[0] || !out[0].result || !out[0].result.ok) throw new Error("无法退出旧登录会话，页面已保留");
          clearSiteSessionTokens(origin);
          oauth = true;
          await updateAgentRouterPending(tab.id, { tabId: tab.id, base: platform.baseUrl, origin,
            platformId: platform.id || null, userId: String(platform.userId || ""), authMode: platform.authMode,
            provider: agentRouterProvider(platform), visitOnly: true, oauthStarted: false, createdAt: Date.now(),
            stopVersion: control ? control.stopVersion : latestCheckinStopVersion,
            token: control ? control.token : null, lastProgressAt: Date.now(), phase: "oauth-starting" }, null, true);
        }
        await chrome.tabs.update(tab.id, { url: origin + "/login", active: true });
        await waitVisitComplete(tab.id, null, control);
      }
      await waitVisitSession(platform, tab.id, oauth, true, false, control);
    }
    assertCheckinActive(control);
    const account = await refreshLoginAccountOnTab(platform, tab.id, null, control);
    const previous = platform.account && platform.account.available;
    const quotaDelta = previous != null && previous !== "" && Number.isFinite(Number(previous))
      ? Number(account.available) - Number(previous) : null;
    // 先发布最新账户信息，让侧边栏/管理页同步额度，再关闭临时页。
    assertCheckinActive(control);
    await mutatePlatforms((list) => {
      assertCheckinActive(control);
      const current = list.find((entry) => entry.id === platform.id);
      if (current && sameTaskConfig(current, platform)) {
        current.account = Object.assign({}, current.account || {}, account);
        current.accountError = "";
      }
      return list;
    });
    if (oauth) { await updateAgentRouterPending(tab.id, null); oauth = false; }
    visitStage(platform, control, "visit-close", AUTH_CONFIG.shouldLogoutAfterVisit(platform)
      ? "最新余额已保存，正在退出账号并关闭本轮临时页" : "最新余额已保存，正在关闭本轮临时页（不退出账号）");
    outcome = { ok: true, visited: true, outcome: "visited", message: "登录及刷新完成，最新额度已更新（已跳过签到接口）" + (account._warn ? "；" + account._warn : ""),
      data: null, account, quotaDelta, lastVisitedAt: new Date().toISOString(), lastVisitDate: todayStr() };
    return outcome;
  } catch (error) {
    failure = error;
    if (control && control.stageLabel) error.message = control.stageLabel + "：" + error.message;
    throw error;
  } finally {
    try {
      if (oauth && tab) await updateAgentRouterPending(tab.id, null).catch(() => {});
      if (tab) {
        const warning = await cleanupVisitSession(platform, tab.id);
        const message = warning || (AUTH_CONFIG.shouldLogoutAfterVisit(platform)
          ? "已退出账号并关闭本轮临时页" : "未主动退出账号，已关闭本轮临时页");
        if (outcome) outcome.message += "；" + message;
        if (failure) failure.message = failure.message.replace(/页面已保留|已保留页面|保留的页面/g, "本轮临时页") + "；" + message;
      }
    } finally {
    try { chrome.runtime.sendMessage({ type: "visitProgress", id: platform.id, phase: "done", message: "",
      stopVersion: control ? control.stopVersion : latestCheckinStopVersion }, () => { void chrome.runtime.lastError; }); } catch {}
      visitOnlyOrigins.delete(origin);
    }
  }
}

// 签到 / 仅访问
async function runCheckin(platform, options) {
  const control = options && options.control || null;
  try {
    assertCheckinActive(control);
    platform = await resolveSavedVisitOnly(platform);
    if (isVisitOnly(platform)) return await runVisitOnly(platform, options, control);
    // Agent Router 通过退出并重新登录签到；其他自触发兼容站点仍使用 GET 请求。
    const isSelfTrigger = isSelfTriggerMode(platform);
    const method = isSelfTrigger ? "GET" : "POST";
    let body;
    try {
      body = await callCheckin(platform, method, null, {
        reauth: !!(options && options.reauth), control,
      });
    } catch (e) {
      assertCheckinActive(control);
      if (!isTurnstileMissingMessage(e && e.message)) throw e;
      body = await runTurnstileCheckin(platform, control);
    }
    let data = body.data;
    // 部分兼容站点的 POST 只返回奖励额度；追加一次只读 GET，补齐本月统计。
    if (!isSelfTrigger && !(data && data.stats)) {
      try {
        assertCheckinActive(control);
        const statsBody = await callCheckin(platform, "GET", currentMonth(), { control });
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
        reauthRequired: true, reauthStartedAt: body._reauthStartedAt, reauthTabId: body._reauthTabId, oauthLoginStarted: !!body._oauthLoginStarted, githubLoginStarted: !!body._githubLoginStarted };
    }
    // 仅仅读取 Agent Router 用户信息不能证明签到。
    if (isAgentRouterReauthMode(platform)) throw new Error("当前操作仅刷新了账户信息，未执行重登录签到");
    if (!msg) {
      if (awarded != null) msg = "签到成功，获得额度 " + awarded;
      else if (isSelfTrigger) msg = (uname ? "用户「" + uname + "」" : "") + "信息请求成功，签到已自动完成";
      else msg = "签到请求成功";
    }
    let account = null, accountWarning = "";
    try { account = await fetchAccount(platform, currentMonth(), null, null, control); }
    catch (e) { accountWarning = "签到已完成，但额度刷新失败：" + e.message; }
    return {
      ok: true,
      message: accountWarning ? msg + "｜" + accountWarning : msg,
      data,
      account,
      accountWarning,
      reauthRequired: !!body._reauthRequired,
      githubLoginStarted: !!body._githubLoginStarted,
    };
  } catch (e) {
    if (control && isCheckinControlError(e)) throw e;
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
async function fetchMonthlyTokens(platform, month, read, control = null) {
  const { start, end } = monthRangeTs(month);
  let tokens = 0, total = null, page = 1, guard = 0, truncated = false;
  const per = 100;
  const deadline = Date.now() + 20000;
  for (;;) {
    if (++guard > 40) { truncated = true; break; }
    let body;
    try {
      const query = { start_timestamp: start, end_timestamp: end, type: 0, p: page, per };
      assertCheckinActive(control);
      body = await withLogReadBudget((readControl) => read
        ? read("/api/log/self", query, readControl)
        : callApi(platform, "/api/log/self", "GET", { query, control: readControl }), control, deadline - Date.now());
      assertCheckinActive(control);
    } catch (e) {
      if (isCheckinControlError(e)) throw e;
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

async function fetchAccount(platform, month, reuseSelfData, read, control = null) {
  validatePlatform(platform);
  if (!read && await isAgentRouterReauthPending(platform)) {
    throw new Error("Agent Router 正在重新登录，请在登录完成后刷新额度");
  }
  let selfData = reuseSelfData || null;
  if (selfData) verifyConfiguredUser(platform, { data: selfData });
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
          (platform.baseUrl || "").trim().replace(/\/+$/, ""), false, control,
        );
        selfBody = result.body;
        accountWarn = result.warning || "";
      } else {
        selfBody = await callApi(platform, "/api/user/self", "GET", { control });
      }
      verifyConfiguredUser(platform, selfBody);
      selfData = (selfBody && selfBody.data) || null;
    } catch (e) {
      if (isCheckinControlError(e) || (e && e.code === "ACCOUNT_MISMATCH")) throw e;
      selfErr = e && e.message ? e.message : String(e); selfData = null;
    }
  }
  if (!selfData || !hasAccountQuota(selfData)) throw new Error("获取账户额度失败：" + (selfErr || "在线账户未返回有效额度"));
  let monthlyTokens = null, tokensTruncated = false, tokenErr = "";
  try {
    const r = await fetchMonthlyTokens(platform, month, read, control);
    if (r) { monthlyTokens = r.tokens; tokensTruncated = !!r.truncated; }
    else tokenErr = "日志接口无数据";
  } catch (e) { if (isCheckinControlError(e)) throw e; tokenErr = e && e.message ? e.message : String(e); }
  const warnings = [];
  if (accountWarn) warnings.push(accountWarn);
  if (tokensTruncated) warnings.push("本月Token为前若干页累计估算（超出截断）");
  else if (monthlyTokens == null) warnings.push("本月Token接口不可用" + (tokenErr ? "（" + tokenErr + "）" : ""));
  const account = accountFromSelf(selfData, monthlyTokens, tokensTruncated, warnings.join("；"));
  await recordAccountHistorySample(platform, account, month);
  return account;
}

function strictAccountNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || !/^[+-]?(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+)$/.test(text)) return null;
  const n = Number(text.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}
function accountQuotaPerUnit(data) {
  if (!data) return 500000;
  let raw;
  for (const key of ["quota_per_unit", "quotaPerUnit"]) {
    if (Object.prototype.hasOwnProperty.call(data, key) && data[key] != null && data[key] !== "") { raw = data[key]; break; }
  }
  if (raw === undefined) return 500000; // 兼容没有携带单位的旧账户响应。
  const n = strictAccountNumber(raw);
  return n != null && n > 0 ? n : null;
}
function accountValue(data, names) {
  if (!data) return null;
  for (const name of names) {
    if (!Object.prototype.hasOwnProperty.call(data, name)) continue;
    const value = strictAccountNumber(data[name]);
    if (value != null) return value;
  }
  return null;
}
function hasAccountQuota(data) {
  const account = accountFromSelf(data);
  return account.available != null && account.quotaPerUnit != null;
}

function accountFromSelf(selfData, monthlyTokens = null, tokensTruncated = false, warning = "") {
  return {
    updatedAt: new Date().toISOString(),
    userId: selfData && selfData.id != null ? String(selfData.id) : null,
    available: accountValue(selfData, ["quota", "available", "available_quota", "remaining_quota"]),
    used: accountValue(selfData, ["used_quota", "usedQuota", "used"]),
    requestCount: accountValue(selfData, ["request_count", "requestCount"]),
    quotaPerUnit: accountQuotaPerUnit(selfData),
    monthlyTokens,
    tokensTruncated,
    displayName: selfData ? (selfData.display_name || selfData.displayName || selfData.username) : null,
    _warn: warning,
    ...(selfData && selfData._accountSource === "dashboard" ? {
      source: "dashboard", availableDisplay: selfData._availableDisplay,
    } : {}),
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
// 模型只读响应格式独立；与账户通道共用会话令牌换取逻辑。
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
function tabRefreshAuthToken(expectedOrigin = "", checkinToken = "") {
  return (async () => {
    if (expectedOrigin && location.origin !== expectedOrigin) return { status: 403, message: "会话页面已跳转到其他站点" };
    const controller = new AbortController();
    const onStop = (event) => { if (checkinToken && event.detail === checkinToken) controller.abort(); };
    if (checkinToken && window.__nacheckinCancelledCheckinToken === checkinToken) return { cancelled: true };
    window.addEventListener("nacheckin:checkin-stop", onStop);
    const timer = setTimeout(() => controller.abort(), 12000);
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
        body: "{}", signal: controller.signal, mode: "same-origin",
      });
      const text = await res.text();
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch {}
      const data = body && body.data ? body.data : null;
      return {
        status: res.status,
        httpOk: res.ok,
        success: body ? body.success !== false : false,
        token: data && data.access_token ? String(data.access_token) : "",
        expiresAt: data && data.access_expires_at != null ? Number(data.access_expires_at) : null,
        sessionId: data && data.session && typeof data.session.sid === "string" ? data.session.sid : "",
        htmlResponse: /text\/html/i.test(res.headers.get("content-type") || "") || /^\s*</.test(text),
        message: body && body.message ? String(body.message) : "",
        code: body && body.code ? String(body.code) : "",
      };
    } catch (e) {
      return { status: 0, httpOk: false, timedOut: controller.signal.aborted,
        netError: "会话认证请求失败：" + (e && e.message ? e.message : "无法连接站点") };
    } finally {
      clearTimeout(timer); window.removeEventListener("nacheckin:checkin-stop", onStop);
    }
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
async function acquireSessionToken(tabId, key, staleToken, control = null, expectedOrigin = "") {
  const cached = readSessionToken(key);
  if (cached && cached !== staleToken) return { ok: true, token: cached };
  const running = sessionTokenInflight.get(key);
  if (running) return await running;
  const task = (async () => {
    let out;
    try {
      out = await executeCheckinScriptRaw({ target: { tabId }, func: tabRefreshAuthToken, args: [expectedOrigin, ""] }, control);
    } catch (e) {
      assertCheckinActive(control);
      return { ok: false, message: "在站点标签页换取会话令牌失败：" + (e && e.message ? e.message : "请先在浏览器登录该站点") };
    }
    const r = (out && out[0] && out[0].result) || null;
    if (!r) return { ok: false, message: "站点标签页没有返回会话令牌" };
    if (r.netError) return { ok: false, status: 0, timedOut: r.timedOut, message: r.netError };
    if (!r.httpOk || !r.success || !r.token) {
      sessionTokenCache.delete(key);
      if (r.status === 404) {
        return { ok: false, status: 404, message: "该站点没有 /api/user/auth/refresh 接口，无法用登录状态读取后台指标。" };
      }
      const hint = CODE_HINTS[r.code || ""] || "";
      const detail = r.message || "HTTP " + r.status;
      return {
        ok: false,
        status: r.status, htmlResponse: r.htmlResponse,
        message: "无法用登录状态换取会话令牌（" + detail + "）" + (hint ? " ｜ " + hint : "") +
          "，请先在浏览器中打开并登录该站点，然后重试。",
      };
    }
    sessionTokenCache.set(key, { token: r.token, expiresAt: normalizeTokenExpiry(r.expiresAt), sessionId: r.sessionId || "" });
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
    await dismissSiteNotice(tab.id, origin);
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
async function keepAliveFetch(url, init, control = null) {
  assertCheckinActive(control);
  const ctl = new AbortController();
  const stop = () => ctl.abort();
  if (control) control.controller.signal.addEventListener("abort", stop, { once: true });
  const timer = setTimeout(stop, 15000);
  try {
    const res = await fetch(url, Object.assign({}, init, { signal: ctl.signal }));
    const text = await res.text();
    assertCheckinActive(control);
    markCheckinProgress(control, "keepalive-response", true);
    return { ok: res.ok, status: res.status, text: async () => text };
  } catch (e) {
    assertCheckinActive(control);
    markCheckinProgress(control, "keepalive-attempt-finished", true);
    if (ctl.signal.aborted) throw new Error("保活请求超时（15 秒，含响应读取）");
    throw new Error("网络请求失败：" + ((e && e.message) || "无法连接站点"));
  } finally {
    clearTimeout(timer);
    if (control) control.controller.signal.removeEventListener("abort", stop);
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
async function attemptKeepAlive(format, url, key, model, control = null) {
  const res = await keepAliveFetch(url, {
    method: "POST",
    credentials: "omit",
    headers: keepAliveHeaders(format, key),
    body: JSON.stringify(keepAliveBody(format, model)),
  }, control);
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
async function fetchKeepAliveModels(format, key, url, control = null) {
  const root = keepAliveModelsRoot(url);
  if (!root) throw new Error("无法根据调用网址推导模型列表地址");
  const headers = { Accept: "application/json, text/plain, */*" };
  if (format === "message") {
    headers["anthropic-version"] = "2023-06-01";
    if (key) headers["x-api-key"] = key;
  } else if (key) {
    headers["Authorization"] = "Bearer " + key;
  }
  const res = await keepAliveFetch(root + "/models", { method: "GET", credentials: "omit", headers }, control);
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
async function retryKeepAliveWithModels(format, url, key, tried, control = null) {
  let pool = [];
  try {
    pool = await fetchKeepAliveModels(format, key, url, control);
  } catch (e) {
    assertCheckinActive(control);
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
      const r = await attemptKeepAlive(format, url, key, pick, control);
      if (r.ok) return { ok: true, model: pick };
      lastError = r.message || ("HTTP " + r.status);
    } catch (e) {
    assertCheckinActive(control);
      lastError = e && e.message ? e.message : String(e);
    }
    if (i < attempts - 1) await wait(700, control);
  }
  return { ok: false, tried: used, error: lastError };
}
async function runKeepAliveCall(p, control = null) {
  if (control) { control.stageLabel = "正在执行已启用的 API 保活（不是签到接口）"; markCheckinProgress(control, "keepalive-start"); }
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
    first = await attemptKeepAlive(format, url, key, ka.model || DEFAULT_KEEPALIVE_MODEL, control);
  } catch (e) {
    assertCheckinActive(control);
    first = { ok: false, status: 0, message: e && e.message ? e.message : "调用失败", model: ka.model || DEFAULT_KEEPALIVE_MODEL };
  }
  tried.push(first.model);
  if (first.ok) return { ok: true, model: first.model, message: "自动调用API成功" };
  if (isModelRejection(first.status, first.message)) {
    const fb = await retryKeepAliveWithModels(format, url, key, tried, control);
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
async function runBatchCheckinOne(partial, control = null) {
  if (!partial || partial.id == null) return await runCheckin(partial || {}, { reauth: true, control });
  const cur = await getPlatforms();
  const stored = cur.find((x) => x.id === partial.id);
  if (!stored) return await runCheckin(partial, { reauth: true, control });
  let alive = null;
  if (needsKeepAliveToday(stored)) {
    alive = await runKeepAliveCall(stored, control);
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
  const r = await waitForCheckinCompletion(stored, await runCheckin(stored, { reauth: true, control }), control);
  const ka = getKeepAlive(stored);
  if (alive) {
    const part = alive.ok
      ? "自动调用API成功" + (alive.model ? "（模型 " + alive.model + "）" : "")
      : "自动调用API失败：" + alive.message + (isVisitOnly(stored) ? "（仍执行仅访问）" : "（仍执行签到）");
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

// 全局签到队列：跨域、令牌、手动、批量和自动任务共用，OAuth pending 不是出队条件。
let checkinTaskQueue = Promise.resolve();
let checkinEnqueueQueue = Promise.resolve();
async function waitCheckinInterval(control) {
  const settings = await getSettings();
  const finishedAt = await getStore(KEY_CHECKIN_FINISHED_AT, null);
  const deadline = typeof finishedAt === "number" && Number.isFinite(finishedAt) && finishedAt > 0
    ? Math.min(finishedAt, Date.now()) + settings.checkinIntervalSeconds * 1000 : 0;
  const assertGeneration = () => {
    if (control.controller.signal.aborted || control.stopVersion !== latestCheckinStopVersion) throw checkinCancelledError();
  };
  for (;;) {
    assertGeneration();
    const remaining = deadline - Date.now();
    if (remaining <= 0) return;
    await new Promise((resolve, reject) => {
      const signal = control.controller.signal;
      const onAbort = () => { clearTimeout(timer); signal.removeEventListener("abort", onAbort); reject(checkinCancelledError()); };
      const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, Math.min(remaining, 20000));
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    // 不向站点发请求。读取扩展存储维持后台存活，同时复核持久化的停止代数。
    latestCheckinStopVersion = normalizeStopVersion(await getStore(KEY_CHECKIN_STOP_VERSION, latestCheckinStopVersion));
  }
}
function enqueueCheckinTask(platform, fn, requestedStopVersion) {
  let task;
  // 在消息到达时捕获停止代数，而不是等前一个长任务结束后才捕获。
  const reservation = checkinEnqueueQueue.catch(() => {}).then(async () => {
    await checkinStopVersionReady;
    const storedVersion = normalizeStopVersion(await getStore(KEY_CHECKIN_STOP_VERSION, latestCheckinStopVersion));
    latestCheckinStopVersion = storedVersion;
    const hasExplicitVersion = requestedStopVersion !== undefined && requestedStopVersion !== null;
    if (hasExplicitVersion && (typeof requestedStopVersion !== "number" || !Number.isSafeInteger(requestedStopVersion) || requestedStopVersion !== storedVersion)) {
      throw checkinCancelledError();
    }
    const control = { stopVersion: storedVersion, controller: new AbortController(), timedOut: false, waitingToStart: true,
      lastProgressAt: Date.now(), phase: "queued", idleTimer: null,
      visitOnly: isVisitOnly(platform), token: String(Date.now()) + "-" + Math.random().toString(36).slice(2), pageTabIds: new Set(), pageWorlds: new Map() };
    control.abortListener = () => broadcastCheckinPageStop(control);
    control.controller.signal.addEventListener("abort", control.abortListener, { once: true });
    if (platform && platform.account) {
      const account = platform.account;
      if (account.available != null && account.quotaPerUnit != null) control.lastQuotaKey = [account.available, account.used, account.quotaPerUnit].join("|");
    }
    task = checkinTaskQueue.catch(() => {}).then(async () => {
      activeCheckinControl = control;
      let started = false;
      try {
        if (platform) await waitCheckinInterval(control);
        if (control.controller.signal.aborted || control.stopVersion !== latestCheckinStopVersion) throw checkinCancelledError();
        return await withPlatformSession(platform, async () => {
          if (control.controller.signal.aborted || control.stopVersion !== latestCheckinStopVersion) throw checkinCancelledError();
          started = true;
          control.waitingToStart = false;
          markCheckinProgress(control, "starting");
          try {
            assertCheckinActive(control);
            // 重启/唤醒后也先接管持久化的 OAuth 任务，不能因内存队列丢失而并发切换。
            let recoveredPending = false;
            for (const pending of Object.values(await getAgentRouterPending()).sort((a, b) => a.createdAt - b.createdAt)) {
              assertCheckinActive(control);
              await waitForPendingOauth(pending, control);
              recoveredPending = true;
            }
            if (recoveredPending && platform) {
              // 恢复的前一项真正结束后也必须留出间隔，不能用它结束前的旧时间绕过。
              clearTimeout(control.idleTimer);
              control.idleTimer = null;
              control.waitingToStart = true;
              started = false;
              await setStore({ [KEY_CHECKIN_FINISHED_AT]: Date.now() });
              await waitCheckinInterval(control);
              started = true;
              control.waitingToStart = false;
              markCheckinProgress(control, "starting-after-recovery");
            }
            let current = platform;
            if (platform && platform.id != null) {
              current = (await getPlatforms()).find((p) => p.id === platform.id);
              if (!current) throw new Error("平台已删除，本次排队任务已取消");
              // 旧界面遗漏仅访问标记时仍以保存配置为准；其他凭据变化不执行旧任务。
              if (!sameTaskConfig(current, { ...platform, visitOnly: current.visitOnly })) {
                throw new Error("平台鉴权配置已变更，本次排队任务已取消，请重新执行");
              }
            }
            assertCheckinActive(control);
            const result = await fn(current, control);
            assertCheckinActive(control);
            return result;
          } catch (error) {
            if (error && error.code === "CHECKIN_IDLE_TIMEOUT") await finalizeIdleCheckin(control, platform);
            throw error;
          }
        });
      } finally {
        finishCheckinControl(control);
        // 包含失败项；仅排队/间隔时取消不延长冷却。保存和关页都已完成才开始计时。
        if (started && platform) await setStore({ [KEY_CHECKIN_FINISHED_AT]: Date.now() });
      }
    });
    checkinTaskQueue = task.catch(() => {}); // 一个任务失败不阻塞后续项。
  });
  checkinEnqueueQueue = reservation.catch(() => {});
  return reservation.then(() => task);
}

async function finalizeIdleCheckin(control, platform) {
  const all = await getAgentRouterPending();
  const message = checkinIdleError().message;
  for (const pending of Object.values(all)) {
    if (pending.stopVersion != null && Number(pending.stopVersion) !== control.stopVersion) continue;
    const ownTask = pending.token != null && pending.token === control.token;
    const expired = Date.now() - Number(pending.lastProgressAt || pending.createdAt || 0) >= CHECKIN_IDLE_LIMIT_MS;
    if (!ownTask && !expired) continue;
    if (!pending.visitOnly) await saveAgentRouterLoginOutcome(pending, null, message);
    await updateAgentRouterPending(pending.tabId, null, pending);
  }
  if (!platform || platform.id == null || isVisitOnly(platform)) return;
  await mutatePlatforms((list) => {
    const current = list.find((entry) => entry.id === platform.id);
    if (!current || !sameTaskConfig(current, platform)) return list;
    if (current.reauthPending && current.reauthStartedAt != null) {
      const related = Object.values(all).some((pending) => pending.platformId === current.id &&
        Number(pending.createdAt) === Number(current.reauthStartedAt) && (pending.token === control.token ||
          Date.now() - Number(pending.lastProgressAt || pending.createdAt || 0) >= CHECKIN_IDLE_LIMIT_MS));
      if (!related) return list;
      current.reauthPending = false;
    }
    current.message = message;
    current.error = message;
    // Do not change stats/account: a read timeout cannot undo a previously confirmed check-in.
    return list;
  });
}

async function waitForPendingOauth(pending, control = activeCheckinControl) {
  while (true) {
    assertCheckinActive(control);
    const current = (await getAgentRouterPending())[pending.tabId];
    if (!current || !samePendingGeneration(current, pending)) {
      const processing = agentRouterReauthQueues.get(pending.tabId);
      if (processing) await processing;
      return;
    }
    const idleSince = Number(current.lastProgressAt || current.createdAt || Date.now());
    if (Date.now() - idleSince >= CHECKIN_IDLE_LIMIT_MS) {
      const message = "OAuth 登录同一阶段连续 60 秒无有效进展，页面已保留";
      await saveAgentRouterLoginOutcome(current, null, message);
      await updateAgentRouterPending(current.tabId, null, current);
      return;
    }
    const tab = await chrome.tabs.get(current.tabId).catch(() => null);
    if (!tab) {
      await saveAgentRouterLoginOutcome(current, null, "登录页已关闭，尚未确认签到，请重新执行");
      await updateAgentRouterPending(current.tabId, null, current);
      return;
    }
    await handleAgentRouterReauthTab(current.tabId, tab.url || "");
    assertCheckinActive(control);
    const latest = (await getAgentRouterPending())[current.tabId];
    if (!latest || !samePendingGeneration(latest, current)) {
      const processing = agentRouterReauthQueues.get(current.tabId);
      if (processing) await processing;
      return;
    }
    const latestProgress = Number(latest.lastProgressAt || latest.createdAt || Date.now());
    await wait(Math.min(1200, Math.max(1, CHECKIN_IDLE_LIMIT_MS - (Date.now() - latestProgress))), control);
  }
}

async function waitForCheckinCompletion(platform, result, control = null) {
  assertCheckinActive(control);
  if (!result.reauthRequired) return result;
  const pending = Object.values(await getAgentRouterPending()).find((p) => sameOauthTask(p, platform) &&
    Number(p.createdAt) === Number(result.reauthStartedAt));
  if (pending) await waitForPendingOauth(pending, control);
  const tabId = result.reauthTabId ?? (pending && pending.tabId);
  const processing = tabId != null && agentRouterReauthQueues.get(tabId);
  if (processing) await processing;
  assertCheckinActive(control);
  const current = (await getPlatforms()).find((p) => p.id === platform.id);
  if (!current || !sameTaskConfig(current, platform) || Number(current.reauthStartedAt) !== Number(result.reauthStartedAt)) {
    return { ...result, ok: false, pending: false, reauthRequired: false, outcome: "fail", data: null,
      message: "平台配置已变更，本轮登录结果未覆盖当前账号" };
  }
  if (current.reauthPending || !current.reauthCompletedAt || Number(current.reauthCompletedAt) < Number(result.reauthStartedAt)) {
    return { ...result, ok: false, pending: false, reauthRequired: false, outcome: "fail", data: null,
      message: "未找到已完成的本轮登录结果，请重新执行签到" };
  }
  const ok = !current.error && current.reauthCheckedIn === true;
  return { ...result, ok, pending: false, reauthRequired: false, outcome: ok ? "ok" : "fail",
    message: current.message || current.error || "登录已完成但未确认签到",
    data: ok ? { stats: current.stats } : null,
    account: current.reauthAccountUpdated ? current.account : null };
}

async function persistCheckinResult(platform, result, alive = null, control = activeCheckinControl) {
  assertCheckinActive(control);
  await mutatePlatforms((list) => {
    assertCheckinActive(control);
    const p = list.find((entry) => entry.id === platform.id);
    if (!p || !sameTaskConfig(p, platform)) return list;
    if (alive) p.keepAlive = normalizeKeepAlive(platform.keepAlive);
    delete p.loading;
    p.taskResultRevision = (Number(p.taskResultRevision) || 0) + 1;
    p.message = result.message;
    p.error = result.ok ? "" : result.message;
    p.reauthPending = !!result.reauthRequired;
    if (result.reauthRequired) p.reauthStartedAt = result.reauthStartedAt;
    if (result.account) { p.account = Object.assign({}, p.account || {}, result.account); p.accountError = ""; }
    if (result.visited) {
      p.lastVisitDate = result.lastVisitDate;
      p.lastVisitedAt = result.lastVisitedAt;
    } else if (!isVisitOnly(p)) p.lastCheckinAt = new Date().toISOString();
    if (!result.visited && !isVisitOnly(p) && !result.reauthRequired && (result.ok || isAlreadyCheckinMessage(result.message))) {
      p.stats = { ...(p.stats || {}), ...(result.data && result.data.stats || {}), checked_in_today: true };
      p.statsDate = todayStr();
    }
    return list;
  });
}

// ---------- 批量/自动签到（Service Worker 内执行，可脱离弹窗） ----------
async function runAutoCheckin(triggeredByUser = false, selectedPlatforms = null, requestedStopVersion = undefined) {
  const runStopVersion = await acceptedCheckinStopVersion(requestedStopVersion);
  const settings = await getSettings();
  if (!settings.autoEnabled && !triggeredByUser) return { skipped: true };
  const explicitSelection = Array.isArray(selectedPlatforms);
  const platforms = explicitSelection ? selectedPlatforms : await getPlatforms();
  if (!platforms.length) return { skipped: true };
  const today = todayStr();
  const results = [];
  for (let p of platforms) {
    const item = await enqueueCheckinTask(p, async (queuedPlatform, control) => {
      p = await resolveSavedVisitOnly(queuedPlatform); // 出队后重读，不能让等待期间开启的仅访问失效。
      let alive = null;
      if (needsKeepAliveToday(p)) {
        alive = await runKeepAliveCall(p, control);
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
        : await waitForCheckinCompletion(p, await runCheckin(p, { reauth: true, control }), control);
      if (alive) {
        const part = alive.ok
          ? "自动调用API成功" + (alive.model ? "（模型 " + alive.model + "）" : "")
          : "自动调用API失败：" + alive.message + (isVisitOnly(p) ? "（仍执行仅访问）" : "（仍执行签到）");
        r.message = part + "｜" + r.message;
      }
      await persistCheckinResult(p, r, alive, control); // 当前项保存完，才释放队列并进入下一项。
      return { platform: p, result: r, alive, kind: r._alreadySkipped ? "already" : classify(r) };
    }, runStopVersion).catch(async (e) => {
      if (e && e.code === "CHECKIN_CANCELLED") throw e;
      await persistCheckinResult(p, { ok: false, message: e.message }, null, null);
      return { platform: p, result: { ok: false, message: e.message }, alive: null, kind: "fail" };
    });
    results.push(item);
  }
  let ok = 0, already = 0, fail = 0, pending = 0, visited = 0, aliveOk = 0, aliveFail = 0;
  const list = [];
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
  }
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
  const results = [];
  for (let p of platforms) results.push(await withPlatformSession(p, async () => {
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
  }));
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
  if (!platform || (isTokenAuthMode(platform) && !isVisitOnly(platform))) return Promise.resolve().then(fn);
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
  if (msg.type === "stopCheckin") {
    stopCheckinNow().then(sendResponse).catch((e) => sendResponse(errorResponse(e, "停止签到失败")));
    return true;
  }
  const schedule = msg.type === "checkin" ? enqueueCheckinTask : withPlatformSession;
  schedule(msg.platform, async (queuedPlatform, queuedControl) => {
    try {
      if (msg.type === "checkin" && queuedPlatform) msg = { ...msg, platform: queuedPlatform };
      // 旧界面/快照遗漏新标志时，以已保存的仅访问配置为准，不能降级成签到。
      if (msg.platform && msg.platform.id && msg.type !== "test") {
        const stored = (await getPlatforms()).find((p) => p.id === msg.platform.id);
        if (isVisitOnly(stored)) msg = { ...msg, platform: stored };
      }
      if (msg.type === "getCapabilities") {
        sendResponse({ ok: true, authBuild: AUTH_CONFIG.build, authModes: [...AUTH_CONFIG.modes], version: chrome.runtime.getManifest().version });
      } else if (msg.type === "savePlatforms") {
        if (!Array.isArray(msg.platforms)) throw new Error("平台配置格式必须为数组");
        await savePlatforms(msg.platforms, msg.resetState === true);
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
        const r = await waitForCheckinCompletion(msg.platform, msg.batch
          ? await runBatchCheckinOne(msg.platform, queuedControl)
          : await runCheckin(msg.platform, { reauth: msg.reauth !== false, control: queuedControl }), queuedControl);
        assertCheckinActive();
        await persistCheckinResult(msg.platform, r, null, queuedControl);
        sendResponse(r);
      } else if (msg.type === "autoRun") {
        const version = await acceptedCheckinStopVersion(msg.stopVersion);
        const summary = await runAutoCheckin(true, null, version);
        sendResponse({ ok: true, summary });
      } else if (msg.type === "getSettings") {
        sendResponse({ ok: true, settings: await getSettings() });
      } else if (msg.type === "saveSettings") {
        await saveSettings(msg.settings || {});
        await syncAlarm();
        if (msg.settings && msg.settings.autoEnabled) checkScheduledAuto().catch(() => {});
        sendResponse({ ok: true, settings: await getSettings() });
      } else if (msg.type === "getLastAuto") {
        const last = await getStore(KEY_LASTAUTO, null);
        sendResponse({ ok: true, last });
      } else {
        sendResponse({ ok: false, message: "未知请求" });
      }
    } catch (e) {
      sendResponse(msg.type === "checkin" ? errorResponse(e, "签到失败") :
        { ok: false, message: e && e.message ? e.message : String(e) });
    }
  }, msg.type === "checkin" ? msg.stopVersion : undefined).catch((e) => sendResponse(errorResponse(e, "签到队列执行失败")));
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
