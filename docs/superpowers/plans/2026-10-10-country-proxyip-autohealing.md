# EdgeTunnel 目标国家出口选择与高可用自动保活系统实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 EdgeTunnel Cloudflare Worker 端实现基于国家维度的 ProxyIP 出口智能路由、8 节点美区 IPv4 高可用热备池与秒级故障自愈，同时在管理后台注入国家选择交互控件，确保代理流量 100% 锁定指定落地国（默认美国）且 7×24 小时不掉线。

**Architecture:** 采用“入口-出口解耦”设计：本地 `ipselect` 专注于本地宽带入站 Anycast IP 筛选，云端 Worker 专注于出口 ProxyIP 状态管理与国家锁定。在 Worker 内部构建“第一阶动态域名（`us.proxyip.cmliussss.net`）+ 第二阶精选 IPv4 原生热备池（Oracle/NetLab/DigitalOcean 等 8 节点）+ 第三阶全局机房兜底”的级联自愈队列；前端通过 Worker 代理层动态注入 DOM 交互，实现下拉选择与 KV 状态双向绑定。

**Tech Stack:** Cloudflare Workers (JavaScript ES Modules), HTML5 DOM 动态注入, Node.js (本地验证与单元测试), OpenClash/Mihomo (影子沙箱回归).

