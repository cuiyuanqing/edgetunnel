import assert from 'assert';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import worker, {
	美区高可用备用热池,
	打乱数组,
	获取出口反代候选队列,
	带超时打开TCP连接,
	增强管理后台HTML,
	读取config_JSON
} from '../_worker.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('🚀 开始执行 EdgeTunnel 国家出口选择与自愈队列端到端 (E2E) 模拟测试...\n');

// =============================================================================
// 0. 环境 Mock 准备：SubtleCrypto MD5 补丁、Mock KV 与全局 fetch 拦截
// =============================================================================

// 0.1 Node.js 环境下补全 SubtleCrypto 对 MD5 的支持（Cloudflare Workers 原生支持 MD5）
const origDigest = globalThis.crypto?.subtle?.digest;
if (origDigest) {
	globalThis.crypto.subtle.digest = async function(algo, data) {
		if (typeof algo === 'string' && algo.toUpperCase() === 'MD5') {
			const hash = crypto.createHash('md5').update(Buffer.from(data)).digest();
			return hash.buffer.slice(hash.byteOffset, hash.byteOffset + hash.byteLength);
		}
		return origDigest.call(this, algo, data);
	};
}

// MD5 辅助函数（用于本地比对计算）
function md5(text) {
	return crypto.createHash('md5').update(text).digest('hex');
}
function md5md5(text) {
	const h1 = md5(text);
	const h2 = md5(h1.slice(7, 27));
	return h2.toLowerCase();
}

// 0.2 Mock KV 实现
function createMockKV(initialEntries = {}) {
	const map = new Map(Object.entries(initialEntries));
	return {
		_store: map,
		async get(key) {
			return map.has(key) ? map.get(key) : null;
		},
		async put(key, value) {
			map.set(key, typeof value === 'string' ? value : JSON.stringify(value));
		},
		async delete(key) {
			map.delete(key);
		}
	};
}

// 0.3 离线 Admin HTML 模板快照与全局 fetch 拦截（确保 100% 无外部网络依赖）
const mockAdminHtmlTemplate = `
<!DOCTYPE html>
<html>
<head><title>EdgeTunnel Admin</title></head>
<body>
	<div id="generatorSection" class="form-group hidden-section">
		<label>原优选生成器</label>
	</div>
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
	<script data-cfasync="false">
		let currentConfig = {};
		function toggleAutoProxy() {}
		function renderUI() {}
		function saveConfigToServer() {}
	</script>
</body>
</html>
`;

const originalGlobalFetch = globalThis.fetch;
globalThis.fetch = async function(input, init) {
	const urlStr = typeof input === 'string' ? input : (input?.url || '');
	if (urlStr.includes('edt-pages.github.io/admin')) {
		return new Response(mockAdminHtmlTemplate, {
			status: 200,
			headers: { 'Content-Type': 'text/html; charset=utf-8' }
		});
	}
	if (urlStr.includes('speed.cloudflare.com')) {
		return new Response(JSON.stringify([]), {
			status: 200,
			headers: { 'Content-Type': 'application/json' }
		});
	}
	if (urlStr.includes('api.telegram.org')) {
		return new Response(JSON.stringify({ ok: true }), {
			status: 200,
			headers: { 'Content-Type': 'application/json' }
		});
	}
	return new Response('Not Found in Mock', { status: 404 });
};

// 0.4 测试基础数据配置
const TEST_HOST = 'example.com';
const TEST_ADMIN_PASSWORD = 'admin-secure-password-2026';
const TEST_KEY = 'custom-encryption-key-for-test';
const TEST_UUID = '00000000-0000-4000-8000-000000000000';
const TEST_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) EdgeTunnel-E2E-Tester';

const mockKV = createMockKV();
const env = {
	ADMIN: TEST_ADMIN_PASSWORD,
	KEY: TEST_KEY,
	UUID: TEST_UUID,
	HOST: TEST_HOST,
	KV: mockKV
};

const ctx = {
	waitUntil(promise) {
		if (promise && typeof promise.catch === 'function') {
			promise.catch(e => console.error('[ctx.waitUntil error]', e));
		}
	},
	passThroughOnException() {}
};

