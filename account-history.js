/**
 * AccountHistory - 本地账户历史管理。
 * 只保存实时取得的有限账户采样；不读取平台缓存来补造历史。
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  root.AccountHistory = api;
  if (typeof module === 'object' && module && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const STORAGE_KEY = 'nacheckin.accountHistory';
  const CURRENT_VERSION = 1;
  const DAY_MS = 24 * 60 * 60 * 1000;
  const RETENTION_DAYS = 35;
  const MAX_SAMPLES_PER_ACCOUNT = 500;
  const MAX_SAMPLES_GLOBAL = 5000;
  const PLATFORM_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
  const USER_ID_RE = /^\d{1,64}$/;
  const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

  function validTime(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
  }

  function createEmptyHistory(now = Date.now()) {
    return {
      version: CURRENT_VERSION,
      startedAt: validTime(now) ? now : Date.now(),
      accounts: {},
    };
  }

  function parsedBaseUrl(baseUrl) {
    if (typeof baseUrl !== 'string' || !baseUrl.trim()) return null;
    try {
      const url = new URL(baseUrl.trim());
      if (!['http:', 'https:'].includes(url.protocol)) return null;
      if (url.username || url.password) return { rejectedCredentials: true, value: null };
      // URL canonicalizes scheme/host/port; pathname keeps deployments distinct.
      // Query and fragment are intentionally omitted because they may contain secrets.
      const pathname = url.pathname.replace(/\/+$/, '');
      return { rejectedCredentials: false, value: url.origin + pathname };
    } catch {
      return null;
    }
  }

  function normalizedBaseUrl(baseUrl) {
    const parsed = parsedBaseUrl(baseUrl);
    return parsed && !parsed.rejectedCredentials ? parsed.value : null;
  }

  function validPlatformId(value) {
    return (typeof value === 'string' || typeof value === 'number') &&
      PLATFORM_ID_RE.test(String(value)) && !['__proto__', 'prototype', 'constructor'].includes(String(value));
  }

  // New-API 的实时 user.id 是数字 ID。token、密码、Cookie 和其片段从不参与身份生成。
  function identityFor(platform) {
    if (!platform || typeof platform !== 'object') return null;
    const parsedBase = parsedBaseUrl(platform.baseUrl);
    if (parsedBase && parsedBase.rejectedCredentials) return null;
    const base = parsedBase ? parsedBase.value : null;
    const configuredUserId = platform.userId == null ? '' : String(platform.userId).trim();
    const snapshotUserId = platform.account && typeof platform.account === 'object' && platform.account.userId != null
      ? String(platform.account.userId).trim()
      : '';
    const userId = USER_ID_RE.test(configuredUserId)
      ? configuredUserId
      : USER_ID_RE.test(snapshotUserId) ? snapshotUserId : '';
    if (base && userId) return base + '|user:' + userId;

    if (!validPlatformId(platform.id)) return null;
    return (base ? base + '|' : '') + 'config:' + String(platform.id);
  }

  function isSafeIdentity(identity) {
    if (typeof identity !== 'string' || identity.length > 512) return false;
    const separator = identity.lastIndexOf('|');
    if (separator < 0) return /^config:[A-Za-z0-9_-]{1,64}$/.test(identity);

    const origin = identity.slice(0, separator);
    const localId = identity.slice(separator + 1);
    if (normalizedBaseUrl(origin) !== origin) return false;
    return /^user:\d{1,64}$/.test(localId) || /^config:[A-Za-z0-9_-]{1,64}$/.test(localId);
  }

  function finiteOrNull(value, options = {}) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    if (options.nonNegative && value < 0) return null;
    if (options.integer) return Number.isSafeInteger(value) && value >= 0 ? value : null;
    return value;
  }

  function normalizeSample(sample, now, cutoff) {
    if (!sample || typeof sample !== 'object' || !validTime(sample.at) || sample.at > now || sample.at < cutoff) return null;
    if (typeof sample.month !== 'string' || !MONTH_RE.test(sample.month)) return null;
    return {
      at: sample.at,
      balance: finiteOrNull(sample.balance),
      used: finiteOrNull(sample.used),
      monthlyTokens: finiteOrNull(sample.monthlyTokens, { nonNegative: true, integer: true }),
      month: sample.month,
      truncated: sample.truncated === true,
    };
  }

  function defineOwn(target, key, value) {
    Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true });
  }

  /** Return a schema-only, retention-bounded copy. Unknown/legacy identity strings are discarded. */
  function sanitizeHistory(value, now = Date.now()) {
    const currentTime = validTime(now) ? now : Date.now();
    const cutoff = currentTime - RETENTION_DAYS * DAY_MS;
    const isCurrentHistory = value && typeof value === 'object' && value.version === CURRENT_VERSION &&
      validTime(value.startedAt) && value.accounts && typeof value.accounts === 'object' && !Array.isArray(value.accounts)
      ? true
      : false;
    const history = isCurrentHistory
      ? { version: CURRENT_VERSION, startedAt: value.startedAt, accounts: {} }
      : createEmptyHistory(currentTime);
    // A version mismatch is a clean start, never a migration source.
    if (!isCurrentHistory) return history;
    const allSamples = [];

    for (const [platformId, entry] of Object.entries(value.accounts)) {
      if (!validPlatformId(platformId) || !entry || typeof entry !== 'object' || !isSafeIdentity(entry.identity) || !Array.isArray(entry.samples)) continue;
      const samplesByTime = new Map();
      for (const candidate of entry.samples) {
        const sample = normalizeSample(candidate, currentTime, cutoff);
        if (sample) samplesByTime.set(sample.at, sample);
      }
      const samples = [...samplesByTime.values()].sort((a, b) => a.at - b.at).slice(-MAX_SAMPLES_PER_ACCOUNT);
      if (!samples.length) continue;
      defineOwn(history.accounts, platformId, { identity: entry.identity, samples });
      for (const sample of samples) allSamples.push({ platformId, sample });
    }

    if (allSamples.length > MAX_SAMPLES_GLOBAL) {
      const keep = new Set(allSamples
        .sort((a, b) => b.sample.at - a.sample.at)
        .slice(0, MAX_SAMPLES_GLOBAL)
        .map(({ platformId, sample }) => platformId + '\u0000' + sample.at));
      for (const [platformId, entry] of Object.entries(history.accounts)) {
        const samples = entry.samples.filter((sample) => keep.has(platformId + '\u0000' + sample.at));
        if (!samples.length) delete history.accounts[platformId];
        else entry.samples = samples;
      }
    }
    return history;
  }

  function createSample(account, month, at = Date.now()) {
    if (!account || typeof account !== 'object' || !validTime(at)) return null;
    const quotaPerUnit = typeof account.quotaPerUnit === 'number'
      ? account.quotaPerUnit
      : (typeof account.quotaPerUnit === 'string' && account.quotaPerUnit.trim() ? Number(account.quotaPerUnit) : NaN);
    const unit = Number.isFinite(quotaPerUnit) && quotaPerUnit > 0 ? quotaPerUnit : null;
    const available = finiteOrNull(account.available);
    const usedQuota = finiteOrNull(account.used);
    const tokens = finiteOrNull(account.monthlyTokens, { nonNegative: true, integer: true });
    const monthValue = typeof month === 'string' && MONTH_RE.test(month) ? month : null;
    if (!monthValue) return null;
    return {
      at,
      balance: available == null || unit == null ? null : available / unit,
      used: usedQuota == null || unit == null ? null : usedQuota / unit,
      monthlyTokens: tokens,
      month: monthValue,
      truncated: account.tokensTruncated === true,
    };
  }

  /** Append one fresh online sample and apply both per-account and global bounds. */
  function appendSample(value, platformId, identity, sample, now = Date.now()) {
    if (!validPlatformId(platformId) || !isSafeIdentity(identity)) return sanitizeHistory(value, now);
    const normalizedSample = normalizeSample(sample, now, now - RETENTION_DAYS * DAY_MS);
    if (!normalizedSample) return sanitizeHistory(value, now);

    const history = sanitizeHistory(value, now);
    if (Object.keys(history.accounts).length === 0) history.startedAt = normalizedSample.at;
    let entry = history.accounts[platformId];
    if (!entry || entry.identity !== identity) entry = { identity, samples: [] };
    const samplesByTime = new Map(entry.samples.map((item) => [item.at, item]));
    samplesByTime.set(normalizedSample.at, normalizedSample);
    entry.samples = [...samplesByTime.values()].sort((a, b) => a.at - b.at).slice(-MAX_SAMPLES_PER_ACCOUNT);
    defineOwn(history.accounts, String(platformId), entry);
    return sanitizeHistory(history, now);
  }

  function getSampleTimeRange(now = Date.now()) {
    const currentTime = validTime(now) ? now : Date.now();
    return { start: currentTime - RETENTION_DAYS * DAY_MS, end: currentTime };
  }

  function formatTime(epochMs) {
    return validTime(epochMs) ? new Date(epochMs).toISOString() : null;
  }

  function timeAgo(epochMs) {
    if (!validTime(epochMs)) return '未知';
    const diff = Math.max(0, Date.now() - epochMs);
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / DAY_MS);
    if (minutes < 1) return '刚刚';
    if (minutes < 60) return `${minutes}分钟前`;
    if (hours < 24) return `${hours}小时前`;
    if (days < 7) return `${days}天前`;
    return new Date(epochMs).toLocaleDateString('zh-CN');
  }

  return {
    STORAGE_KEY,
    CURRENT_VERSION,
    RETENTION_DAYS,
    MAX_SAMPLES_PER_ACCOUNT,
    MAX_SAMPLES_GLOBAL,
    identityFor,
    createEmptyHistory,
    sanitizeHistory,
    createSample,
    appendSample,
    getSampleTimeRange,
    formatTime,
    timeAgo,
  };
});
