// ===== NewAPI 站点性能指标 · 只读探针 v2 =====
// v1 失败原因：新版 NewAPI (v1.0.0-rc.x) 的后台接口不再用 cookie 鉴权，
// 而是要求 Authorization: Bearer <token>。本版会自动用 cookie 换取 token。
//
// 用法（二选一）：
//   A. 在目标站已登录的页面 F12 → Console → 粘贴全文回车（自动换 token）
//   B. 若 A 失败，先执行一行：window.PROBE_TOKEN = '你的系统访问令牌'
//      然后再粘贴本文件全文。
//
// 全部为只读请求（唯一的 POST 是 /api/user/auth/refresh，属于续期，不改数据、不触发签到）。
// 独立调研工具，与扩展代码无关，验证完可删除 tools 目录。
(async () => {
  const log = (...a) => console.log('%c[probe]', 'color:#2563eb;font-weight:bold', ...a);
  const bad = (...a) => console.log('%c[probe]', 'color:#dc2626;font-weight:bold', ...a);
  const good = (...a) => console.log('%c[probe]', 'color:#16a34a;font-weight:bold', ...a);

  let TOKEN = (typeof window !== 'undefined' && window.PROBE_TOKEN) || '';
  let USER_ID = '';

  function deepFind(obj, keys, depth) {
    if (!obj || typeof obj !== 'object' || (depth || 0) > 5) return null;
    for (const k of keys) if (typeof obj[k] === 'string' && obj[k].length > 8) return obj[k];
    for (const v of Object.values(obj)) {
      const r = deepFind(v, keys, (depth || 0) + 1);
      if (r) return r;
    }
    return null;
  }
  function deepFindId(obj, depth) {
    if (!obj || typeof obj !== 'object' || (depth || 0) > 5) return null;
    if (obj.user && obj.user.id != null) return String(obj.user.id);
    if (obj.id != null && (obj.username || obj.display_name)) return String(obj.id);
    for (const v of Object.values(obj)) {
      const r = deepFindId(v, (depth || 0) + 1);
      if (r) return r;
    }
    return null;
  }

  async function req(p, method) {
    const t0 = performance.now();
    const headers = { Accept: 'application/json, text/plain, */*', 'Cache-Control': 'no-store' };
    if (TOKEN) headers.Authorization = 'Bearer ' + TOKEN;
    if (USER_ID) headers['New-API-User'] = USER_ID;
    if (method === 'POST') headers['Content-Type'] = 'application/json';
    try {
      const res = await fetch(p, {
        method: method || 'GET',
        credentials: 'include',
        headers,
        body: method === 'POST' ? '{}' : undefined,
      });
      const ms = Math.round(performance.now() - t0);
      const ct = String(res.headers.get('content-type') || '').split(';')[0];
      const text = await res.text();
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch {}
      return { ok: res.ok, status: res.status, ms, ct, body, raw: text,
               isHtml: ct.includes('text/html') || /^\s*<!doctype|^\s*<html[\s>]/i.test(text) };
    } catch (e) {
      return { ok: false, status: 0, ms: Math.round(performance.now() - t0), err: String(e && e.message || e) };
    }
  }

  log('目标站点:', location.origin);

  // ---------- 1. 站点能力预检（匿名可读）----------
  const st = await req('/api/status');
  if (!st.ok || !st.body || !st.body.data) { bad('/api/status 不可用 → HTTP ' + st.status); return; }
  const d = st.body.data;
  log('版本:', d.version, '| 站点:', d.system_name, '| quota_per_unit:', d.quota_per_unit);
  let nav = d.HeaderNavModules;
  if (typeof nav === 'string') { try { nav = JSON.parse(nav); } catch {} }
  const pricing = nav && nav.pricing;
  log('pricing 模块:', pricing == null ? '字段缺失（疑似旧版）' : JSON.stringify(pricing));

  // ---------- 2. 取得 access token ----------
  if (TOKEN) {
    good('使用你手动提供的 PROBE_TOKEN。');
  } else {
    log('尝试用当前 cookie 会话换取 access token（POST /api/user/auth/refresh）…');
    const rf = await req('/api/user/auth/refresh', 'POST');
    if (rf.ok && rf.body) {
      TOKEN = deepFind(rf.body, ['access_token', 'accessToken', 'token']);
      USER_ID = deepFindId(rf.body) || '';
      if (TOKEN) {
        good('换取成功！token 前缀:', TOKEN.slice(0, 12) + '…', '| 用户ID:', USER_ID || '(未取到)');
        log('refresh 响应结构:', Object.keys(rf.body), rf.body.data ? '| data 内: ' + Object.keys(rf.body.data) : '');
      } else {
        bad('refresh 成功但没找到 token 字段。完整响应见下，请贴给我：');
        console.log(rf.body);
        return;
      }
    } else {
      bad('refresh 失败 → HTTP ' + rf.status + ' ' + ((rf.body && rf.body.message) || rf.err || ''));
      bad('请确认此页面已登录；若已登录仍失败，改用方式 B：');
      bad("  window.PROBE_TOKEN = '你的系统访问令牌'  然后重新粘贴本脚本。");
      return;
    }
  }

  // ---------- 3. 验证 token 可用 ----------
  const self = await req('/api/user/self');
  if (self.ok && self.body && self.body.data) {
    if (!USER_ID && self.body.data.id != null) USER_ID = String(self.body.data.id);
    good('鉴权通过。用户:', self.body.data.username || self.body.data.display_name, '| ID:', USER_ID);
  } else {
    bad('/api/user/self → HTTP ' + self.status + ' ' + ((self.body && self.body.message) || ''));
    bad('token 可能无效，后续结果仅供参考。');
  }

  // ---------- 4. perf-metrics 概览 ----------
  const sum = await req('/api/perf-metrics/summary?hours=24');
  log('/api/perf-metrics/summary → HTTP ' + sum.status + ' (' + sum.ms + 'ms)');
  if (sum.status === 404) { bad('404：该站点版本不支持 perf-metrics。'); return; }
  if (!sum.ok || !sum.body || !sum.body.data) {
    bad('异常：' + ((sum.body && sum.body.message) || (sum.raw || '').slice(0, 200)));
    return;
  }
  const models = sum.body.data.models || [];
  good('拿到 ' + models.length + ' 个模型的指标。');
  log('字段样例:', models[0]);
  const rows = models.map(m => ({
    模型: m.model_name,
    成功率: m.success_rate == null ? '—' : Number(m.success_rate).toFixed(2) + '%',
    平均延迟ms: m.avg_latency_ms ?? '—',
    TPS: m.avg_tps == null ? '—' : Number(m.avg_tps).toFixed(1),
    采样点: (m.recent_success_rates || []).length,
  }));
  rows.sort((a, b) => (parseFloat(b.成功率) || -1) - (parseFloat(a.成功率) || -1));
  console.table(rows.slice(0, 40));
  if (rows.length > 40) log('（仅显示前 40 行，共 ' + rows.length + '）');
  log('响应是否含 RPM/请求数字段:', /rpm|request_count|qps/i.test(Object.keys(models[0] || {}).join(',')), '（预期 false）');

  // ---------- 5. 单模型明细（TTFT + 时间序列）----------
  const target = models[0] && models[0].model_name;
  if (!target) return;
  const one = await req('/api/perf-metrics?model=' + encodeURIComponent(target) + '&hours=24');
  log('/api/perf-metrics?model=' + target + ' → HTTP ' + one.status + ' (' + one.ms + 'ms)');
  if (one.ok && one.body && one.body.data) {
    const dd = one.body.data;
    log('series_schema:', dd.series_schema);
    console.table((dd.groups || []).map(g => ({
      分组: g.group,
      首字延迟ms: g.avg_ttft_ms ?? '—',
      平均延迟ms: g.avg_latency_ms ?? '—',
      成功率: g.success_rate == null ? '—' : Number(g.success_rate).toFixed(2) + '%',
      TPS: g.avg_tps == null ? '—' : Number(g.avg_tps).toFixed(1),
      序列点数: (g.series || []).length,
    })));
    const s0 = dd.groups && dd.groups[0] && dd.groups[0].series;
    if (s0 && s0.length) log('时间序列样例（前3点）:', s0.slice(0, 3));
    else log('无时间序列数据（该站点近 24h 可能无流量）。');
  } else {
    bad('明细异常：' + ((one.body && one.body.message) || ''));
  }

  good('探测完成。');
})();