// =============================================================================
// 1. 用户认证鉴权与 GET /admin 管理页面端到端测试
// =============================================================================
console.log('📌 [Phase 1] 测试用户认证与管理后台 GET /admin 页面 HTML 注入...');

// 1.1 模拟管理员登录 POST /login 获取 auth Cookie
const loginReq = new Request(`https://${TEST_HOST}/login`, {
	method: 'POST',
	headers: {
		'Content-Type': 'application/x-www-form-urlencoded',
		'User-Agent': TEST_UA
	},
	body: `password=${encodeURIComponent(TEST_ADMIN_PASSWORD)}`
});

const loginRes = await worker.fetch(loginReq, env, ctx);
assert.strictEqual(loginRes.status, 200, 'POST /login 必须返回 200 状态码');
const setCookieHeader = loginRes.headers.get('Set-Cookie') || '';
assert.ok(setCookieHeader.includes('auth='), '登录成功后响应头必须包含 auth Cookie');

const authCookieMatch = setCookieHeader.match(/auth=([^;]+)/);
const authCookie = authCookieMatch ? authCookieMatch[1] : '';
const expectedAuthCookie = md5md5(TEST_UA + TEST_KEY + TEST_ADMIN_PASSWORD);
assert.strictEqual(authCookie, expectedAuthCookie, '计算出的 auth Cookie 必须与预期 MD5MD5 一致');

// 1.2 无鉴权访问 /admin 必须重定向至 /login
const unauthReq = new Request(`https://${TEST_HOST}/admin`, {
	method: 'GET',
	headers: { 'User-Agent': TEST_UA }
});
const unauthRes = await worker.fetch(unauthReq, env, ctx);
assert.strictEqual(unauthRes.status, 302, '无 Cookie 访问 /admin 应重定向');
assert.strictEqual(unauthRes.headers.get('Location'), '/login', '应重定向到 /login');

// 1.3 携带有效 Cookie 访问 /admin，验证返回 200 且 HTML 成功增强注入
const adminReq = new Request(`https://${TEST_HOST}/admin`, {
	method: 'GET',
	headers: {
		'User-Agent': TEST_UA,
		'Cookie': `auth=${authCookie}`
	}
});
const adminRes = await worker.fetch(adminReq, env, ctx);
assert.strictEqual(adminRes.status, 200, '携带有效 Cookie 访问 /admin 必须返回 200');
const adminHtml = await adminRes.text();

// 验证 HTML 注入元素
assert.ok(adminHtml.includes('id="proxyCountryWrapper"'), '返回的 HTML 中必须包含 proxyCountryWrapper');
assert.ok(adminHtml.includes('id="proxyCountrySelect"'), '返回的 HTML 中必须包含 proxyCountrySelect');
assert.ok(adminHtml.includes('value="US" selected'), '国家出口默认选中项必须为 US');
assert.ok(adminHtml.includes('value="auto"'), '必须包含任意(就近推荐)选项');
assert.ok(adminHtml.includes('value="GB"'), '必须包含英国(GB)选项');
assert.ok(adminHtml.includes('value="JP"'), '必须包含日本(JP)选项');
assert.ok(adminHtml.includes('value="SG"'), '必须包含新加坡(SG)选项');
assert.ok(adminHtml.includes('value="HK"'), '必须包含香港(HK)选项');

// 验证客户端联动脚本钩子存在
assert.ok(adminHtml.includes('toggleAutoProxy'), '必须包含 toggleAutoProxy 联动逻辑');
assert.ok(adminHtml.includes('renderUI'), '必须包含 renderUI 联动逻辑');
assert.ok(adminHtml.includes('saveConfigToServer'), '必须包含 saveConfigToServer 联动逻辑');
assert.ok(adminHtml.includes('PROXYIP_COUNTRY'), '必须包含 PROXYIP_COUNTRY 读写逻辑');

