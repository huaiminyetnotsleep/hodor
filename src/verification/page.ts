/**
 * 验证页面渲染（Turnstile 任务；design.md §4「GET /verify」）。
 *
 * 纯函数模块：只产出 HTML 与 CSP nonce，不发请求、不读库；路由层负责
 * no-store / Referrer-Policy / nosniff / CSP 响应头。
 *
 * 安全不变量：
 * - 动态插值只有 requestId（已按 64 hex 校验，仍转义）与公开 Site Key
 *   （转义）——Secret / Bot Token / initData 绝不出现在页面；
 * - 所有状态文案由服务端静态渲染（本文件常量），客户端 JS 只切换显隐，
 *   绝不把 API 响应体直接 innerHTML（杜绝注入面）；
 * - CSP：脚本只允许官方 telegram.org SDK、官方 challenges.cloudflare.com
 *   api.js 与本页 nonce 内联脚本；frame 只放行 Turnstile 挑战框；不设
 *   frame-ancestors 'none' / X-Frame-Options DENY（Telegram Mini App 需要
 *   嵌入本页，一刀切禁止嵌入会杀死入口）。
 */

/** 转义 HTML 文本上下文（属性插值统一走 escapeAttr = 同一转义 + 引号包裹） */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(value: string): string {
  return escapeHtml(value);
}

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let hex = "";
  for (const byte of buf) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/** 页面渲染产物：html 文本 + 与之一致的 CSP 头值（路由层直接透传） */
export interface RenderedVerifyPage {
  html: string;
  cspNonce: string;
  csp: string;
}

export interface VerifyPageOptions {
  /** 已通过格式校验的请求标识（GET /verify?r= 的原值） */
  requestId: string;
  /** Turnstile 公开 Site Key（可公开；Secret 绝不传入本模块） */
  siteKey: string;
}