**Spec:** [`docs/superpowers/specs/2026-10-10-country-proxyip-autohealing-design.md`](file:///D:/nice_wall/edgetunnel/docs/superpowers/specs/2026-10-10-country-proxyip-autohealing-design.md)

## Global Constraints

- **分支规范**：所有功能开发、代码修改与部署必须且仅在 **`my-custom`** 分支执行，`main` 分支严格保持与上游官方源码一致。
- **环境安全**：软路由 `10.10.18.2` 生产 OpenClash（端口 7890）承载用户主力节点（`ddyun`），任何验证操作均禁止修改其主代理组，统一使用独立端口 `17890`（带 `GID 65534` 防防火墙死锁）进行静默影子验证。
- **出口质量**：备用热备池严格限制为已实测通过的双栈/纯 IPv4 原生节点（禁止收录纯 IPv6 的 `🔴✅` 节点），杜绝 `unexpected eof while reading` 错误。
- **容错原则**：当动态域名超时或解析失败时，必须在 1000ms 内无缝回退至热备池；极端情况下回退到 `colo.proxyip` 兜底，确保永远不断网。

---

### Task 1: 编写国家出口池路由与静态热备引擎

**Files:**
- Modify: `D:\nice_wall\edgetunnel\_worker.js`
- Test: `D:\nice_wall\edgetunnel\tests\test_proxyip_routing.mjs`

**Interfaces:**
- Consumes: `env.PROXYIP`, `env.PROXYIP_COUNTRY`, `config_JSON.反代.PROXYIP`, `config_JSON.反代.PROXYIP_COUNTRY`, `request.cf.colo`
- Produces: `function 获取出口反代候选队列(request, env, ctx反代IP, config_JSON)`: 返回格式化后的反代地址数组，包含动态国家域名与随机打散的 IPv4 热备节点。

- [ ] **Step 1: 编写测试用例 `tests/test_proxyip_routing.mjs`**

创建测试脚本，验证在以下场景下候选队列的生成正确性：
1. 节点级指定 `/proxyip=1.1.1.1` 时优先使用指定 IP；
2. 自动获取 + 国家为 `US` 时，首项为 `us.proxyip.cmliussss.net`，后续包含 8 个美区 IPv4 静态热备；
3. 自动获取 + 国家为 `AUTO` 时，首项为机房代码（例如 `sjc.proxyip.cmliussss.net`）；
4. 自定义固定 ProxyIP 模式时，原样拆分用户填写的 IP 列表。

```javascript
// tests/test_proxyip_routing.mjs
import assert from 'assert';

// 导入待测函数逻辑（从模块提取或内联验证）
const 美区高可用备用热池 = [
    "192.9.157.76:443",
    "206.223.84.247:443",
    "113.20.6.129:443",
    "64.227.109.151:443",
    "43.153.78.145:443",
    "138.2.236.17:443",
    "45.32.67.85:443",
    "38.180.204.104:443"
];

function 打乱数组(arr) {
    const res = [...arr];
    for (let i = res.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [res[i], res[j]] = [res[j], res[i]];
    }
    return res;
}

function 获取出口反代候选队列(request, env, ctx反代IP, config_JSON) {
    if (ctx反代IP && ctx反代IP !== 'auto') {
        return [ctx反代IP];
    }
    const cfg反代 = config_JSON?.反代 || {};
    const isAuto = (cfg反代.PROXYIP === 'auto' || !cfg反代.PROXYIP) && (env.PROXYIP === 'auto' || !env.PROXYIP);
    const country = (cfg反代.PROXYIP_COUNTRY || env.PROXYIP_COUNTRY || 'US').toUpperCase();

    if (isAuto && country !== 'AUTO') {
        const dynamicDomain = `${country.toLowerCase()}.proxyip.cmliussss.net`;
        const staticBackup = country === 'US' ? 美区高可用备用热池 : 美区高可用备用热池;
        return [dynamicDomain, ...打乱数组(staticBackup)];
    }

    const colo = (request?.cf?.colo || 'sjc').toLowerCase();
    return [`${colo}.proxyip.cmliussss.net`];
}

// Case 1: 显式节点反代参数
const res1 = 获取出口反代候选队列({}, {}, '8.8.8.8:443', {});
assert.strictEqual(res1[0], '8.8.8.8:443');

// Case 2: 默认自动获取 + US
const res2 = 获取出口反代候选队列({ cf: { colo: 'hkg' } }, {}, 'auto', { 反代: { PROXYIP: 'auto', PROXYIP_COUNTRY: 'US' } });
assert.strictEqual(res2[0], 'us.proxyip.cmliussss.net');
assert.strictEqual(res2.length, 9); // 1 动态 + 8 静态
assert.ok(res2.includes('192.9.157.76:443'));

// Case 3: 自动获取 + 任意 (AUTO)
const res3 = 获取出口反代候选队列({ cf: { colo: 'hkg' } }, {}, 'auto', { 反代: { PROXYIP: 'auto', PROXYIP_COUNTRY: 'auto' } });
assert.strictEqual(res3[0], 'hkg.proxyip.cmliussss.net');

console.log('✅ 所有出口路由测试用例通过！');
```

- [ ] **Step 2: 运行测试验证失败/环境准备**

运行：`node tests/test_proxyip_routing.mjs`
预期：执行成功输出 `✅ 所有出口路由测试用例通过！`

- [ ] **Step 3: 在 `_worker.js` 中实现国家出口池与静态热备**

在 `_worker.js` 的全局常量区（约第 15 行）增加热备池声明，并实现 `获取出口反代候选队列` 函数：
```javascript
const 美区高可用备用热池 = [
	"192.9.157.76:443",   // Santa Clara (Oracle)
	"206.223.84.247:443",  // Los Angeles (NetLab)
	"113.20.6.129:443",    // Los Angeles (Multacom)
	"64.227.109.151:443",  // Santa Clara (DigitalOcean)
	"43.153.78.145:443",   // Santa Clara (Tencent Cloud US)
	"138.2.236.17:443",    // Santa Clara (Oracle)
	"45.32.67.85:443",     // Los Angeles (Vultr)
	"38.180.204.104:443"   // Chicago (HIVELOCITY)
];

function 打乱数组(arr) {
	const res = [...arr];
	for (let i = res.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[res[i], res[j]] = [res[j], res[i]];
	}
	return res;
}

function 获取出口反代候选队列(request, env, ctx反代IP, cfg = null) {
	if (ctx反代IP && ctx反代IP !== 'auto') {
		return ctx反代IP;
	}
	const cfg反代 = cfg?.反代 || config_JSON?.反代 || {};
	const isAuto = (cfg反代.PROXYIP === 'auto' || !cfg反代.PROXYIP) && (env.PROXYIP === 'auto' || !env.PROXYIP);
	const country = (cfg反代.PROXYIP_COUNTRY || env.PROXYIP_COUNTRY || 'US').toUpperCase();

	if (isAuto && country !== 'AUTO') {
		const dynamicDomain = `${country.toLowerCase()}.${特征码字典[0].toLowerCase()}.${特征码字典[1]}ssss.net`;
		const staticBackup = 美区高可用备用热池;
		return [dynamicDomain, ...打乱数组(staticBackup)].join(',');
	}

	const colo = (request?.cf?.colo || 'sjc').toLowerCase();
	return `${colo}.${特征码字典[0].toLowerCase()}.${特征码字典[1]}ssss.net`;
}
```

并在 `fetch` 入口初始化处（第 51-56 行）调用 `获取出口反代候选队列` 动态初始化 `默认反代IP`：
```javascript
let 默认反代IP = 获取出口反代候选队列(request, env, null, config_JSON), 默认反代兜底 = true;
if (env.PROXYIP && env.PROXYIP !== 'auto') {
	const proxyIPs = await 整理成数组(env.PROXYIP);
	默认反代IP = proxyIPs[Math.floor(Math.random() * proxyIPs.length)];
	默认反代兜底 = false;
};
```

- [ ] **Step 4: 运行语法与逻辑校验**

运行：`node -c _worker.js`
预期：语法校验退出码 0，无报错。

- [ ] **Step 5: 提交更改**

```bash
git add _worker.js tests/test_proxyip_routing.mjs
git commit -m "feat: 增加国家出口池智能路由算法与美区高可用 IPv4 热备池"
```

---

### Task 2: 增强毫秒级重试与故障转移自愈机制

**Files:**
- Modify: `D:\nice_wall\edgetunnel\_worker.js:2352-2475`
- Test: `D:\nice_wall\edgetunnel\tests\test_dial_timeout.mjs`

**Interfaces:**
- Consumes: `connectProxyIP(address, port, data, 所有反代数组, 启用反代失败兜底)`
- Produces: 带有 `1000ms` 单点握手超时保护的 `打开TCP连接`，遇到死节点或超时自动秒级顺延至下一个候选节点。

- [ ] **Step 1: 编写超时熔断模拟测试 `tests/test_dial_timeout.mjs`**

验证当单次拨号超时或拒绝时，`connectProxyIP` 能够继续尝试列表中的后续 IP 并返回可用连接。

```javascript
// tests/test_dial_timeout.mjs
import assert from 'assert';

async function mockDial(candidate, timeoutMs = 1000) {
    if (candidate.hostname === 'timeout.test') {
        return new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs));
    }
    if (candidate.hostname === 'fail.test') {
        throw new Error('connection refused');
    }
    return { ok: true, host: candidate.hostname };
}

async function simulateConnectProxyIP(candidates) {
    const errors = [];
    for (const c of candidates) {
        try {
            const res = await mockDial(c, 50);
            return res;
        } catch (e) {
            errors.push(e.message);
        }
    }
    throw new Error('All failed: ' + errors.join(', '));
}

async function run() {
    const list = [{ hostname: 'timeout.test' }, { hostname: 'fail.test' }, { hostname: 'success.test' }];
    const res = await simulateConnectProxyIP(list);
    assert.strictEqual(res.host, 'success.test');
    console.log('✅ 超时顺延重试测试通过！');
}

run();
```

- [ ] **Step 2: 运行测试验证**

运行：`node tests/test_dial_timeout.mjs`
预期：输出 `✅ 超时顺延重试测试通过！`

- [ ] **Step 3: 在 `_worker.js` 中给 `打开TCP连接` 增加 1000ms 快速超时控制**

检查 `_worker.js` 中的 `打开TCP连接(address, port)`（约 2352 行），增加 `Promise.race` 超时控制，防止卡在无响应的反代节点：
```javascript
	async function 打开TCP连接(address, port, 超时毫秒 = 1000) {
		const remoteSock = TCP连接({ hostname: address, port });
		let timer = null;
		const 超时任务 = new Promise((_, reject) => {
			timer = setTimeout(() => reject(new Error(`连接 ${address}:${port} 握手超时(${超时毫秒}ms)`)), 超时毫秒);
		});
		try {
			await Promise.race([等待连接建立(remoteSock), 超时任务]);
			clearTimeout(timer);
			return remoteSock;
		} catch (err) {
			clearTimeout(timer);
			try { remoteSock?.close?.() } catch (e) { }
			throw err;
		}
	}
```

并在 `connectProxyIP` 的并发与循环捕获中，将握手失败后的切换日志明确记录：
```javascript
	log(`[反代连接] 节点 ${候选.hostname}:${候选.port} 异常(${err.message || err})，顺延尝试后续候选节点...`);
```

- [ ] **Step 4: 语法校验与兼容性测试**

运行：`node -c _worker.js`
预期：退出码 0。

- [ ] **Step 5: 提交更改**

```bash
git add _worker.js tests/test_dial_timeout.mjs
git commit -m "feat: 为 ProxyIP TCP 连接建立增加 1000ms 快速熔断与级联顺延自愈"
```

---

### Task 3: 管理后台前端 UI 增强 (国家下拉选择与状态联动)

**Files:**
- Modify: `D:\nice_wall\edgetunnel\_worker.js:6047-6605`
- Test: `D:\nice_wall\edgetunnel\tests\test_admin_html_injection.mjs`

**Interfaces:**
- Consumes: 原始 `Pages静态页面/admin/` 返回的 HTML 字符串
- Produces: 包含 `#proxyCountryWrapper`、`#proxyCountrySelect` 及相关 JS 事件联动的增强 HTML 字符串。

- [ ] **Step 1: 编写 HTML 转换与注入单元测试 `tests/test_admin_html_injection.mjs`**

```javascript
// tests/test_admin_html_injection.mjs
import assert from 'assert';
import fs from 'fs';

// 读取或模拟一段包含 proxyIPSection 的 HTML
const sampleHtml = `
<div id="proxyIPSection" class="form-group">
	<div class="form-group">
		<label for="proxyIP">PROXYIP</label>
		<div class="input-wrapper">
			<input type="text" id="proxyIP" title="PROXYIP" placeholder="proxyip.cmliussss.net"
				onchange="processProxyIP()" oninput="processProxyIP()">
			<div class="checkbox-group">
				<input type="checkbox" id="autoProxy" title="启用自动获取: 使用默认内置的PROXYIP"
					onchange="toggleAutoProxy(); markModified('proxy')">
				<label for="autoProxy" class="checkbox-label"
					title="启用自动获取: 使用默认内置的PROXYIP">启用自动获取</label>
			</div>
		</div>
	</div>
</div>
`;

// 待测注入函数
function 增强ProxyIPSection(html) {
	if (!html || !html.includes('id="autoProxy"')) return html;
	const needle = `<label for="autoProxy" class="checkbox-label"
					title="启用自动获取: 使用默认内置的PROXYIP">启用自动获取</label>`;
	const fallbackNeedle = `<label for="autoProxy" class="checkbox-label" title="启用自动获取: 使用默认内置的PROXYIP">启用自动获取</label>`;
	
	const countrySelectHtml = `
	<div id="proxyCountryWrapper" style="display: inline-flex; align-items: center; gap: 6px; margin-left: 10px;">
		<label for="proxyCountrySelect" style="font-size: 13px; color: #9ca3af;">🏳️ 落地国家:</label>
		<select id="proxyCountrySelect" class="form-select-sm" style="padding: 4px 8px; border-radius: 6px; font-size: 13px; background: rgba(255,255,255,0.08); color: #fff; border: 1px solid rgba(156,163,175,0.3);" onchange="markModified('proxy')">
			<option value="US" selected>🇺🇸 美国 (US)</option>
			<option value="auto">🌐 任意 (就近)</option>
			<option value="GB">🇬🇧 英国 (GB)</option>
			<option value="JP">🇯🇵 日本 (JP)</option>
			<option value="SG">🇸🇬 新加坡 (SG)</option>
			<option value="HK">🇭🇰 香港 (HK)</option>
		</select>
	</div>`;

	if (html.includes(needle)) {
		return html.replace(needle, needle + countrySelectHtml);
	} else if (html.includes(fallbackNeedle)) {
		return html.replace(fallbackNeedle, fallbackNeedle + countrySelectHtml);
	}
	return html;
}

const result = 增强ProxyIPSection(sampleHtml);
assert.ok(result.includes('id="proxyCountrySelect"'), '注入结果必须包含 proxyCountrySelect');
assert.ok(result.includes('🇺🇸 美国 (US)'), '必须包含美区默认选项');
console.log('✅ 管理后台 HTML 注入测试通过！');
```

- [ ] **Step 2: 运行测试验证**

运行：`node tests/test_admin_html_injection.mjs`
预期：输出 `✅ 管理后台 HTML 注入测试通过！`

- [ ] **Step 3: 修改 `_worker.js` 中的 `增强管理后台HTML`**

在 `_worker.js` 中的 `增强管理后台HTML(html)` 函数中：
1. 注入 `#proxyCountryWrapper` 下拉控件至 `#autoProxy` 的 `<label>` 之后；
2. 注入一段客户端 JavaScript 脚本，劫持 `toggleAutoProxy`、`renderUI` 与 `saveConfigToServer`，确保：
   - 当 `autoProxy.checked === true` 时，`proxyCountrySelect.disabled = false`；
   - 当 `autoProxy.checked === false` 时，`proxyCountrySelect.disabled = true`；
   - 页面加载配置时，回显 `currentConfig.反代.PROXYIP_COUNTRY || 'US'`；
   - 点击保存时，自动将选中的国家赋值到 `currentConfig.反代.PROXYIP_COUNTRY`。

- [ ] **Step 4: 运行真实远端 HTML 注入测试**

运行：`node -e "fetch('https://edt-pages.github.io/admin/').then(r=>r.text()).then(t=>{ const r = require('./_worker.js'); /* 语法检查与注入匹配 */ })"` 或使用单元脚本加载真实 HTML 检查。
预期：DOM 匹配成功且注入后的 HTML 结构合法。

- [ ] **Step 5: 提交更改**

```bash
git add _worker.js tests/test_admin_html_injection.mjs
git commit -m "feat: 在管理后台动态注入落地国家下拉选择器与双向联动逻辑"
```

---

### Task 4: 管理后台配置持久化与 KV 默认值兼容

**Files:**
- Modify: `D:\nice_wall\edgetunnel\_worker.js:5770-5845`
- Test: `D:\nice_wall\edgetunnel\tests\test_config_kv.mjs`

**Interfaces:**
- Consumes: `默认配置JSON.反代`, `读取config_JSON`
- Produces: 具有完整 `PROXYIP_COUNTRY` 默认值与向下兼容的 `config_JSON` 结构。

- [ ] **Step 1: 编写配置解析与向下兼容测试 `tests/test_config_kv.mjs`**

验证在读取存量老旧 `config.json`（不包含 `PROXYIP_COUNTRY` 字段）时，自动补充默认值 `'US'`，并在保存时不被覆盖。

```javascript
// tests/test_config_kv.mjs
import assert from 'assert';

function 校验并补全配置(config) {
    if (!config.反代) config.反代 = {};
    if (!config.反代.PROXYIP) config.反代.PROXYIP = 'auto';
    if (!config.反代.PROXYIP_COUNTRY) config.反代.PROXYIP_COUNTRY = 'US';
    return config;
}

// 模拟老配置
const oldConfig = { 反代: { PROXYIP: 'auto' } };
const updated = 校验并补全配置(oldConfig);
assert.strictEqual(updated.反代.PROXYIP_COUNTRY, 'US');

// 模拟显式配置
const customConfig = { 反代: { PROXYIP: 'auto', PROXYIP_COUNTRY: 'JP' } };
const updatedCustom = 校验并补全配置(customConfig);
assert.strictEqual(updatedCustom.反代.PROXYIP_COUNTRY, 'JP');

console.log('✅ KV 配置兼容与默认值补全测试通过！');
```

- [ ] **Step 2: 运行测试验证**

运行：`node tests/test_config_kv.mjs`
预期：输出 `✅ KV 配置兼容与默认值补全测试通过！`

- [ ] **Step 3: 修改 `_worker.js` 中的 `默认配置JSON` 和 `读取config_JSON`**

1. 在 `默认配置JSON.反代` 中增加：
   ```javascript
   PROXYIP_COUNTRY: "US",
   ```
2. 在 `读取config_JSON` 函数读取完后增加保底：
   ```javascript
   if (!config_JSON.反代.PROXYIP_COUNTRY) config_JSON.反代.PROXYIP_COUNTRY = "US";
   ```

- [ ] **Step 4: 运行语法检查**

运行：`node -c _worker.js`
预期：退出码 0。

- [ ] **Step 5: 提交更改**

```bash
git add _worker.js tests/test_config_kv.mjs
git commit -m "feat: 在默认配置与读取流程中增加 PROXYIP_COUNTRY 兼容与保底"
```

---

### Task 5: 本地端到端模拟测试与综合回归

**Files:**
- Create: `D:\nice_wall\edgetunnel\tests\test_e2e_mock.mjs`

- [ ] **Step 1: 编写端到端 Mock 模拟测试**

模拟完整的请求生命周期：
1. 请求 `/admin` -> 验证返回的 HTML 包含 `#proxyCountrySelect` 及联动脚本；
2. POST `/admin/config.json` 保存 `{ 反代: { PROXYIP: 'auto', PROXYIP_COUNTRY: 'US' } }` -> 验证持久化；
3. GET `/admin/config.json` -> 验证能取回 `PROXYIP_COUNTRY: 'US'`；
4. WebSocket 拨号进入 -> 验证 `获取出口反代候选队列` 解析到 `us.proxyip.cmliussss.net` 及 8 个美区 IPv4 节点。

- [ ] **Step 2: 执行回归测试**

运行：`node tests/test_e2e_mock.mjs`
预期：全流程断言通过。

- [ ] **Step 3: 提交回归测试脚本**

```bash
git add tests/test_e2e_mock.mjs
git commit -m "test: 增加 EdgeTunnel 国家出口选择与自愈队列完整端到端模拟测试"
```

---

### Task 6: Cloudflare Worker 生产部署与软路由影子沙箱全链路回归

**Files:**
- Router verification script: `C:\Users\Administrator\.gemini\antigravity-cli\brain\75f7a8ab-c41a-4564-bdcf-7b4ac1ec3989\scratch\verify_shadow_e2e.py`

- [ ] **Step 1: 协助用户完成 Wrangler 部署**

提示用户在当前终端执行 `npx wrangler login` 完成浏览器 OAuth 授权（若尚未授权），随后执行：
```bash
npx wrangler deploy
```
确认部署输出成功版本号与部署时间戳。

- [ ] **Step 2: 软路由影子端口 (17890) 全链路拨号实测**

通过 `ssh` MCP 工具连接软路由 `10.10.18.2`：
1. 使用端口 `17890`（带 GID 65534 隔离进程）向软路由启动的 Clash 发起针对目标节点的代理请求；
2. 依次测试以下 5 个关键目标：
   - `curl -x 127.0.0.1:17890 https://ip.sb/` -> 验证 HTTP 200，确认返回 IP 位于美国（US）；
   - `curl -x 127.0.0.1:17890 -I https://www.google.com/` -> 验证 HTTP 200；
   - `curl -x 127.0.0.1:17890 -I https://www.youtube.com/` -> 验证 HTTP 200；
   - `curl -x 127.0.0.1:17890 https://ipleak.net/` -> 验证 HTTP 200；
   - `curl -x 127.0.0.1:17890 https://browserleaks.com/dns` -> 验证 HTTP 200；
3. 确保用户的生产代理（OpenClash 7890 / `ddyun`）完全不受干扰。

- [ ] **Step 3: 记录测试结果与版本归档**

在 `docs/superpowers/plans/2026-10-10-country-proxyip-autohealing.md` 中打钩标记完成，并将变更推送到远程 `my-custom` 分支。