// 1.4 在客户端沙箱中运行注入脚本，验证前端 DOM 联动与保存逻辑闭环
function extractCountryScript(html) {
	const marker = 'function syncProxyCountryUI';
	const markerIdx = html.indexOf(marker);
	assert.ok(markerIdx !== -1, '注入结果中必须包含 syncProxyCountryUI 客户端逻辑');
	const startIdx = html.lastIndexOf('<script>', markerIdx);
	const endIdx = html.indexOf('</script>', markerIdx);
	assert.ok(startIdx !== -1 && endIdx !== -1, '必须提取到有效的 country script 代码块');
	return html.substring(startIdx + '<script>'.length, endIdx);
}

let clientSubmittedPayload = null;
const elements = {
	autoProxy: { checked: true, disabled: false, listeners: {}, addEventListener(e, fn) { (this.listeners[e] ||= []).push(fn); } },
	proxyCountrySelect: {
		value: 'US',
		disabled: false,
		options: [
			{ value: 'US' },
			{ value: 'auto' },
			{ value: 'GB' },
			{ value: 'JP' },
			{ value: 'SG' },
			{ value: 'HK' }
		],
		listeners: {},
		addEventListener(e, fn) { (this.listeners[e] ||= []).push(fn); }
	},
	proxyIP: { value: '', disabled: true }
};
const mockWindow = {
	document: { readyState: 'complete', getElementById: id => elements[id] || null, addEventListener() {} },
	currentConfig: { UUID: TEST_UUID, HOST: TEST_HOST, 反代: { PROXYIP: 'auto' } },
	markModified() {},
	toggleAutoProxy() {},
	renderUI() {},
	async saveConfigToServer(section) {
		if (section === 'proxy') {
			clientSubmittedPayload = JSON.parse(JSON.stringify(mockWindow.currentConfig));
		}
	},
	async saveProxy() {
		mockWindow.currentConfig.反代 = {
			...(mockWindow.currentConfig.反代 || {}),
			PROXYIP: elements.autoProxy.checked ? 'auto' : elements.proxyIP.value.trim()
		};
		await mockWindow.saveConfigToServer('proxy');
	},
	setInterval(fn) { fn(); return 1; },
	clearInterval() {},
	setTimeout(fn) { return 1; }
};

const injectedScript = extractCountryScript(adminHtml);
const runFn = new Function('window', 'document', 'setInterval', 'clearInterval', 'setTimeout', injectedScript);
runFn(mockWindow, mockWindow.document, mockWindow.setInterval, mockWindow.clearInterval, mockWindow.setTimeout);

// 验证在浏览器端将国家选择为 US 并触发 saveProxy
elements.proxyCountrySelect.value = 'US';
await mockWindow.saveProxy();
assert.ok(clientSubmittedPayload, '必须成功触发 saveConfigToServer 保存');
assert.strictEqual(clientSubmittedPayload.反代.PROXYIP_COUNTRY, 'US', '前端保存时必须正确注入 PROXYIP_COUNTRY: "US"');

console.log('  ✔ /admin 页面获取成功，HTML 注入元素、脚本钩子及客户端 DOM 沙箱联动校验全部通过！');

// =============================================================================
// 2. POST /admin/config.json 保存配置与 KV 持久化端到端测试
// =============================================================================
console.log('\n📌 [Phase 2] 测试 POST /admin/config.json 配置保存与 KV 持久化...');

const configToSave = {
	UUID: TEST_UUID,
	HOST: TEST_HOST,
	PATH: '/',
	协议类型: 'vless',
	传输协议: 'ws',
	订阅转换配置: {},
	反代: {
		PROXYIP: 'auto',
		PROXYIP_COUNTRY: 'US'
	}
};

const postConfigReq = new Request(`https://${TEST_HOST}/admin/config.json`, {
	method: 'POST',
	headers: {
		'Content-Type': 'application/json',
		'User-Agent': TEST_UA,
		'Cookie': `auth=${authCookie}`
	},
	body: JSON.stringify(configToSave)
});

const postConfigRes = await worker.fetch(postConfigReq, env, ctx);
assert.strictEqual(postConfigRes.status, 200, 'POST /admin/config.json 必须返回 200');
const postJsonResult = await postConfigRes.json();
assert.strictEqual(postJsonResult.success, true, '保存配置返回体必须为 { success: true }');

