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
  const DAY_MS = 24 * 60 * 60 * 1000;
  const MAX_COUNTER_GAP_MS = 7 * DAY_MS;
  const STALE_SNAPSHOT_MS = 36 * 60 * 60 * 1000;
  const DUPLICATE_SAMPLE_WINDOW_MS = 60 * 1000;
  const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
  const SVG_NS = "http://www.w3.org/2000/svg";

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

  function dedupeSamples(samples) {
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
      // identical. Keep the earlier timestamp as the comparison baseline.
      if (previous && sample.at - previous.at < DUPLICATE_SAMPLE_WINDOW_MS && sameSampleValues(previous, sample)) continue;
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
      duplicateConfigs: Math.max(0, group.configs - 1),
      samples: dedupeSamples(group.samples),
    }));
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

  /** Pure view-model builder, also used by the offline regression tests. */
  function buildViewModel(historyInput, configs, options = {}) {
    const now = finite(options.now) ? options.now : Date.now();
    const days = Number(options.days) === 7 ? 7 : 30;
    const start = now - days * DAY_MS;
    const history = normalizeHistory(historyInput, now);
    const allSeries = collectSeries(history, configs, { now });
    const identity = options.identity && options.identity !== "all" ? String(options.identity) : "all";
    const series = identity === "all" ? allSeries : allSeries.filter((account) => account.identity === identity);
    const events = [...new Set(series.flatMap((account) => account.samples
      .filter((sample) => sample.at >= start && sample.at <= now).map((sample) => sample.at)))].sort((a, b) => a - b);

    const balancePoints = events.map((at) => {
      let total = 0, known = 0, stale = 0;
      for (const account of series) {
        const sample = latestAtOrBefore(account.samples, at);
        if (!sample || sample.balance === null) continue;
        total += sample.balance;
        known++;
        if (at - sample.at > STALE_SNAPSHOT_MS) stale++;
      }
      return { at, value: known ? total : null, known, missing: Math.max(0, series.length - known), stale, totalSeries: series.length };
    }).filter((point) => point.value !== null);

    let balanceTotal = 0, balanceKnown = 0, balanceStale = 0;
    const latestSnapshots = series.map((account) => {
      const sample = latestAtOrBefore(account.samples, now);
      if (sample && sample.balance !== null) {
        balanceTotal += sample.balance;
        balanceKnown++;
        if (now - sample.at > STALE_SNAPSHOT_MS) balanceStale++;
      }
      return { account, sample };
    });

    const used = counterChanges(series, start, now, "used");
    const tokens = counterChanges(series, start, now, "tokens");
    const inRangeSamples = series.flatMap((account) => account.samples
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
      inRangeSamples,
      balancePoints,
      latestBalance: { value: balanceKnown ? balanceTotal : null, known: balanceKnown, missing: Math.max(0, series.length - balanceKnown), stale: balanceStale, totalSeries: series.length },
      latestSnapshots,
      newestSampleAt: series.reduce((latest, account) => account.samples.length ? Math.max(latest, account.samples[account.samples.length - 1].at) : latest, 0) || null,
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

  function renderChart(container, points, label, formatter, note, options = {}) {
    const doc = container.ownerDocument;
    container.replaceChildren();
    const valid = points.filter((point) => finite(point.value));
    if (!valid.length) {
      container.appendChild(emptyMessage(doc, "暂无可比较的数据", note));
      return;
    }

    // The viewBox is expressed in the container's CSS-pixel width. This keeps
    // 11px SVG labels readable on a phone and in the half-width desktop charts.
    const width = measuredChartWidth(container), height = 214, right = 8, top = 16, bottom = 34;
    const compact = width < 520;
    const axisFormatter = typeof options.axisFormatter === "function" ? options.axisFormatter : formatter;
    let min = Math.min(...valid.map((point) => point.value));
    let max = Math.max(...valid.map((point) => point.value));
    if (min === max) {
      const pad = Math.max(Math.abs(max) * 0.08, 1);
      min -= pad;
      max += pad;
    } else {
      const pad = (max - min) * 0.08;
      min -= pad;
      max += pad;
    }
    const ticks = Array.from({ length: 4 }, (_, index) => ({
      ratio: index / 3,
      value: max - (max - min) * (index / 3),
    }));
    const tickLabels = ticks.map((tick) => axisFormatter(tick.value, width));
    const widestTick = Math.max(...tickLabels.map((text) => String(text).length));
    const left = Math.max(44, Math.min(104, Math.ceil(widestTick * 6.1 + 12)));
    const plotWidth = width - left - right, plotHeight = height - top - bottom;
    const firstAt = valid[0].at, lastAt = valid[valid.length - 1].at;
    const x = (at) => left + (lastAt === firstAt ? plotWidth / 2 : (at - firstAt) / (lastAt - firstAt) * plotWidth);
    const y = (value) => top + (max - value) / (max - min) * plotHeight;
    const svg = svgElement(doc, "svg", { viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": label, focusable: "false" });
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

    const segments = [];
    let segment = [];
    for (const point of valid) {
      if (point.breakBefore && segment.length) {
        segments.push(segment);
        segment = [];
      }
      segment.push(point);
    }
    if (segment.length) segments.push(segment);
    for (const pointsInSegment of segments) {
      const pathData = pointsInSegment.map((point, index) => `${index ? "L" : "M"}${x(point.at).toFixed(2)},${y(point.value).toFixed(2)}`).join(" ");
      svg.appendChild(svgElement(doc, "path", { d: pathData, class: "history-chart-line" }));
    }
    const isolatedPoints = new Set(segments.filter((pointsInSegment) => pointsInSegment.length === 1).map((pointsInSegment) => pointsInSegment[0]));
    for (const point of valid) {
      if (valid.length <= 36 || point.breakBefore || isolatedPoints.has(point)) {
        const circle = svgElement(doc, "circle", { cx: x(point.at), cy: y(point.value), r: 3.5, class: "history-chart-dot" });
        const tooltip = svgElement(doc, "title");
        tooltip.textContent = `${formatDateTime(point.at)} · ${formatter(point.value)}${point.breakBefore ? " · 与前段不可比较" : ""}${point.missing ? ` · ${point.missing} 个账号缺失` : ""}${point.stale ? ` · ${point.stale} 个快照较旧` : ""}`;
        circle.appendChild(tooltip);
        svg.appendChild(circle);
      }
    }
    const dateLabelMinGap = compact ? 72 : 92;
    const desiredCount = Math.min(5, valid.length, Math.max(valid.length > 1 ? 2 : 1, Math.floor(plotWidth / dateLabelMinGap) + 1));
    const labelIndices = valid.length === 1 ? [0] : [0];
    for (let index = 1; index < desiredCount - 1; index++) {
      const candidate = Math.round(index * (valid.length - 1) / (desiredCount - 1));
      if (x(valid[candidate].at) - x(valid[labelIndices[labelIndices.length - 1]].at) >= dateLabelMinGap
        && x(valid[valid.length - 1].at) - x(valid[candidate].at) >= dateLabelMinGap) labelIndices.push(candidate);
    }
    if (valid.length > 1) labelIndices.push(valid.length - 1);
    for (let index = 0; index < labelIndices.length; index++) {
      const pointIndex = labelIndices[index];
      const item = valid[pointIndex];
      const anchor = labelIndices.length === 1 ? "middle" : pointIndex === 0 ? "start" : pointIndex === valid.length - 1 ? "end" : "middle";
      const axisLabel = svgElement(doc, "text", { x: x(item.at), y: height - 10, "text-anchor": anchor, class: "history-axis-label" });
      axisLabel.textContent = formatChartDate(item.at, compact);
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

  function renderRows(tbody, model) {
    const doc = tbody.ownerDocument;
    tbody.replaceChildren();
    if (!model.inRangeSamples.length) {
      const row = element(doc, "tr");
      const cell = element(doc, "td", "history-table-empty", "所选时间范围内没有样本；更早的最新余额不会伪装成区间内走势。");
      cell.colSpan = 6;
      row.appendChild(cell);
      tbody.appendChild(row);
      return;
    }
    for (const { account, sample } of model.inRangeSamples) {
      const row = element(doc, "tr");
      const values = [
        formatDateTime(sample.at),
        account.label,
        formatCurrency(sample.balance),
        formatCurrency(sample.used),
        sample.monthlyTokens === null ? "—" : `${formatNumber(sample.monthlyTokens)}${sample.month ? ` · ${sample.month}` : ""}`,
        sampleStatus(sample),
      ];
      for (const value of values) row.appendChild(element(doc, "td", "", value));
      tbody.appendChild(row);
    }
  }

  function completenessText(model, now = Date.now()) {
    const parts = [];
    if (model.startedAt !== null && model.startedAt > model.start) {
      parts.push(`本地采样从 ${formatDate(model.startedAt)} 开始，所选区间更早部分没有历史；不会追溯旧缓存。`);
    }
    if (model.latestBalance.totalSeries) {
      parts.push(`最新余额覆盖 ${model.latestBalance.known}/${model.latestBalance.totalSeries} 个不同身份；${model.latestBalance.missing} 个缺失${model.latestBalance.stale ? `，${model.latestBalance.stale} 个最新快照超过 36 小时未更新（可能过旧）` : ""}。`);
    } else {
      parts.push("没有与当前配置匹配的历史身份或样本。");
    }
    parts.push("金额按美元显示；使用金额只由累计 used 的非负差分计算，不从余额下降推算。Token 只在同一月份、未截断且未回退的连续快照间差分；跨月、回退、缺失或间隔过长均视为断点。缺失值不会补成 0。 ");
    return parts.join(" ");
  }

  function renderCharts(view, model) {
    renderChart(view.balanceChart, model.balancePoints, "余额走势（每个采样时刻按身份各取一个最近快照；旧快照会标注）", formatCurrency,
      "当前范围没有余额样本。首次历史只从更新后签到、访问或刷新统计取得真实新读数时开始，不补录之前的缓存。",
      { axisFormatter: formatChartCurrency });
    renderChart(view.usedChart, model.used.points.map((point) => Object.assign({}, point, { value: point.cumulative })), "已用金额可比较片段累计（非完整区间消耗）", formatCurrency,
      "至少需要两次间隔不超过 7 天且已用值不回退的真实快照；余额下降不计作使用金额。",
      {
        axisFormatter: formatChartCurrency,
        footnote: "仅累计可比较的 used 非负差分片段，不代表完整区间消耗；已用缺失、回退或间隔超过 7 天时，折线会在后续可比较点处断开。",
      });
    renderChart(view.tokenChart, model.tokens.points.map((point) => Object.assign({}, point, { value: point.cumulative })), "Token 可比较片段累计（非完整区间消耗）", formatNumber,
      "需要同一 Token 月份内至少两次未截断、未回退且间隔不超过 7 天的真实快照；跨月或计数回退会断开比较。",
      {
        axisFormatter: formatChartNumber,
        footnote: "仅累计同月、未截断且未回退的可比较 Token 差分片段，不代表完整区间消耗；跨月、缺失、截断、回退或间隔超过 7 天时，折线会断开。",
      });
  }

  function renderModel(view, model) {
    const doc = view.panel.ownerDocument;
    const balanceDetail = model.latestBalance.totalSeries
      ? `最新快照${model.newestSampleAt ? ` · ${formatDateTime(model.newestSampleAt)}（${timeAgo(model.newestSampleAt)}）` : ""} · ${model.latestBalance.known}/${model.latestBalance.totalSeries} 个身份有余额${model.latestBalance.stale ? ` · ${model.latestBalance.stale} 个较旧` : ""}`
      : "尚无可用余额快照";
    const usedValue = model.used.total === null ? "—" : `+${formatCurrency(model.used.total)}`;
    const tokenValue = model.tokens.total === null ? "—" : `+${formatNumber(model.tokens.total)}`;
    const usedDetail = `仅可比较片段之和，不是完整区间消耗${model.used.breaks || model.used.missingComparisons
      ? ` · ${model.used.breaks} 个回退/间隔断点 · ${model.used.missingComparisons} 个不可比较` : ""}`;
    const tokenDetail = `仅可比较片段之和，不是完整区间消耗${model.tokens.monthBoundaries || model.tokens.breaks || model.tokens.truncatedComparisons || model.tokens.missingComparisons
      ? ` · ${model.tokens.monthBoundaries} 次跨月 · ${model.tokens.breaks} 次回退/间隔 · ${model.tokens.truncatedComparisons} 次截断 · ${model.tokens.missingComparisons} 个不可比较` : ""}`;
    view.summary.replaceChildren(
      summaryCard(doc, "最新余额（按身份去重）", formatCurrency(model.latestBalance.value), balanceDetail),
      summaryCard(doc, `${model.days} 天已用变化（可比较片段）`, usedValue, usedDetail),
      summaryCard(doc, `${model.days} 天 Token 变化（可比较片段）`, tokenValue, tokenDetail),
    );

    view.coverage.textContent = completenessText(model, Date.now());
    const rangeEnd = formatDate(model.end);
    const rangeStart = formatDate(model.start);
    view.range.textContent = `最近 ${model.days} 天：${rangeStart} 至 ${rangeEnd} · ${model.inRangeSamples.length} 条本地样本`;

    view.chartModel = model;
    view.chartWidthSignature = chartWidthSignature(view);
    renderCharts(view, model);
    renderRows(view.tableBody, model);
  }

  function readStoredHistory() {
    const storage = root.chrome && root.chrome.storage && root.chrome.storage.local;
    if (!storage || typeof storage.get !== "function") return Promise.reject(new Error("当前扩展页面无法读取本地历史存储。"));
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (result) => {
        if (settled) return;
        settled = true;
        const runtimeError = root.chrome && root.chrome.runtime && root.chrome.runtime.lastError;
        if (runtimeError) reject(new Error(runtimeError.message || "读取本地历史失败"));
        else resolve(result && result[STORAGE_KEY]);
      };
      try {
        const result = storage.get(STORAGE_KEY, done);
        if (result && typeof result.then === "function") result.then(done, (error) => {
          if (!settled) { settled = true; reject(error instanceof Error ? error : new Error(String(error))); }
        });
      } catch (error) {
        if (!settled) { settled = true; reject(error); }
      }
    });
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
    const close = element(doc, "button", "history-close", "关闭");
    close.type = "button";
    close.setAttribute("aria-label", "关闭历史图表");
    header.append(heading, close);
    panel.appendChild(header);

    const controls = element(doc, "div", "history-controls");
    const accountLabel = element(doc, "label", "history-control");
    accountLabel.appendChild(element(doc, "span", "", "查看范围"));
    const accountSelect = element(doc, "select", "");
    accountSelect.setAttribute("aria-label", "选择历史账号");
    const allOption = element(doc, "option", "", "全部账号汇总");
    allOption.value = "all";
    accountSelect.appendChild(allOption);
    const accountOptions = new Map();
    for (const config of configs) {
      if (!config || config.id === undefined || config.id === null) continue;
      const identity = identityFor(config);
      if (!identity || accountOptions.has(identity)) continue;
      const option = element(doc, "option", "", String(config.name || config.baseUrl || "账号"));
      option.value = identity;
      accountOptions.set(identity, option);
      accountSelect.appendChild(option);
    }
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
    periodSelect.value = "30";
    periodLabel.appendChild(periodSelect);
    controls.append(accountLabel, periodLabel);
    panel.appendChild(controls);

    const range = element(doc, "p", "history-range", "正在读取本地历史…");
    panel.appendChild(range);
    const summary = element(doc, "section", "history-summary");
    summary.setAttribute("aria-label", "所选范围摘要");
    panel.appendChild(summary);
    const coverage = element(doc, "p", "history-coverage");
    panel.appendChild(coverage);

    const charts = element(doc, "div", "history-charts");
    const chartEntries = [
      ["余额走势", "history-balance-chart"],
      ["使用金额累计变化", "history-used-chart"],
      ["Token 累计变化", "history-token-chart"],
    ];
    const chartContainers = {};
    for (const [title, key] of chartEntries) {
      const section = element(doc, "section", "history-chart-section");
      section.appendChild(element(doc, "h3", "", title));
      const chart = element(doc, "div", "history-chart-container");
      chart.setAttribute("aria-live", "polite");
      section.appendChild(chart);
      charts.appendChild(section);
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
    return { overlay, panel, close, accountSelect, periodSelect, range, summary, coverage, tableBody: tbody,
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
    for (const chart of [view.balanceChart, view.usedChart, view.tokenChart]) {
      chart.replaceChildren(emptyMessage(view.doc, "读取失败", "请确认扩展本地存储可用后重新打开面板。"));
    }
    view.summary.replaceChildren();
    view.tableBody.replaceChildren();
  }

  function refresh(view) {
    const refreshGeneration = (view.refreshGeneration || 0) + 1;
    view.refreshGeneration = refreshGeneration;
    readStoredHistory().then((raw) => {
      if (activeView !== view || view.refreshGeneration !== refreshGeneration) return;
      const model = buildViewModel(raw, view.configs, { days: Number(view.periodSelect.value), identity: view.accountSelect.value, now: Date.now() });
      if (!model.hasInRangeSamples && !model.latestBalance.known) {
        view.chartModel = null;
        view.range.textContent = "还没有可用的历史样本";
        view.coverage.textContent = "历史仅从更新后首次签到、仅访问或刷新统计取得真实新读数时开始积累；以前的账户缓存不会补录。请之后执行一次相应操作再查看。此面板只读本地存储，不会发网络请求或触发任务。";
        view.summary.replaceChildren();
        for (const chart of [view.balanceChart, view.usedChart, view.tokenChart]) {
          chart.replaceChildren(emptyMessage(view.doc, "尚无历史数据", "请在更新后执行签到、仅访问或刷新统计，积累真实新快照。"));
        }
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
    view.overlay.addEventListener("click", (event) => { if (event.target === view.overlay) close(); });
    view.accountSelect.addEventListener("change", () => refresh(view));
    view.periodSelect.addEventListener("change", () => refresh(view));
    doc.addEventListener("keydown", view.onKeydown);
    activeView = view;
    observeChartResize(view);
    const storageChanges = root.chrome && root.chrome.storage && root.chrome.storage.onChanged;
    if (storageChanges && typeof storageChanges.addListener === "function" && typeof storageChanges.removeListener === "function") {
      view.onStorageChanged = (changes, areaName) => {
        if (activeView === view && areaName === "local" && changes && Object.prototype.hasOwnProperty.call(changes, STORAGE_KEY)) refresh(view);
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
