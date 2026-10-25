// 界面与 Service Worker 共用鉴权协议。Linux DO 和 GitHub 只有 provider 不同。
(function (root) {
  const providers = Object.freeze({ agentrouter_token: "github", agentrouter_linuxdo: "linuxdo" });
  const modes = Object.freeze(["token", "cookie", "password", ...Object.keys(providers)]);
  root.NACheckinAuth = Object.freeze({
    build: "1.7.14-auth-v15",
    normalizeCheckinInterval(value) {
      if (!["number", "string"].includes(typeof value) || String(value).trim() === "") return 60;
      const n = Number(value);
      return Number.isInteger(n) && n >= 0 && n <= 3600 ? n : 60;
    },
    modes,
    isVisitOnly(p) { return !!p && p.visitOnly === true; },
    shouldLogoutAfterVisit(p) { return !!p && p.logoutAfterVisit === true; },
    isAgentRouterMode(mode) { return Object.prototype.hasOwnProperty.call(providers, mode); },
    agentRouterProvider(mode) { return providers[mode] || "github"; },
  });
})(globalThis);