// 验证 KV 中实际持久化写入的内容
const storedRaw = await mockKV.get('config.json');
assert.ok(storedRaw, 'KV 中必须存在持久化的 config.json');
const storedConfig = JSON.parse(storedRaw);
assert.strictEqual(storedConfig.反代.PROXYIP, 'auto', 'KV 中反代.PROXYIP 必须为 auto');
assert.strictEqual(storedConfig.反代.PROXYIP_COUNTRY, 'US', 'KV 中反代.PROXYIP_COUNTRY 必须为 US');
assert.strictEqual(storedConfig.UUID, TEST_UUID);
assert.strictEqual(storedConfig.HOST, TEST_HOST);

console.log('  ✔ POST /admin/config.json 成功执行，KV 持久化校验通过！');

// =============================================================================
// 3. GET /admin/config.json 读取配置端到端测试
// =============================================================================
console.log('\n📌 [Phase 3] 测试 GET /admin/config.json 从 KV 读取配置...');

const getConfigReq = new Request(`https://${TEST_HOST}/admin/config.json`, {
	method: 'GET',
	headers: {
		'User-Agent': TEST_UA,
		'Cookie': `auth=${authCookie}`
	}
});

const getConfigRes = await worker.fetch(getConfigReq, env, ctx);
assert.strictEqual(getConfigRes.status, 200, 'GET /admin/config.json 必须返回 200');
const retrievedConfig = await getConfigRes.json();

assert.ok(retrievedConfig.反代, '返回的配置必须包含 反代 对象');
assert.strictEqual(retrievedConfig.反代.PROXYIP, 'auto', '反代.PROXYIP 必须为 auto');
assert.strictEqual(retrievedConfig.反代.PROXYIP_COUNTRY, 'US', '反代.PROXYIP_COUNTRY 必须为 US');

// 同时验证生产导出的 读取config_JSON 函数与 GET 接口返回保持一致
const directReadConfig = await 读取config_JSON(env, TEST_HOST, TEST_UUID, TEST_UA);
assert.strictEqual(directReadConfig.反代.PROXYIP_COUNTRY, 'US', '读取config_JSON 导出的国家代码必须为 US');
assert.strictEqual(directReadConfig.反代.PROXYIP, 'auto', '读取config_JSON 导出的反代模式必须为 auto');

console.log('  ✔ GET /admin/config.json 成功读取，国家出口配置 PROXYIP_COUNTRY: "US" 验证通过！');

// =============================================================================
// 4. 模拟客户端连接与出口反代候选队列、故障转移自愈端到端测试
// =============================================================================
console.log('\n📌 [Phase 4] 测试订阅生成、获取出口反代候选队列与 1000ms TCP 自愈...');

// 4.1 验证获取出口反代候选队列解析（US 国家出口配置）
const candidateQueue = 获取出口反代候选队列(
	{ cf: { colo: 'sjc' } },
	env,
	null,
	retrievedConfig,
	true
);

assert.strictEqual(candidateQueue[0], 'us.proxyip.cmliussss.net', '候选队列首项必须为 us 动态出口域名');
assert.strictEqual(candidateQueue.length, 9, '候选队列总长度必须为 1(动态) + 8(静态热池)');
for (const ipNode of 美区高可用备用热池) {
	assert.ok(candidateQueue.includes(ipNode), `候选队列必须包含备用热池节点: ${ipNode}`);
}

// 4.2 验证动态修改国家出口为其他地区时能够实时生效
const jpConfig = { ...retrievedConfig, 反代: { PROXYIP: 'auto', PROXYIP_COUNTRY: 'JP' } };
const jpQueue = 获取出口反代候选队列({ cf: { colo: 'nrt' } }, env, null, jpConfig, true);
assert.strictEqual(jpQueue[0], 'jp.proxyip.cmliussss.net', '修改为 JP 时首项必须为 jp 动态出口域名');

const hkConfig = { ...retrievedConfig, 反代: { PROXYIP: 'auto', PROXYIP_COUNTRY: 'HK' } };
const hkQueue = 获取出口反代候选队列({ cf: { colo: 'hkg' } }, env, null, hkConfig, true);
assert.strictEqual(hkQueue[0], 'hk.proxyip.cmliussss.net', '修改为 HK 时首项必须为 hk 动态出口域名');

