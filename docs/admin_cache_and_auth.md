# 管理后台防缓存机制与登录认证安全指南

## 1. 概述

本指南详细记录了 **edgetunnel** 在管理后台（`/admin`）访问链路上的**浏览器强缓存防护策略**，以及**用户会话（Cookie）认证与重定向机制**的技术原理。

---

## 2. 浏览器强缓存问题与解决方案

### 2.1 历史问题复盘
在早期的边缘 Worker 反向代理或重定向模式中，用户常遇到以下典型故障：
1. **伪装页强缓存陷阱**：在未登录或直接访问根路径时，浏览器获取并强缓存了 Nginx 默认伪装页或静态 404 页面。当用户后续再访问 `/admin` 或 `/login` 时，浏览器直接读取本地 Disk Cache，误认为整个站点均为静态伪装页，无法唤起管理后台。
2. **后台旧代码缓存**：管理后台静态 HTML 页面更新后，浏览器未触发协商缓存，仍渲染本地旧版本，导致新特性（如动态添加生成器输入框）不生效。

### 2.2 防缓存请求头注入策略

在 [`_worker.js`](file:///E:/workspace/me/edgetunnel/_worker.js) 的关键出口路由中，全部注入了最严格的防缓存与即时验证 HTTP 标头：

#### (1) `/admin` 页面代理响应头
```http
Cache-Control: no-store, no-cache, must-revalidate, proxy-revalidate
Pragma: no-cache
Expires: 0
```
- `no-store`：严禁客户端和任何中间代理服务器缓存响应的任何部分。
- `no-cache`：每次使用前必须向上游验证。
- `must-revalidate`：缓存过期后不可使用过时副本。

#### (2) 根路径伪装页响应头
在返回 Nginx 伪装页面时，同样设置：
```javascript
new Headers({
    'Content-Type': 'text/html; charset=UTF-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Pragma': 'no-cache'
})
```
确保伪装页面不会污染浏览器的路由上下文。

---

## 3. 登录与身份验证流程剖析

### 3.1 为什么直接访问 `/login` 会自动跳转到 `/admin`？

在 [`_worker.js`](file:///E:/workspace/me/edgetunnel/_worker.js) 的路由逻辑中，对 `/login` 请求进行了**会话状态预检**：

```javascript
if (访问路径 === 'login') {
    if (!管理员密码) return fetch(Pages静态页面 + '/noADMIN').then(...);
    
    const cookies = request.headers.get('Cookie') || '';
    const authCookie = cookies.split(';').find(c => c.trim().startsWith('auth='))?.split('=')[1];
    
    // 若当前客户端已持有有效的 auth Cookie，直接 302 重定向至 /admin
    if (authCookie == await MD5MD5(UA + 加密秘钥 + 管理员密码)) {
        return new Response('重定向中...', { 
            status: 302, 
            headers: { 'Location': '/admin' } 
        });
    }
    
    // 未登录时，才展示登录输入页面
    ...
}
```

**原理解释**：
- 如果您的浏览器曾经成功登录过管理后台，浏览器会保留一个有效期为 24 小时（`Max-Age=86400`）的 `auth` Cookie。
- 此时用户在地址栏手动输入 `域名/login` 时，Worker 校验发现 Cookie 依然合法有效，判定无需重复输入密码，**自动 302 重定向到 `/admin` 页面**。这是专为提升管理效率而设计的正常会话保持机制。

### 3.2 身份凭证签名与安全性设计

`auth` Cookie 的值采用了单向加盐散列签名：
$$\text{Cookie Value} = \text{MD5}(\text{User-Agent} + \text{KEY} + \text{ADMIN})$$

- **绑定 User-Agent**：Cookie 仅在生成它的特定浏览器环境下生效。即使 Cookie 被意外泄露，攻击者若使用不同的客户端或 UA，哈希比对也将失败，有效防止了会话劫持。
- **加盐双密保**：签名同时融合了环境变量 `KEY` 与 `ADMIN` 密码。管理员一旦修改密码，旧的 Cookie 立即全域失效。
- **安全标记保护**：在 HTTPS 环境下自动配置 `HttpOnly; Secure; SameSite=Lax`，杜绝 XSS 脚本窃取 Cookie。

### 3.3 退出登录流程

当需要强制登出或切换账号时：
- 访问 `域名/logout`；
- Worker 会重置 Cookie：
  ```http
  Set-Cookie: auth=; Path=/; Max-Age=0; HttpOnly
  ```
- 随后重定向至 `/login`，此时浏览器已无有效认证 Cookie，便会正常展示登录输入表单。

---

## 4. 常见排查与运维建议

1. **首次更新后建议**：
   - 如果浏览器之前强行记录了伪装页，可按 `F12` 打开开发者工具，在“网络”选项卡勾选“停用缓存 (Disable cache)”，然后刷新页面；
   - 或者使用浏览器的“无痕/隐身窗口”直接访问 `https://your-domain/admin`。
2. **多设备登录注意事项**：
   - 由于签名机制绑定了 User-Agent，不同设备或不同浏览器（如 Chrome 与 Safari）均需各自登录一次并维护独立的 Cookie。
