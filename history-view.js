/**
 * Local, read-only account history view. No network requests and no writes.
 * Loaded after account-history.js and popup.js in both extension surfaces.
 */
(function (root, factory) {
  const accountHistory = typeof module === "object" && module.exports
    ? require("./account-history.js")
    : root.AccountHistory;
  const api = factory(accountHistory, root);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.HistoryView = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (AccountHistory, root) {
  "use strict";

  if (!AccountHistory || typeof AccountHistory.identityFor !== "function") {
    throw new Error("AccountHistory must be loaded before HistoryView");
  }

  const STORAGE_KEY = AccountHistory.STORAGE_KEY || "nacheckin.accountHistory";
  const PLATFORMS_KEY = "nacheckin.platforms";
  const DAY_MS = 24 * 60 * 60 * 1000;
  const MAX_COUNTER_GAP_MS = 7 * DAY_MS;
  const STALE_SNAPSHOT_MS = 36 * 60 * 60 * 1000;
  const DUPLICATE_SAMPLE_WINDOW_MS = 60 * 1000;
  const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
  const SVG_NS = "http://www.w3.org/2000/svg";
  const SITE_SCOPE_PREFIX = "site:";
  const SERIES_COLORS = ["var(--primary)", "var(--accent)", "var(--warning)", "var(--danger)", "#a78bfa", "#e879b5"];
  const HISTORY_REFRESH_GUIDANCE = "请使用账号卡片的“刷新”后重试。";

  function finite(value) {
    return typeof value === "number" && Number.isFinite(value);
  }

  function numberOrNull(value) {
    return value === null ? null : finite(value) ? value : null;
  }

  function normalizeSample(sample) {
    if (!sample || !finite(sample.at) || sample.at < 0) return null;
    const month = typeof sample.month === "string" && MONTH_PATTERN.test(sample.month) ? sample.month : null;
    return {
      at: sample.at,
      balance: numberOrNull(sample.balance),
      used: numberOrNull(sample.used),
      monthlyTokens: numberOrNull(sample.monthlyTokens),
      month,
      truncated: sample.truncated === true,
    };
  }

  /** Validate the fixed v1 storage contract and discard pre-collection samples. */
  function normalizeHistory(raw, now = Date.now()) {
    if (!raw || raw.version !== 1 || !raw.accounts || typeof raw.accounts !== "object" || Array.isArray(raw.accounts)) {
      return { version: 1, startedAt: null, accounts: {} };
    }
    const startedAt = finite(raw.startedAt) && raw.startedAt >= 0 ? raw.startedAt : null;
    if (startedAt === null) return { version: 1, startedAt: null, accounts: {} };
    const accounts = Object.create(null);
    for (const [platformId, entry] of Object.entries(raw.accounts)) {
      if (!entry || typeof entry.identity !== "string" || !entry.identity.trim() || !Array.isArray(entry.samples)) continue;
      const samples = entry.samples.map(normalizeSample).filter((sample) =>
        sample && sample.at <= now && (startedAt === null || sample.at >= startedAt)
      ).sort((a, b) => a.at - b.at);
      accounts[platformId] = { identity: entry.identity, samples };
    }
    return { version: 1, startedAt, accounts };
  }

  function identityFor(platform) {
    try {
      const identity = AccountHistory.identityFor(platform);
      return typeof identity === "string" && identity.trim() ? identity : null;
    } catch (_) {
      return null;
    }
  }

  function sampleQuality(sample) {
    return Number(sample.balance !== null) + Number(sample.used !== null) + Number(sample.monthlyTokens !== null && sample.month !== null);
  }

  function sameSampleValues(left, right) {
    return left.balance === right.balance
      && left.used === right.used
      && left.monthlyTokens === right.monthlyTokens
      && left.month === right.month
      && left.truncated === right.truncated;
  }

  function dedupeSamples(samples, preserveObservations = false) {
    const byTime = new Map();
    for (const sample of samples) {
      const previous = byTime.get(sample.at);
      if (!previous || sampleQuality(sample) >= sampleQuality(previous)) byTime.set(sample.at, sample);
    }
    const sorted = [...byTime.values()].sort((a, b) => a.at - b.at);
    const result = [];
    for (const sample of sorted) {
      const previous = result[result.length - 1];
      // Close-together samples are only duplicates if every observed value is
      // identical within one calendar day. Keep cross-midnight zero deltas.
      if (!preserveObservations && previous && sample.at - previous.at < DUPLICATE_SAMPLE_WINDOW_MS
        && new Date(previous.at).toDateString() === new Date(sample.at).toDateString() && sameSampleValues(previous, sample)) continue;
      result.push(sample);
    }
    return result;
  }

  /** Map current configurations to history, dropping removed or identity-mismatched configurations. */
  function collectSeries(historyInput, configs, options = {}) {
    const now = finite(options.now) ? options.now : Date.now();
    const history = normalizeHistory(historyInput, now);
    if (!Array.isArray(configs)) return [];
    const groups = new Map();
    for (const config of configs) {
      if (!config || config.id === null || config.id === undefined) continue;
      const platformId = String(config.id);
      const stored = history.accounts[platformId];
      const currentIdentity = identityFor(config);
      if (!currentIdentity) continue;
      let group = groups.get(currentIdentity);
      if (!group) {
        group = { identity: currentIdentity, label: String(config.name || config.baseUrl || "账号"), samples: [], configs: 0 };
        groups.set(currentIdentity, group);
      }
      group.configs++;
      // Missing or identity-mismatched history remains an explicit missing snapshot; never reuse cached account data.
      if (stored && stored.identity === currentIdentity) group.samples.push(...stored.samples);
    }
    return [...groups.values()].map((group) => ({
      identity: group.identity,
      label: group.label,
      siteKey: siteKeyFor(group.identity),
      duplicateConfigs: Math.max(0, group.configs - 1),
      samples: dedupeSamples(group.samples),
      // Retain real observation times, including identical reads across midnight.
      observations: dedupeSamples(group.samples, true),
    }));
  }

  function siteKeyFor(identity) {
    const separator = identity.lastIndexOf("|");
    return separator > 0 ? identity.slice(0, separator) : identity;
  }

  function collectSites(series) {
    const sites = new Map();
    for (const account of series) {
      if (!sites.has(account.siteKey)) sites.set(account.siteKey, { key: account.siteKey, label: account.siteKey, accounts: [] });
      sites.get(account.siteKey).accounts.push(account);
    }
    return [...sites.values()];
  }

  function calendarDays(now, days) {
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);
    return Array.from({ length: days }, (_, index) => {
      const date = new Date(today);
      date.setDate(date.getDate() - days + 1 + index);
      return date.getTime();
    });
  }

  // Configuration status is diagnostic only; never turn it or cached account data into samples.
  function collectHistoryDiagnostics(history, configs, identity, now) {
    const groups = new Map();
    for (const config of Array.isArray(configs) ? configs : []) {
      if (!config || config.id === null || config.id === undefined) continue;
      const currentIdentity = identityFor(config);
      if (!currentIdentity || (identity !== "all" && currentIdentity !== identity)) continue;
      let diagnostic = groups.get(currentIdentity);
      if (!diagnostic) {
        diagnostic = { identity: currentIdentity, label: String(config.name || config.baseUrl || "账号"), errors: [], mismatched: false, updatedAt: null };
        groups.set(currentIdentity, diagnostic);
      }
      const stored = history.accounts[String(config.id)];
      if (stored && stored.identity !== currentIdentity) diagnostic.mismatched = true;
      const error = typeof config.accountHistoryError === "string" ? config.accountHistoryError.trim() : "";
      if (error && !diagnostic.errors.includes(error)) diagnostic.errors.push(error);
      const updatedAt = typeof config.accountHistoryUpdatedAt === "string" ? Date.parse(config.accountHistoryUpdatedAt) : NaN;
      if (finite(updatedAt) && updatedAt >= 0 && updatedAt <= now) {
        diagnostic.updatedAt = diagnostic.updatedAt === null ? updatedAt : Math.max(diagnostic.updatedAt, updatedAt);
      }
    }
    return [...groups.values()];
  }

  function latestAtOrBefore(samples, at) {
    let found = null;
    for (const sample of samples) {
      if (sample.at > at) break;
      found = sample;
    }
    return found;
  }

  function addMetricDelta(pointMap, at, metric, amount, totalSeries, breakBefore = false) {
    let point = pointMap.get(at);
    if (!point) {
      point = { at, value: 0, contributors: 0, incomplete: 0, totalSeries, breakBefore: false };
      pointMap.set(at, point);
    }
    point.value += amount;
    point.contributors++;
    point.breakBefore = point.breakBefore || breakBefore;
  }

  function counterChanges(seriesList, start, end, metric) {
    const points = new Map();
    let breaks = 0;
    let missingComparisons = 0;
    let monthBoundaries = 0;
    let truncatedComparisons = 0;

    for (const series of seriesList) {
      let previous = null;
      let breakPending = false;
      for (const current of series.samples) {
        if (current.at > end) break;
        if (!previous) {
          previous = current;
          continue;
        }
        if (current.at < start) {
          previous = current;
          continue;
        }

        const gap = current.at - previous.at;
        if (gap <= 0 || gap > MAX_COUNTER_GAP_MS) {
          breaks++;
          breakPending = true;
          previous = current;
          continue;
        }

        if (metric === "tokens") {
          if (current.truncated || previous.truncated) {
            truncatedComparisons++;
            breakPending = true;
          } else if (!current.month || !previous.month) {
            missingComparisons++;
            breakPending = true;
          } else if (current.month !== previous.month) {
            monthBoundaries++;
            breakPending = true;
          } else if (current.monthlyTokens === null || previous.monthlyTokens === null) {
            missingComparisons++;
            breakPending = true;
          } else if (current.monthlyTokens < previous.monthlyTokens) {
            breaks++;
            breakPending = true;
          } else {
            addMetricDelta(points, current.at, metric, current.monthlyTokens - previous.monthlyTokens, seriesList.length, breakPending);
            breakPending = false;
          }
        } else if (current.used === null || previous.used === null) {
          missingComparisons++;
          breakPending = true;
        } else if (current.used < previous.used) {
          breaks++;
          breakPending = true;
        } else {
          addMetricDelta(points, current.at, metric, current.used - previous.used, seriesList.length, breakPending);
          breakPending = false;
        }
        previous = current;
      }
    }

    let cumulative = 0;
    const ordered = [...points.values()].sort((a, b) => a.at - b.at).map((point) => {
      cumulative += point.value;
      return Object.assign(point, { cumulative, missing: Math.max(0, point.totalSeries - point.contributors) });
    });
    return {
      points: ordered,
      total: ordered.length ? cumulative : null,
      breaks,
      missingComparisons,
      monthBoundaries,
      truncatedComparisons,
    };
  }

  function dailyAccountPoints(account, dates, now, metric) {
    const observations = account.observations || account.samples;
    const changes = metric === "balance" ? [] : counterChanges([account], dates[0], now, metric).points;
    return dates.map((at) => {
      const nextDay = new Date(at);
      nextDay.setDate(nextDay.getDate() + 1);
      const end = Math.min(now, nextDay.getTime() - 1);
      const sample = latestAtOrBefore(observations, end);
      const observed = !!sample && sample.at >= at;
      const change = latestAtOrBefore(changes, end);
      const dayChanges = changes.filter((point) => point.at >= at && point.at <= end);
      const effectiveSample = latestAtOrBefore(account.samples, end);
      const comparable = !!change && !!effectiveSample && change.at === effectiveSample.at && dayChanges.length > 0;
      const available = !!sample && (metric === "balance" ? finite(sample.balance)
        : metric === "used" ? finite(sample.used)
        : finite(sample.monthlyTokens) && !!sample.month && !sample.truncated);
      const value = metric === "balance" ? (sample ? sample.balance : null) : (change ? change.cumulative : null);
      const missing = !observed || !available || (metric !== "balance" && !comparable);
      return {
        at,
        value,
        known: Number(finite(value)),
        observed,
        uncollected: Number(!observed),
        missing: Number(missing),
        missingLabels: missing ? [account.label] : [],
        totalSeries: 1,
        sampleAt: sample ? sample.at : null,
        stale: Number(!!sample && end - sample.at > STALE_SNAPSHOT_MS),
        breakBefore: dayChanges.some((point) => point.breakBefore),
        status: !observed ? "当日未采集" : !available ? "当日字段缺失或不可比较"
          : metric !== "balance" && !comparable ? "当日无可比较变化" : "当日已采集",
      };
    });
  }

  function sumDailyPoints(accounts, metric, dates) {
    return dates.map((at, index) => {
      const points = accounts.map((account) => account[metric][index]);
      const known = points.filter((point) => finite(point.value));
      return {
        at,
        value: known.length ? known.reduce((total, point) => total + point.value, 0) : null,
        known: known.length,
        observed: points.every((point) => point.observed),
        uncollected: points.reduce((total, point) => total + point.uncollected, 0),
        missing: points.reduce((total, point) => total + point.missing, 0),
        missingLabels: points.flatMap((point) => point.missingLabels),
        totalSeries: accounts.length,
        stale: points.reduce((total, point) => total + point.stale, 0),
        breakBefore: points.some((point) => point.breakBefore),
      };
    });
  }

  function buildDailyCharts(series, dates, now, bySite) {
    const metrics = ["balance", "used", "tokens"];
    const accounts = series.map((account) => {
      const entry = { key: account.identity, siteKey: account.siteKey, label: account.label, kind: "account", accountCount: 1 };
      for (const metric of metrics) entry[metric] = dailyAccountPoints(account, dates, now, metric);
      return entry;
    });
    let entries = accounts;
    if (bySite) {
      const sites = new Map();
      for (const account of accounts) {
        if (!sites.has(account.siteKey)) sites.set(account.siteKey, []);
        sites.get(account.siteKey).push(account);
      }
      entries = [...sites].map(([key, siteAccounts]) => {
        const entry = { key, siteKey: key, label: key, kind: "site", accountCount: siteAccounts.length };
        for (const metric of metrics) entry[metric] = sumDailyPoints(siteAccounts, metric, dates);
        return entry;
      });
    }
    return Object.fromEntries(metrics.map((metric) => [metric, entries.map((entry, index) => {
      const points = [];
      let previousIndex = -1;
      // Filter only after computing the full-range deltas, retaining gaps as line breaks.
      for (const [pointIndex, point] of entry[metric].entries()) {
        if (point.uncollected === point.totalSeries) continue;
        points.push({ ...point, breakBefore: point.breakBefore || (previousIndex >= 0 && pointIndex > previousIndex + 1) });
        previousIndex = pointIndex;
      }
      return {
        key: entry.key, siteKey: entry.siteKey, label: entry.label, kind: entry.kind, accountCount: entry.accountCount,
        color: SERIES_COLORS[index % SERIES_COLORS.length], points,
      };
    })]));
  }

  /** Pure view-model builder, also used by the offline regression tests. */
  function buildViewModel(historyInput, configs, options = {}) {
    const now = finite(options.now) ? options.now : Date.now();
    const days = Number(options.days) === 30 ? 30 : 7;
    const dates = calendarDays(now, days);
    const start = dates[0];
    const history = normalizeHistory(historyInput, now);
    const allSeries = collectSeries(history, configs, { now });
    const sites = collectSites(allSeries);
    const identity = options.identity && options.identity !== "all" ? String(options.identity) : "all";
    const selectedSite = options.site ? String(options.site) : null;
    const series = allSeries.filter((account) => (identity === "all" || account.identity === identity)
      && (!selectedSite || account.siteKey === selectedSite));
    const historyDiagnostics = collectHistoryDiagnostics(history, configs, identity, now)
      .filter((account) => !selectedSite || siteKeyFor(account.identity) === selectedSite);
    const bySite = identity === "all" && !selectedSite;
    const events = [...new Set(series.flatMap((account) => account.observations
      .filter((sample) => sample.at >= start && sample.at <= now).map((sample) => sample.at)))].sort((a, b) => a - b);

    const balancePoints = events.map((at) => {
      let total = 0, known = 0, stale = 0;
      for (const account of series) {
        const sample = latestAtOrBefore(account.observations, at);
        if (!sample || sample.balance === null) continue;
        total += sample.balance;
        known++;
        if (at - sample.at > STALE_SNAPSHOT_MS) stale++;
      }
      return { at, value: known ? total : null, known, missing: Math.max(0, series.length - known), stale, totalSeries: series.length };
    }).filter((point) => point.value !== null);

    let balanceTotal = 0, balanceKnown = 0, balanceStale = 0;
    const latestSnapshots = series.map((account) => {
      const sample = latestAtOrBefore(account.observations, now);
      if (sample && sample.balance !== null) {
        balanceTotal += sample.balance;
        balanceKnown++;
        if (now - sample.at > STALE_SNAPSHOT_MS) balanceStale++;
      }
      return { account, sample };
    });

    const used = counterChanges(series, start, now, "used");
    const tokens = counterChanges(series, start, now, "tokens");
    const inRangeSamples = series.flatMap((account) => account.observations
      .filter((sample) => sample.at >= start && sample.at <= now)
      .map((sample) => ({ account, sample })))
      .sort((a, b) => b.sample.at - a.sample.at);

    return {
      days,
      start,
      end: now,
      startedAt: history.startedAt,
      series,
      allSeries,
      identity,
      selectedSite,
      sites,
      dates,
      bySite,
      charts: buildDailyCharts(series, dates, now, bySite),
      historyDiagnostics,
      hasSamples: series.some((account) => account.observations.length > 0),
      inRangeSamples,
      balancePoints,
      latestBalance: { value: balanceKnown ? balanceTotal : null, known: balanceKnown, missing: Math.max(0, series.length - balanceKnown), stale: balanceStale, totalSeries: series.length },
      latestSnapshots,
      newestSampleAt: series.reduce((latest, account) => account.observations.length ? Math.max(latest, account.observations[account.observations.length - 1].at) : latest, 0) || null,
      used,
      tokens,
      hasInRangeSamples: inRangeSamples.length > 0,
    };
  }

  function formatCurrency(value) {
    return value === null || value === undefined || !finite(value)
      ? "—"
      : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 4, maximumFractionDigits: 4 }).format(value);
  }

  function formatNumber(value) {
    return value === null || value === undefined || !finite(value) ? "—" : new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
  }

  function formatDate(at) {
    if (!finite(at)) return "日期未知";
    return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(at));
  }

  function formatChartDate(at, compact) {
    if (!finite(at)) return "日期未知";
    return new Intl.DateTimeFormat("zh-CN", compact
      ? { month: "2-digit", day: "2-digit" }
      : { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(at));
  }

  function formatDateTime(at) {
    if (!finite(at)) return "时间未知";
    return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(at));
  }

  function timeAgo(at, now = Date.now()) {
    if (!finite(at)) return "时间未知";
    if (typeof AccountHistory.timeAgo === "function") {
      try { return AccountHistory.timeAgo(at); } catch (_) { /* fall back below */ }
    }
    const minutes = Math.max(0, Math.floor((now - at) / 60000));
    if (minutes < 1) return "刚刚";
    if (minutes < 60) return minutes + " 分钟前";
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + " 小时前";
    return Math.floor(hours / 24) + " 天前";
  }

  function element(doc, tag, className, text) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function svgElement(doc, tag, attrs = {}) {
    const node = doc.createElementNS(SVG_NS, tag);
    for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
    return node;
  }

  function emptyMessage(doc, title, message) {
    const box = element(doc, "div", "history-chart-empty");
    box.append(element(doc, "strong", "", title), element(doc, "p", "", message));
    return box;
  }

  function measuredChartWidth(container) {
    const clientWidth = Number(container && container.clientWidth);
    if (finite(clientWidth) && clientWidth > 0) return Math.max(1, Math.round(clientWidth));
    if (container && typeof container.getBoundingClientRect === "function") {
      const rectWidth = Number(container.getBoundingClientRect().width);
      if (finite(rectWidth) && rectWidth > 0) return Math.max(1, Math.round(rectWidth));
    }
    // Detached/mock DOM fallback; actual extension panels use clientWidth.
    return 360;
  }

  function chartWidthSignature(view) {
    return [view.balanceChart, view.usedChart, view.tokenChart].map(measuredChartWidth).join(":");
  }

  function formatChartCurrency(value, width) {
    if (!finite(value)) return "—";
    const magnitude = Math.abs(value);
    const compact = magnitude >= 1000;
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      notation: compact ? "compact" : "standard",
      maximumFractionDigits: magnitude < 1 ? 4 : width < 460 ? 1 : 2,
      minimumFractionDigits: 0,
    }).format(value);
  }

  function formatChartNumber(value, width) {
    if (!finite(value)) return "—";
    const compact = Math.abs(value) >= 10000 || (width < 460 && Math.abs(value) >= 1000);
    return new Intl.NumberFormat("en-US", {
      notation: compact ? "compact" : "standard",
      maximumFractionDigits: compact ? 1 : 0,
    }).format(value);
  }

  function chartPointText(series, point, formatter, daily) {
    const parts = [series.label, daily ? formatDate(point.at) : formatDateTime(point.at), formatter(point.value)].filter(Boolean);
    if (point.status) parts.push(point.status);
    if (point.missing && series.kind === "site") {
      parts.push(`当日 ${point.totalSeries - point.missing}/${point.totalSeries} 个账号数据完整`);
      if (point.missingLabels && point.missingLabels.length) parts.push(`缺测或不可比较：${point.missingLabels.join("、")}`);
    }
    if (point.missing && finite(point.value)) parts.push("包含之前的已知读数，仅作位置参考，并非当日完整读数");
    if (point.sampleAt) parts.push(`最近采集 ${formatDateTime(point.sampleAt)}`);
    if (point.breakBefore) parts.push("与前段不可比较");
    if (point.stale) parts.push(`${point.stale} 个快照较旧`);
    if (point.missing && !daily) parts.push(`${point.missing} 个账号缺失`);
    return parts.join(" · ");
  }

  function renderChartLegend(container, seriesList, onSelect) {
    const doc = container.ownerDocument;
    const legend = element(doc, "div", "history-chart-legend");
    for (const series of seriesList) {
      const item = element(doc, typeof onSelect === "function" ? "button" : "span", "history-legend-item");
      if (typeof onSelect === "function") {
        item.type = "button";
        const action = series.kind === "site" ? `查看 ${series.label} 的账号额度变化` : `查看 ${series.label} 的额度变化`;
        item.setAttribute("aria-label", action);
        item.setAttribute("title", action);
        item.addEventListener("click", () => onSelect(series));
      }
      item.setAttribute("data-series", series.key);
      const swatch = element(doc, "span", "history-legend-swatch");
      swatch.setAttribute("style", `background:${series.color || "var(--primary)"}`);
      swatch.setAttribute("aria-hidden", "true");
      item.append(swatch, element(doc, "span", "history-legend-label", series.label));
      const latest = series.points[series.points.length - 1];
      const detail = series.kind === "site" ? `${series.accountCount} 个账号`
        : latest && latest.uncollected ? "当日未采集" : "";
      if (detail) item.appendChild(element(doc, "small", "history-legend-detail", detail));
      legend.appendChild(item);
    }
    container.appendChild(legend);
  }

  function renderChart(container, points, label, formatter, note, options = {}) {
    const doc = container.ownerDocument;
    container.replaceChildren();
    const daily = Array.isArray(options.series);
    const seriesList = daily ? options.series : [{ key: "", label: "", points: points.filter((point) => finite(point.value)) }];
    const valid = seriesList.flatMap((series) => series.points.filter((point) => finite(point.value)));
    const dates = [...new Set(seriesList.flatMap((series) => series.points.map((point) => point.at)))].sort((a, b) => a - b);
    if (daily) renderChartLegend(container, seriesList, options.onSelect);
    if (!dates.length) {
      container.appendChild(emptyMessage(doc, "暂无可比较的数据", note));
      return;
    }

    // The viewBox is expressed in the container's CSS-pixel width. This keeps
    // 11px SVG labels readable on a phone and in the half-width desktop charts.
    const hasUnknownSeries = daily && seriesList.some((series) => !series.points.some((point) => finite(point.value)));
    const width = measuredChartWidth(container), height = 214, right = 8, top = 16, bottom = hasUnknownSeries ? 54 : 34;
    const compact = width < 520;
    const axisFormatter = typeof options.axisFormatter === "function" ? options.axisFormatter : formatter;
    let min = valid.length ? Math.min(...valid.map((point) => point.value)) : 0;
    let max = valid.length ? Math.max(...valid.map((point) => point.value)) : 1;
    if (min === max) {
      const pad = Math.max(Math.abs(max) * 0.08, 1);
      min -= pad;
      max += pad;
    } else {
      const pad = (max - min) * 0.08;
      min -= pad;
      max += pad;
    }
    const ticks = Array.from({ length: valid.length ? 4 : 0 }, (_, index) => ({
      ratio: index / 3,
      value: max - (max - min) * (index / 3),
    }));
    const tickLabels = ticks.map((tick) => axisFormatter(tick.value, width));
    const widestTick = Math.max(0, ...tickLabels.map((text) => String(text).length));
    const left = Math.max(44, Math.min(104, Math.ceil(widestTick * 6.1 + 12)));
    const plotWidth = width - left - right, plotHeight = height - top - bottom;
    const firstAt = dates[0], lastAt = dates[dates.length - 1];
    const dateIndices = daily ? new Map(dates.map((at, index) => [at, index])) : null;
    const x = (at) => daily
      ? left + dateIndices.get(at) / Math.max(1, dates.length - 1) * plotWidth
      : left + (lastAt === firstAt ? plotWidth / 2 : (at - firstAt) / (lastAt - firstAt) * plotWidth);
    const y = (value) => top + (max - value) / (max - min) * plotHeight;
    const svg = svgElement(doc, "svg", { viewBox: `0 0 ${width} ${height}`, role: typeof options.onSelect === "function" ? "group" : "img", "aria-label": label, focusable: "false" });
    const title = svgElement(doc, "title");
    title.textContent = label;
    svg.appendChild(title);

    for (let index = 0; index < ticks.length; index++) {
      const py = top + plotHeight * ticks[index].ratio;
      svg.appendChild(svgElement(doc, "line", { x1: left, y1: py, x2: width - right, y2: py, class: "history-grid-line" }));
      const axisLabel = svgElement(doc, "text", { x: left - 8, y: py + 4, "text-anchor": "end", class: "history-axis-label" });
      axisLabel.textContent = tickLabels[index];
      svg.appendChild(axisLabel);
    }

    const unknownY = valid.length ? height - 34 : top + plotHeight / 2;
    if (hasUnknownSeries) {
      const unknownLabel = svgElement(doc, "text", { x: left - 8, y: unknownY + 4, "text-anchor": "end", class: "history-axis-label" });
      unknownLabel.textContent = "无数据";
      svg.appendChild(unknownLabel);
    }

    for (const series of seriesList) {
      const firstKnown = daily ? null : series.points.find((point) => finite(point.value));
      let reference = firstKnown ? firstKnown.value : null;
      const plotted = series.points.map((point) => {
        if (finite(point.value)) reference = point.value;
        // Unknown values stay null in the model and tooltip; a reference only positions the gray marker.
        return { point, py: finite(reference) ? y(reference) : unknownY, missing: !!point.missing || !finite(point.value) };
      });
      const segments = [];
      let segment = [], segmentMissing = null;
      for (const plottedPoint of plotted) {
        const previous = segment[segment.length - 1];
        if (plottedPoint.point.breakBefore && segment.length) {
          segments.push({ points: segment, missing: segmentMissing });
          segment = [];
          segmentMissing = null;
        } else if (previous) {
          const edgeMissing = previous.missing || plottedPoint.missing;
          if (segmentMissing !== null && segmentMissing !== edgeMissing) {
            segments.push({ points: segment, missing: segmentMissing });
            segment = [previous];
          }
          segmentMissing = edgeMissing;
        }
        segment.push(plottedPoint);
      }
      if (segment.length) segments.push({ points: segment, missing: segmentMissing });
      const color = series.color || "var(--primary)";
      for (const part of segments) {
        const pathData = part.points.map((item, index) => `${index ? "L" : "M"}${x(item.point.at).toFixed(2)},${item.py.toFixed(2)}`).join(" ");
        svg.appendChild(svgElement(doc, "path", {
          d: pathData, class: `history-chart-line${part.missing ? " history-chart-line-missing" : ""}`,
          style: `--history-series-color:${color}`, "data-series": series.key,
        }));
      }
      const isolatedPoints = new Set(segments.filter((part) => part.points.length === 1).map((part) => part.points[0]));
      for (const item of plotted) {
        const point = item.point;
        if (daily || plotted.length <= 36 || point.breakBefore || isolatedPoints.has(item)) {
          const text = chartPointText(series, point, formatter, daily);
          const circle = svgElement(doc, "circle", {
            cx: x(point.at), cy: item.py, r: daily ? 4 : 3.5,
            class: `history-chart-dot${item.missing ? " history-chart-dot-missing" : ""}`,
            style: `--history-series-color:${color}`, "data-series": series.key, "data-at": point.at,
          });
          const tooltip = svgElement(doc, "title");
          tooltip.textContent = text;
          circle.appendChild(tooltip);
          if (typeof options.onSelect === "function") {
            circle.setAttribute("role", "button");
            circle.setAttribute("tabindex", "0");
            circle.setAttribute("aria-label", text);
            circle.addEventListener("click", () => options.onSelect(series, point));
            circle.addEventListener("keydown", (event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                options.onSelect(series, point);
              }
            });
          }
          svg.appendChild(circle);
        }
      }
    }
    const dateLabelMinGap = compact ? 72 : 92;
    const desiredCount = Math.min(5, dates.length, Math.max(dates.length > 1 ? 2 : 1, Math.floor(plotWidth / dateLabelMinGap) + 1));
    const labelIndices = [0];
    for (let index = 1; index < desiredCount - 1; index++) {
      const candidate = Math.round(index * (dates.length - 1) / (desiredCount - 1));
      if (x(dates[candidate]) - x(dates[labelIndices[labelIndices.length - 1]]) >= dateLabelMinGap
        && x(dates[dates.length - 1]) - x(dates[candidate]) >= dateLabelMinGap) labelIndices.push(candidate);
    }
    if (dates.length > 1) labelIndices.push(dates.length - 1);
    for (let index = 0; index < labelIndices.length; index++) {
      const pointIndex = labelIndices[index];
      const at = dates[pointIndex];
      const anchor = labelIndices.length === 1 ? (daily ? "start" : "middle") : pointIndex === 0 ? "start" : pointIndex === dates.length - 1 ? "end" : "middle";
      const axisLabel = svgElement(doc, "text", { x: x(at), y: height - 10, "text-anchor": anchor, class: "history-axis-label" });
      axisLabel.textContent = formatChartDate(at, compact);
      svg.appendChild(axisLabel);
    }
    container.appendChild(svg);
    if (options.footnote) container.appendChild(element(doc, "p", "history-chart-note", options.footnote));
  }

  function summaryCard(doc, label, value, detail) {
    const card = element(doc, "div", "history-summary-card");
    card.append(element(doc, "span", "history-summary-label", label));
    card.append(element(doc, "strong", "history-summary-value", value));
    card.append(element(doc, "small", "history-summary-detail", detail));
    return card;
  }

  function sampleStatus(sample) {
    const issues = [];
    if (sample.balance === null) issues.push("余额缺失");
    if (sample.used === null) issues.push("已用缺失");
    if (sample.monthlyTokens === null) issues.push("Token缺失");
    else if (!sample.month) issues.push("Token月份未知");
    if (sample.truncated) issues.push("Token统计截断");
    return issues.length ? issues.join(" · ") : "字段齐全";
  }

  function historyEmptyState(model) {
    if (model.hasSamples) {
      return { title: "所选区间无样本", message: "可切换时间范围，或刷新账号额度。" };
    }
    const diagnostics = model.historyDiagnostics || [];
    if (diagnostics.some((account) => account.errors.length)) {
      return { title: "后台记录历史失败", message: HISTORY_REFRESH_GUIDANCE };
    }
    if (diagnostics.some((account) => account.mismatched)) {
      return { title: "配置身份不匹配", message: HISTORY_REFRESH_GUIDANCE };
    }
    return { title: "尚无真实历史样本", message: HISTORY_REFRESH_GUIDANCE };
  }

  function renderRows(tbody, model) {
    const doc = tbody.ownerDocument;
    tbody.replaceChildren();
    if (!model.inRangeSamples.length) {
      const row = element(doc, "tr");
      const empty = historyEmptyState(model);
      const cell = element(doc, "td", "history-table-empty", `${empty.title}：${empty.message}`);
      cell.colSpan = 6;
      row.appendChild(cell);
      tbody.appendChild(row);
      return;
    }
    for (const { account, sample } of model.inRangeSamples) {
      const row = element(doc, "tr");
      const values = [
        formatDateTime(sample.at),
        `${account.label} · ${account.siteKey}`,
        formatCurrency(sample.balance),
        formatCurrency(sample.used),
        sample.monthlyTokens === null ? "—" : `${formatNumber(sample.monthlyTokens)}${sample.month ? ` · ${sample.month}` : ""}`,
        sampleStatus(sample),
      ];
      for (const value of values) row.appendChild(element(doc, "td", "", value));
      tbody.appendChild(row);
    }
  }

  function completenessText(model) {
    const parts = [];
    const diagnostics = model.historyDiagnostics || [];
    // Backend write errors are not panel read errors, and must survive every empty-state branch.
    for (const account of diagnostics.filter((account) => account.errors.length)) {
      parts.push(`后台记录历史失败 · ${account.label}：${account.errors.join("；")}。`);
    }
    for (const account of diagnostics.filter((account) => account.mismatched)) {
      parts.push(`${account.label}：配置身份不匹配，旧身份历史未使用。`);
    }
    if (diagnostics.some((account) => account.errors.length || account.mismatched)) parts.push(HISTORY_REFRESH_GUIDANCE);
    return parts.join(" ");
  }

  function renderCharts(view, model) {
    const onSelect = (series) => {
      const selected = series.kind === "site" ? SITE_SCOPE_PREFIX + series.siteKey : series.key;
      if (view.accountSelect.value === selected) return;
      view.accountSelect.value = selected;
      view.focusScope = true;
      refresh(view);
    };
    const chartSeries = (metric) => model.charts[metric];
    view.balanceTitle.textContent = model.bySite ? "网址额度总和走势" : "账号额度走势";
    renderChart(view.balanceChart, [], view.balanceTitle.textContent, formatCurrency,
      model.hasInRangeSamples ? "当前范围暂无有效余额样本。" : historyEmptyState(model).message,
      { axisFormatter: formatChartCurrency, series: chartSeries("balance"), onSelect });
    renderChart(view.usedChart, [], "已用金额可比较片段累计（非完整区间消耗）", formatCurrency,
      model.hasInRangeSamples ? "当前范围暂无可比较的已用金额变化。" : historyEmptyState(model).message,
      {
        axisFormatter: formatChartCurrency,
        series: chartSeries("used"),
        onSelect,
      });
    renderChart(view.tokenChart, [], "Token 可比较片段累计（非完整区间消耗）", formatNumber,
      model.hasInRangeSamples ? "当前范围暂无可比较的 Token 变化。" : historyEmptyState(model).message,
      {
        axisFormatter: formatChartNumber,
        series: chartSeries("tokens"),
        onSelect,
      });
  }

  function renderScope(view, model) {
    const account = model.identity !== "all" ? model.series[0] : null;
    view.back.hidden = model.bySite;
    view.scopeLabel.textContent = account ? `${account.label} · ${account.siteKey}`
      : model.selectedSite || "全部网址";
    view.scopeDetail.textContent = model.bySite ? `${model.sites.length} 个网址`
      : `${model.series.length} 个账号`;
    if (view.focusScope) {
      (view.back.hidden ? view.accountSelect : view.back).focus({ preventScroll: true });
      view.focusScope = false;
    }
  }

  function renderModel(view, model) {
    const doc = view.panel.ownerDocument;
    const balanceDetail = model.latestBalance.totalSeries
      ? `最新快照${model.newestSampleAt ? ` · ${formatDateTime(model.newestSampleAt)}（${timeAgo(model.newestSampleAt)}）` : ""}${model.latestBalance.stale ? ` · ${model.latestBalance.stale} 个较旧` : ""}`
      : "尚无可用余额快照";
    const usedValue = model.used.total === null ? "—" : `+${formatCurrency(model.used.total)}`;
    const tokenValue = model.tokens.total === null ? "—" : `+${formatNumber(model.tokens.total)}`;
    const usedDetail = `${model.used.points.length} 条可比较记录`;
    const tokenDetail = `${model.tokens.points.length} 条可比较记录`;
    view.summary.replaceChildren(
      summaryCard(doc, "最新余额（按身份去重）", formatCurrency(model.latestBalance.value), balanceDetail),
    );
    view.changeSummary.replaceChildren(...(model.hasInRangeSamples ? [
      summaryCard(doc, `${model.days} 天已用变化（可比较片段）`, usedValue, usedDetail),
      summaryCard(doc, `${model.days} 天 Token 变化（可比较片段）`, tokenValue, tokenDetail),
    ] : []));

    view.coverage.textContent = completenessText(model);
    view.coverage.hidden = !view.coverage.textContent;
    const rangeEnd = formatDate(model.end);
    const rangeStart = formatDate(model.start);
    view.range.textContent = `最近 ${model.days} 天：${rangeStart} 至 ${rangeEnd} · ${model.inRangeSamples.length} 条本地样本`;

    view.chartModel = model;
    view.chartWidthSignature = chartWidthSignature(view);
    renderCharts(view, model);
    renderRows(view.tableBody, model);
  }

  function readStoredSnapshot() {
    const storage = root.chrome && root.chrome.storage && root.chrome.storage.local;
    if (!storage || typeof storage.get !== "function") return Promise.reject(new Error("当前扩展页面无法读取本地历史存储。"));
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (result) => {
        if (settled) return;
        settled = true;
        const runtimeError = root.chrome && root.chrome.runtime && root.chrome.runtime.lastError;
        if (runtimeError) reject(new Error(runtimeError.message || "读取本地历史失败"));
        else resolve(result || {});
      };
      try {
        const result = storage.get([STORAGE_KEY, PLATFORMS_KEY], done);
        if (result && typeof result.then === "function") result.then(done, (error) => {
          if (!settled) { settled = true; reject(error instanceof Error ? error : new Error(String(error))); }
        });
      } catch (error) {
        if (!settled) { settled = true; reject(error); }
      }
    });
  }

  function updateAccountOptions(view, configs) {
    const selected = view.accountSelect.value;
    const options = new Map();
    const all = element(view.doc, "option", "", "全部网址汇总");
    all.value = "all";
    options.set("all", all);
    const accounts = collectSeries(null, configs);
    for (const site of collectSites(accounts)) {
      const option = element(view.doc, "option", "", `网址 · ${site.label}`);
      option.value = SITE_SCOPE_PREFIX + site.key;
      options.set(option.value, option);
    }
    for (const account of accounts) {
      const option = element(view.doc, "option", "", `账号 · ${account.label} · ${account.siteKey}`);
      option.value = account.identity;
      options.set(option.value, option);
    }
    view.configs = configs;
    view.accountSelect.replaceChildren(...options.values());
    view.accountSelect.value = options.has(selected) ? selected : "all";
  }

  function buildPanel(doc, configs, trigger) {
    const overlay = element(doc, "div", "history-overlay");
    const panel = element(doc, "section", "history-panel");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-labelledby", "historyPanelTitle");
    panel.setAttribute("tabindex", "-1");

    const header = element(doc, "header", "history-panel-header");
    const heading = element(doc, "div", "history-panel-heading");
    heading.append(element(doc, "h2", "", "本地历史图表"), element(doc, "p", "", "只读本地采样；不联网、不触发签到或访问。"));
    heading.querySelector("h2").id = "historyPanelTitle";
    const close = element(doc, "button", "history-close", "×");
    close.type = "button";
    close.setAttribute("aria-label", "关闭历史图表");
    close.setAttribute("title", "关闭历史图表");
    header.append(heading, close);
    panel.appendChild(header);

    const controls = element(doc, "div", "history-controls");
    const accountLabel = element(doc, "label", "history-control");
    accountLabel.appendChild(element(doc, "span", "", "查看范围"));
    const accountSelect = element(doc, "select", "");
    accountSelect.setAttribute("aria-label", "选择历史网址或账号");
    updateAccountOptions({ doc, accountSelect }, configs);
    accountLabel.appendChild(accountSelect);
    const periodLabel = element(doc, "label", "history-control");
    periodLabel.appendChild(element(doc, "span", "", "时间范围"));
    const periodSelect = element(doc, "select", "");
    periodSelect.setAttribute("aria-label", "选择历史时间范围");
    for (const [days, text] of [[7, "最近 7 天"], [30, "最近 30 天"]]) {
      const option = element(doc, "option", "", text);
      option.value = String(days);
      periodSelect.appendChild(option);
    }
    periodSelect.value = "7";
    periodLabel.appendChild(periodSelect);
    controls.append(accountLabel, periodLabel);
    panel.appendChild(controls);

    const scope = element(doc, "div", "history-scope");
    const back = element(doc, "button", "history-back", "←");
    back.type = "button";
    back.hidden = true;
    back.setAttribute("aria-label", "返回网址汇总");
    back.setAttribute("title", "返回网址汇总");
    const scopeLabel = element(doc, "strong", "history-scope-label", "全部网址");
    const scopeDetail = element(doc, "span", "history-scope-detail");
    scope.append(back, scopeLabel, scopeDetail);
    panel.appendChild(scope);

    const range = element(doc, "p", "history-range", "正在读取本地历史…");
    panel.appendChild(range);
    const summary = element(doc, "section", "history-summary");
    summary.setAttribute("aria-label", "最新余额摘要");
    panel.appendChild(summary);
    const coverage = element(doc, "p", "history-coverage");
    coverage.hidden = true;
    panel.appendChild(coverage);

    const charts = element(doc, "div", "history-charts");
    const changeSummary = element(doc, "section", "history-summary history-change-summary");
    changeSummary.setAttribute("aria-label", "变化摘要");
    const chartEntries = [
      ["网址额度总和走势", "history-balance-chart"],
      ["使用金额累计变化", "history-used-chart"],
      ["Token 累计变化", "history-token-chart"],
    ];
    const chartContainers = {};
    const chartTitles = {};
    for (const [title, key] of chartEntries) {
      const section = element(doc, "section", "history-chart-section");
      const heading = element(doc, "h3", "", title);
      section.appendChild(heading);
      chartTitles[key] = heading;
      const chart = element(doc, "div", "history-chart-container");
      chart.setAttribute("aria-live", "polite");
      section.appendChild(chart);
      charts.appendChild(section);
      if (key === "history-balance-chart") charts.appendChild(changeSummary);
      chartContainers[key] = chart;
    }
    panel.appendChild(charts);

    const tableSection = element(doc, "section", "history-table-section");
    tableSection.appendChild(element(doc, "h3", "", "采样明细"));
    const tableScroll = element(doc, "div", "history-table-scroll");
    const table = element(doc, "table", "history-table");
    const thead = element(doc, "thead", "");
    const headerRow = element(doc, "tr", "");
    for (const label of ["采样时间", "账号", "余额（美元）", "累计已用（美元）", "月 Token（YYYY-MM）", "数据状态"]) {
      headerRow.appendChild(element(doc, "th", "", label));
    }
    thead.appendChild(headerRow);
    const tbody = element(doc, "tbody", "");
    table.append(thead, tbody);
    tableScroll.appendChild(table);
    tableSection.appendChild(tableScroll);
    panel.appendChild(tableSection);

    overlay.appendChild(panel);
    doc.body.appendChild(overlay);
    return { overlay, panel, close, accountSelect, periodSelect, back, scopeLabel, scopeDetail, range, summary, changeSummary, coverage, tableBody: tbody,
      balanceTitle: chartTitles["history-balance-chart"],
      balanceChart: chartContainers["history-balance-chart"], usedChart: chartContainers["history-used-chart"], tokenChart: chartContainers["history-token-chart"], trigger };
  }

  let activeView = null;

  function observeChartResize(view) {
    const ResizeObserverCtor = root.ResizeObserver;
    if (typeof ResizeObserverCtor !== "function") return;
    try {
      view.resizeObserver = new ResizeObserverCtor(() => {
        if (activeView !== view || !view.chartModel) return;
        const signature = chartWidthSignature(view);
        if (signature === view.chartWidthSignature) return;
        view.chartWidthSignature = signature;
        renderCharts(view, view.chartModel);
      });
      for (const chart of [view.balanceChart, view.usedChart, view.tokenChart]) view.resizeObserver.observe(chart);
    } catch (_) {
      if (view.resizeObserver && typeof view.resizeObserver.disconnect === "function") view.resizeObserver.disconnect();
      view.resizeObserver = null;
    }
  }

  function close() {
    if (!activeView) return;
    const view = activeView;
    activeView = null;
    if (view.resizeObserver && typeof view.resizeObserver.disconnect === "function") view.resizeObserver.disconnect();
    const storageChanges = root.chrome && root.chrome.storage && root.chrome.storage.onChanged;
    if (view.onStorageChanged && storageChanges && typeof storageChanges.removeListener === "function") {
      storageChanges.removeListener(view.onStorageChanged);
    }
    view.overlay.remove();
    view.doc.removeEventListener("keydown", view.onKeydown);
    if (view.trigger && view.trigger.isConnected && typeof view.trigger.focus === "function") view.trigger.focus();
  }

  function showError(view, error) {
    if (!view || activeView !== view) return;
    view.chartModel = null;
    view.range.textContent = "本地历史读取失败";
    view.coverage.textContent = error && error.message ? error.message : "无法读取本地历史存储。";
    view.coverage.hidden = false;
    for (const chart of [view.balanceChart, view.usedChart, view.tokenChart]) {
      chart.replaceChildren(emptyMessage(view.doc, "读取失败", "请确认扩展本地存储可用后重新打开面板。"));
    }
    view.summary.replaceChildren();
    view.changeSummary.replaceChildren();
    view.tableBody.replaceChildren();
  }

  function refresh(view) {
    const refreshGeneration = (view.refreshGeneration || 0) + 1;
    view.refreshGeneration = refreshGeneration;
    readStoredSnapshot().then((snapshot) => {
      if (activeView !== view || view.refreshGeneration !== refreshGeneration) return;
      // Identity can change after an online refresh (e.g. an initially blank user ID).
      // Read both keys together; the opening page's config snapshot is not authoritative.
      updateAccountOptions(view, Array.isArray(snapshot[PLATFORMS_KEY]) ? snapshot[PLATFORMS_KEY] : []);
      const selected = view.accountSelect.value;
      const model = buildViewModel(snapshot[STORAGE_KEY], view.configs, {
        days: Number(view.periodSelect.value), now: Date.now(),
        identity: selected.startsWith(SITE_SCOPE_PREFIX) ? "all" : selected,
        site: selected.startsWith(SITE_SCOPE_PREFIX) ? selected.slice(SITE_SCOPE_PREFIX.length) : null,
      });
      renderScope(view, model);
      if (!model.hasSamples) {
        const empty = historyEmptyState(model);
        view.chartModel = model;
        view.chartWidthSignature = chartWidthSignature(view);
        view.range.textContent = empty.title;
        view.coverage.textContent = completenessText(model);
        view.coverage.hidden = !view.coverage.textContent;
        view.summary.replaceChildren();
        view.changeSummary.replaceChildren();
        renderCharts(view, model);
        renderRows(view.tableBody, model);
        return;
      }
      renderModel(view, model);
    }).catch((error) => {
      if (activeView === view && view.refreshGeneration === refreshGeneration) showError(view, error);
    });
  }

  function open(configs, trigger) {
    const doc = root.document;
    if (!doc || !doc.body) return;
    if (activeView) {
      activeView.panel.querySelector(".history-close").focus();
      return;
    }
    const safeConfigs = Array.isArray(configs) ? configs.slice() : [];
    const view = buildPanel(doc, safeConfigs, trigger || doc.activeElement);
    view.doc = doc;
    view.configs = safeConfigs;
    view.onKeydown = (event) => {
      if (event.key === "Escape") { event.preventDefault(); close(); return; }
      if (event.key !== "Tab") return;
      const focusable = [...view.panel.querySelectorAll('button:not([disabled]), select, [href], [tabindex]:not([tabindex="-1"])')]
        .filter((node) => !node.hidden && node.getAttribute("aria-hidden") !== "true");
      if (!focusable.length) { event.preventDefault(); view.panel.focus(); return; }
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && (doc.activeElement === first || doc.activeElement === view.panel)) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && doc.activeElement === last) {
        event.preventDefault(); first.focus();
      }
    };
    view.close.addEventListener("click", close);
    view.back.addEventListener("click", () => {
      view.accountSelect.value = "all";
      view.focusScope = true;
      refresh(view);
    });
    view.overlay.addEventListener("click", (event) => { if (event.target === view.overlay) close(); });
    view.accountSelect.addEventListener("change", () => refresh(view));
    view.periodSelect.addEventListener("change", () => refresh(view));
    doc.addEventListener("keydown", view.onKeydown);
    activeView = view;
    observeChartResize(view);
    const storageChanges = root.chrome && root.chrome.storage && root.chrome.storage.onChanged;
    if (storageChanges && typeof storageChanges.addListener === "function" && typeof storageChanges.removeListener === "function") {
      view.onStorageChanged = (changes, areaName) => {
        if (activeView === view && areaName === "local" && changes &&
            [STORAGE_KEY, PLATFORMS_KEY].some((key) => Object.prototype.hasOwnProperty.call(changes, key))) refresh(view);
      };
      storageChanges.addListener(view.onStorageChanged);
    }
    view.close.focus();
    refresh(view);
  }

  return {
    STORAGE_KEY,
    MAX_COUNTER_GAP_MS,
    STALE_SNAPSHOT_MS,
    normalizeHistory,
    collectSeries,
    buildViewModel,
    formatCurrency,
    formatNumber,
    formatDate,
    formatDateTime,
    renderChart,
    open,
    close,
  };
});