const autoConfig = { ...retrievedConfig, 反代: { PROXYIP: 'auto', PROXYIP_COUNTRY: 'auto' } };
const autoQueue = 获取出口反代候选队列({ cf: { colo: 'sjc' } }, env, null, autoConfig, true);
assert.strictEqual(autoQueue[0], 'sjc.proxyip.cmliussss.net', '国家设置为 auto 时首项必须为机房动态出口域名 sjc');

// 4.3 模拟客户端订阅获取 GET /sub
const subToken = md5md5(TEST_HOST + TEST_UUID);
const subReq = new Request(`https://${TEST_HOST}/sub?token=${subToken}`, {
	method: 'GET',
	headers: { 'User-Agent': TEST_UA }
});
const subRes = await worker.fetch(subReq, env, ctx);
assert.strictEqual(subRes.status, 200, 'GET /sub 请求必须返回 200');
const subContent = await subRes.text();
assert.ok(subContent.length > 0, '订阅内容不可为空');

// 4.4 模拟客户端实际建立 TCP 连接：首选动态域名握手超时(>1000ms)，触发带超时自愈并回退至备用 IPv4 热池
let timeoutAttempted = false;
const mockConnector = ({ hostname, port }) => {
	if (hostname.includes('proxyip.cmliussss.net')) {
		// 模拟动态域名发生网络黑洞，挂起超时
		return {
			hostname,
			port,
			opened: new Promise(resolve => setTimeout(resolve, 300)),
			close: () => { timeoutAttempted = true; }
		};
	}
	// 备用 IPv4 热池节点正常即时建立连接
	return {
		hostname,
		port,
		opened: Promise.resolve({ readable: {}, writable: {} }),
		close: () => {}
	};
};

let activeSock = null;
const failoverLogs = [];
for (const cand of candidateQueue) {
	const [candHost, candPort] = cand.split(':');
	try {
		activeSock = await 带超时打开TCP连接(mockConnector, candHost, Number(candPort || 443), 50);
		break;
	} catch (err) {
		failoverLogs.push({ candidate: cand, error: err.message });
	}
}

assert.ok(activeSock, '自愈顺延后必须成功建立连接');
assert.ok(activeSock.hostname !== 'us.proxyip.cmliussss.net', '主域名超时后必须顺利切换到备用节点');
assert.ok(美区高可用备用热池.some(ipNode => ipNode.startsWith(activeSock.hostname)), '最终建立连接的节点必须来自美区高可用备用热池');
assert.strictEqual(timeoutAttempted, true, '首选动态节点超时后必须调用 close() 释放挂起套接字');
assert.strictEqual(failoverLogs.length, 1, '只有首选动态节点应记录一次超时 failover');
assert.ok(failoverLogs[0].error.includes('握手超时(50ms)'));

console.log('  ✔ 候选队列生成、多国家切换与 1000ms TCP 级联自愈测试全部通过！');

// =============================================================================
// 5. 综合全量回归测试：按序全量运行既有 4 个单测脚本
// =============================================================================
console.log('\n📌 [Phase 5] 运行现有 4 个单测套件，执行综合回归测试...');

const regressionTestSuites = [
	'test_proxyip_routing.mjs',
	'test_dial_timeout.mjs',
	'test_admin_html_injection.mjs',
	'test_config_kv.mjs',
	'test_disguise_blog.mjs'
];

for (const suite of regressionTestSuites) {
	const suitePath = path.resolve(__dirname, suite);
	console.log(`\n------------------------------------------------------------`);
	console.log(`▶ 正在回归验证: tests/${suite}`);
	console.log(`------------------------------------------------------------`);
	try {
		execFileSync(process.execPath, [suitePath], {
			stdio: 'inherit',
			cwd: path.resolve(__dirname, '..')
		});
		console.log(`✔ tests/${suite} 回归验证通过！`);
	} catch (error) {
		console.error(`❌ tests/${suite} 回归验证失败:`, error);
		process.exit(1);
	}
}

console.log('\n============================================================');
console.log('🎉 恭喜！端到端模拟测试与综合回归（5 个套件）100% 全部通过！');
console.log('============================================================\n');
