import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { type AdminAuthConfig, basicAuth } from "../middleware/basic-auth.js";

// admin.static-serve — Hono 在 /admin 托管 admin SPA 的静态产物（apps/admin/build/，
// 来自 adapter-static）。CLAUDE.md 原则1：gateway 只发静态文件，绝不在进程内跑
// SvelteKit SSR/运行时（不 import SvelteKit）。整个 /admin 先过 HTTP Basic（admin.auth），
// 未认证一律拦死，绝不先发文件再校验。
//
// 路径处理：本子应用通过 `app.route('/admin', mountAdminStatic(auth))` 挂载，但 Hono
// 在子应用里仍以**完整**路径（`/admin/...`）暴露 `c.req.path`，而 serveStatic 用该路径
// 去 root 下查文件。因此把 `/admin` 前缀剥掉，再以 `apps/admin/build` 为 root 解析——
// 与 admin.scaffold 的 `paths.base:'/admin'` 一致。
//
// SPA 深链接刷新（/admin/keys 等无对应物理文件的子路由）必须回落 index.html，由前端
// 路由接管，不能 404。`/admin/api/*` 是 admin.api 的端点：调用方在挂载本子应用**之前**
// 注册 API 路由（Hono 按注册顺序匹配），故子应用收不到 API 请求；这里的 fallback 仍对
// `/api/*` 放行（next()）作为纵深防御，避免被当成页面回 index.html。

// serveStatic 的 root 相对启动进程的 cwd（仓库根）解析。导出以便 server.ts 做
// 启动期「构建产物缺失」告警，避免路径字符串两处漂移。
export const ADMIN_BUILD_ROOT = "./apps/admin/build";
const INDEX_PATH = `${ADMIN_BUILD_ROOT}/index.html`;

// 剥掉挂载前缀，把 `/admin/_app/x.js` 映射到 `apps/admin/build/_app/x.js`；
// `/admin` 本身映射到 root 目录（serveStatic 会回落到 index.html）。
function stripAdminPrefix(path: string): string {
  const rest = path.replace(/^\/admin/, "");
  return rest === "" ? "/" : rest;
}

export function mountAdminStatic(auth: AdminAuthConfig): Hono {
  const admin = new Hono();

  // 1) 整个 /admin 先过 Basic（最前）：未认证 401 + WWW-Authenticate，不泄露内容。
  admin.use("*", basicAuth(auth));

  // 2) 命中真实文件（/admin/_app/...、.js/.css）→ 直接发该文件并带正确 MIME。
  admin.use(
    "/*",
    serveStatic({
      root: ADMIN_BUILD_ROOT,
      rewriteRequestPath: stripAdminPrefix,
    }),
  );

  // 3) SPA fallback：未命中物理文件的非 API 路由 → 回落 index.html（前端路由接管）。
  //    `/admin/api/*` 放行，避免吞掉 API 端点。
  admin.get("*", (c, next) => {
    if (c.req.path.startsWith("/admin/api/")) return next();
    return serveStatic({ path: INDEX_PATH })(c, next);
  });

  return admin;
}