const PAGE_STYLE = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
    "Hiragino Sans GB", "Microsoft YaHei", sans-serif; background: #f2f4f8; color: #17212b;
    display: flex; min-height: 100vh; align-items: center; justify-content: center; padding: 16px; }
  .card { background: #fff; border-radius: 14px; box-shadow: 0 2px 12px rgba(23,33,43,.08);
    max-width: 24rem; width: 100%; padding: 24px 20px; text-align: center; }
  h1 { font-size: 1.05rem; margin: 0 0 12px; }
  p { font-size: .9rem; line-height: 1.6; margin: 0 0 10px; word-break: break-word; }
  .hint { color: #6b7684; font-size: .8rem; }
  #cf-turnstile { display: flex; justify-content: center; margin: 12px 0; min-height: 65px; }
  button { font: inherit; font-size: .9rem; padding: 8px 20px; border-radius: 8px; border: none;
    background: #3390ec; color: #fff; cursor: pointer; margin-top: 8px; }
  button:disabled { opacity: .5; cursor: default; }
  [hidden] { display: none !important; }
`;

const PAGE_SCRIPT = `
(function () {
  "use strict";
  var cfg = { requestId: "__REQUEST_ID__", siteKey: "__SITE_KEY__" };
  var submitting = false;

  function show(id) {
    var states = document.querySelectorAll(".state");
    for (var i = 0; i < states.length; i++) states[i].hidden = true;
    var el = document.getElementById(id);
    if (el) el.hidden = false;
  }

  var tg = window.Telegram && window.Telegram.WebApp;
  if (tg) { try { tg.ready(); tg.expand(); } catch (e) { /* 展示参数失败不影响流程 */ } }
  var initData = tg && typeof tg.initData === "string" ? tg.initData : "";
  if (!initData) { show("st-noinit"); return; }

  show("st-waiting");

  var widgetId = null;
  var token = null;

  function onSubmit(value) {
    if (submitting || typeof value !== "string" || value === "") return;
    token = value;
    submit(0);
  }

  function scheduleRetry(delayMs, attempt) {
    show("st-waiting");
    setTimeout(function () { if (token) submit(attempt); }, delayMs);
  }

  function submit(attempt) {
    if (submitting || !token) return;
    submitting = true;
    show("st-submitting");
    fetch("/api/verify/turnstile", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId: cfg.requestId, initData: initData, turnstileToken: token })
    }).then(function (res) {
      submitting = false;
      if (res.status === 200) { show("st-success"); return; }
      if (res.status === 401) { show("st-identity"); return; }
      if (res.status === 403) { show("st-forbidden"); return; }
      if (res.status === 404 || res.status === 409 || res.status === 410 || res.status === 413) { show("st-expired"); return; }
      if (res.status === 422) { tokenRejected(); return; }
      if (res.status === 429) {
        var wait = 5;
        try {
          var header = parseInt(res.headers.get("retry-after") || "", 10);
          if (!isNaN(header) && header > 0) wait = Math.min(15, header);
        } catch (e) { /* 保持默认等待 */ }
        if (attempt < 2) { scheduleRetry(wait * 1000, attempt + 1); return; }
        show("st-error");
        return;
      }
      if (res.status === 503) {
        if (attempt < 1) { scheduleRetry(2000, attempt + 1); return; }
        show("st-error");
        return;
      }
      show("st-error");
    }).catch(function () {
      submitting = false;
      if (attempt < 2) { scheduleRetry(2000, attempt + 1); return; }
      show("st-error");
    });
  }

  function tokenRejected() {
    token = null;
    show("st-tokenerror");
    try {
      if (widgetId !== null && window.turnstile) { window.turnstile.reset(widgetId); }
    } catch (e) { /* 组件可能尚未挂载：重试按钮可重建 */ }
  }

  function renderWidget() {
    var el = document.getElementById("cf-turnstile");
    if (!el || !window.turnstile) return;
    try {
      el.innerHTML = "";
      widgetId = window.turnstile.render(el, {
        sitekey: cfg.siteKey,
        action: "hodor_verify",
        cData: cfg.requestId,
        callback: onSubmit,
        "error-callback": function () { tokenRejected(); },
        "expired-callback": function () { tokenRejected(); },
        "timeout-callback": function () { tokenRejected(); }
      });
    } catch (e) { show("st-error"); }
  }

  window.__hodorTurnstileLoad = function () { renderWidget(); };
  renderWidget();

  var retry = document.getElementById("btn-retry");
  if (retry) {
    retry.addEventListener("click", function () {
      widgetId = null;
      renderWidget();
      show("st-waiting");
    });
  }
})();
`;

/**
 * 渲染验证页面（HTML + CSP nonce）。页面 JS 流程：
 * 缺 initData → 只显示「从 Bot 打开」，绝不发请求；有身份 → 显式渲染
 * Turnstile（action=hodor_verify，cdata=requestId）→ 拿到 token 自动提交 →
 * 按稳定状态码切换服务端预渲染的状态文案。
 */
export function renderVerifyPage(options: VerifyPageOptions): RenderedVerifyPage {
  const cspNonce = randomHex(24);
  const script = PAGE_SCRIPT.replace("__REQUEST_ID__", escapeAttr(options.requestId)).replace(
    "__SITE_KEY__",
    escapeAttr(options.siteKey),
  );
  const csp = [
    "default-src 'none'",
    `script-src https://telegram.org https://challenges.cloudflare.com 'nonce-${cspNonce}'`,
    `style-src 'nonce-${cspNonce}'`,
    "img-src 'self' data:",
    "frame-src https://challenges.cloudflare.com",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>人机验证</title>
<style nonce="${cspNonce}">${PAGE_STYLE}</style>
</head>
<body>
<main class="card">
<h1>人机验证</h1>

<p class="state" id="st-loading">正在加载…</p>

<p class="state" id="st-noinit" hidden>请从 Bot 聊天窗口的「打开验证页面」按钮打开本页。<br>直接在浏览器中打开无法完成验证。</p>

<p class="state" id="st-waiting" hidden>正在准备人机验证组件…</p>

<p class="state" id="st-submitting" hidden>正在提交验证结果…</p>

<div id="cf-turnstile"></div>

<p class="state" id="st-success" hidden>✅ 验证通过！请返回聊天窗口重新发送消息，客服会尽快回复。</p>

<p class="state" id="st-identity" hidden>身份信息已过期（页面打开超过 5 分钟）。<br>请关闭本页面，回到 Bot 聊天窗口点击「打开验证页面」按钮重新打开。</p>

<p class="state" id="st-expired" hidden>验证链接已过期或已被使用。<br>请回到 Bot 聊天窗口发送任意消息重新获取验证。</p>

<p class="state" id="st-forbidden" hidden>无法完成验证：当前账号与验证请求不符。<br>请回到 Bot 聊天窗口重新发起验证。</p>

<p class="state" id="st-tokenerror" hidden>人机验证未完成，请重新尝试。<span id="btn-retry-wrap"><br><button type="button" id="btn-retry">重新验证</button></span></p>

<p class="state" id="st-error" hidden>验证服务暂时不可用，请稍后重试；多次失败请联系客服。</p>
</main>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&amp;onload=__hodorTurnstileLoad" async defer></script>
<script nonce="${cspNonce}">${script}</script>
</body>
</html>`;

  return { html, cspNonce, csp };
}
