// 界面与 Service Worker 共用鉴权协议。Linux DO 和 GitHub 只有 provider 不同。
(function (root) {
  const providers = Object.freeze({ agentrouter_token: "github", agentrouter_linuxdo: "linuxdo" });
  const modes = Object.freeze(["token", "cookie", "password", ...Object.keys(providers)]);
  root.NACheckinAuth = Object.freeze({
    build: "1.7.5-auth-v6",
    modes,
    isVisitOnly(p) { return !!p && p.visitOnly === true; },
    isAgentRouterMode(mode) { return Object.prototype.hasOwnProperty.call(providers, mode); },
    agentRouterProvider(mode) { return providers[mode] || "github"; },
  });
})(globalThis);
