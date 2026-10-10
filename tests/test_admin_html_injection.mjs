import assert from 'assert';
import { 增强管理后台HTML, 增强ProxyIPSection } from '../_worker.js';

console.log('🔍 开始执行 管理后台 HTML 注入与前端状态联动测试...');

// ============================================================================
// 1. 模拟 HTML 片段（基于 Task Brief 规范）
// ============================================================================
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

// ============================================================================
// 2. 基础 DOM 注入测试
// ============================================================================
const result = 增强ProxyIPSection(sampleHtml);

assert.ok(result.includes('id="proxyCountryWrapper"'), '注入结果必须包含 proxyCountryWrapper');
assert.ok(result.includes('id="proxyCountrySelect"'), '注入结果必须包含 proxyCountrySelect');
assert.ok(result.includes('🇺🇸 美国 (US)'), '必须包含美区默认选项');
assert.ok(result.includes('value="US" selected'), '默认选中项必须为 US');
assert.ok(result.includes('value="auto"'), '必须包含任意(就近)选项');
assert.ok(result.includes('value="GB"'), '必须包含英国选项');
assert.ok(result.includes('value="JP"'), '必须包含日本选项');
assert.ok(result.includes('value="SG"'), '必须包含新加坡选项');
assert.ok(result.includes('value="HK"'), '必须包含香港选项');
assert.ok(result.includes('onchange="markModified(\'proxy\')"'), '下拉菜单必须包含 markModified(\'proxy\') 联动');

// 验证 增强管理后台HTML 在无 generatorSection 时同样能增强 proxyIPSection
const adminResult = 增强管理后台HTML(sampleHtml);
assert.ok(adminResult.includes('id="proxyCountrySelect"'), '增强管理后台HTML 必须包含 proxyCountrySelect');

// 验证幂等性（重复调用不会导致多次注入）
const doubleInjected = 增强ProxyIPSection(result);
const countSelect = (doubleInjected.match(/id="proxyCountrySelect"/g) || []).length;
assert.strictEqual(countSelect, 1, '重复注入时必须保持幂等，只出现一次 proxyCountrySelect');

// 验证单行 fallbackNeedle 匹配能力
const singleLineHtml = `<div class="checkbox-group"><input type="checkbox" id="autoProxy"><label for="autoProxy" class="checkbox-label" title="启用自动获取: 使用默认内置的PROXYIP">启用自动获取</label></div>`;
const singleLineResult = 增强ProxyIPSection(singleLineHtml);
assert.ok(singleLineResult.includes('id="proxyCountrySelect"'), '单行 HTML 也必须成功注入 proxyCountrySelect');

console.log('✅ HTML 字符串匹配与幂等性测试通过！');

// ============================================================================
// 3. 客户端脚本逻辑与状态联动模拟测试
// ============================================================================
console.log('🔍 开始验证客户端脚本状态联动逻辑...');

function extractInjectedScript(html) {
	const startTag = '<script>';
	const endTag = '</script>';
	const startIdx = html.indexOf(startTag);
	assert.ok(startIdx !== -1, '注入结果中必须包含 <script> 标签');
	const endIdx = html.indexOf(endTag, startIdx);
	assert.ok(endIdx !== -1, '注入结果中必须包含 </script> 闭合标签');
	return html.substring(startIdx + startTag.length, endIdx);
}

const injectedScriptCode = extractInjectedScript(result);
assert.ok(injectedScriptCode.includes('toggleAutoProxy'), '脚本必须劫持/监听 toggleAutoProxy');
assert.ok(injectedScriptCode.includes('renderUI'), '脚本必须劫持/监听 renderUI');
assert.ok(injectedScriptCode.includes('saveConfigToServer'), '脚本必须劫持/监听 saveConfigToServer');
assert.ok(injectedScriptCode.includes('PROXYIP_COUNTRY'), '脚本必须读写 PROXYIP_COUNTRY');

// 模拟浏览器 DOM 环境执行注入脚本
function createMockBrowserEnv(initialConfig = {}) {
	const elements = {
		autoProxy: {
			id: 'autoProxy',
			checked: false,
			disabled: false,
			listeners: {},
			addEventListener(event, fn) {
				if (!this.listeners[event]) this.listeners[event] = [];
				this.listeners[event].push(fn);
			},
			dispatchEvent(event) {
				(this.listeners[event] || []).forEach(fn => fn.call(this));
			}
		},
		proxyCountrySelect: {
			id: 'proxyCountrySelect',
			value: 'US',
			disabled: true,
			options: [
				{ value: 'US' },
				{ value: 'auto' },
				{ value: 'GB' },
				{ value: 'JP' },
				{ value: 'SG' },
				{ value: 'HK' }
			],
			listeners: {},
			addEventListener(event, fn) {
				if (!this.listeners[event]) this.listeners[event] = [];
				this.listeners[event].push(fn);
			}
		},
		proxyIP: {
			id: 'proxyIP',
			value: '',
			disabled: false
		}
	};

	let serverSavedBody = null;

	const mockWindow = {
		document: {
			readyState: 'complete',
			getElementById(id) {
				return elements[id] || null;
			},
			addEventListener() {}
		},
		currentConfig: JSON.parse(JSON.stringify(initialConfig)),
		modifiedSections: new Set(),
		markModified(section) {
			mockWindow.modifiedSections.add(section);
		},
		toggleAutoProxy() {
			const autoProxy = elements.autoProxy.checked;
			elements.proxyIP.disabled = autoProxy;
			mockWindow.markModified('proxy');
		},
		renderUI() {
			const cfgProxy = mockWindow.currentConfig?.反代?.PROXYIP;
			elements.proxyIP.value = cfgProxy || '';
			elements.autoProxy.checked = (cfgProxy === 'auto');
			elements.proxyIP.disabled = (cfgProxy === 'auto');
		},
		applyProxyConfigToForm() {
			mockWindow.renderUI();
		},
		async saveConfigToServer(section) {
			if (section === 'proxy') {
				serverSavedBody = JSON.parse(JSON.stringify(mockWindow.currentConfig));
			}
		},
		async saveProxy() {
			const auto = elements.autoProxy.checked;
			const proxyIP = auto ? 'auto' : elements.proxyIP.value.trim();
			const existing = mockWindow.currentConfig.反代 || {};
			mockWindow.currentConfig.反代 = {
				...existing,
				PROXYIP: proxyIP
			};
			await mockWindow.saveConfigToServer('proxy');
		},
		addEventListener() {},
		setInterval(fn) {
			fn(); // 模拟立即执行一次
			return 1;
		},
		clearInterval() {},
		setTimeout(fn) {
			fn(); // 模拟立即执行一次
			return 1;
		}
	};

	// 运行注入的客户端代码
	const runFn = new Function('window', 'document', 'setInterval', 'clearInterval', 'setTimeout', injectedScriptCode);
	runFn(mockWindow, mockWindow.document, mockWindow.setInterval, mockWindow.clearInterval, mockWindow.setTimeout);

	return {
		window: mockWindow,
		elements,
		getServerSavedBody: () => serverSavedBody
	};
}

// Case 1: 勾选 autoProxy 与 proxyCountrySelect.disabled 联动测试
{
	const env = createMockBrowserEnv({ 反代: { PROXYIP: '1.2.3.4', PROXYIP_COUNTRY: 'US' } });
	const { elements, window } = env;

	// 初始状态：autoProxy 未勾选，proxyCountrySelect 应为禁用
	assert.strictEqual(elements.autoProxy.checked, false);
	assert.strictEqual(elements.proxyCountrySelect.disabled, true, 'autoProxy 未勾选时 proxyCountrySelect 必须禁用');

	// 用户勾选 autoProxy
	elements.autoProxy.checked = true;
	window.toggleAutoProxy();
	assert.strictEqual(elements.proxyCountrySelect.disabled, false, 'autoProxy 勾选后 proxyCountrySelect 必须启用');

	// 用户取消勾选 autoProxy
	elements.autoProxy.checked = false;
	window.toggleAutoProxy();
	assert.strictEqual(elements.proxyCountrySelect.disabled, true, 'autoProxy 取消勾选后 proxyCountrySelect 必须重新禁用');
}

// Case 2: renderUI 回显配置测试 (回显日本 JP，且 autoProxy 自动启用)
{
	const env = createMockBrowserEnv({ 反代: { PROXYIP: 'auto', PROXYIP_COUNTRY: 'JP' } });
	const { elements, window } = env;

	window.renderUI();
	assert.strictEqual(elements.proxyCountrySelect.value, 'JP', 'renderUI 必须正确回显 PROXYIP_COUNTRY = JP');
	assert.strictEqual(elements.proxyCountrySelect.disabled, false, 'PROXYIP=auto 时 proxyCountrySelect 必须处于启用状态');
}

// Case 3: renderUI 缺省国家自动兜底 'US' 测试
{
	const env = createMockBrowserEnv({ 反代: { PROXYIP: 'auto' } });
	const { elements, window } = env;

	window.renderUI();
	assert.strictEqual(elements.proxyCountrySelect.value, 'US', '未配置国家时必须默认回显 US');
	assert.strictEqual(elements.proxyCountrySelect.disabled, false, 'PROXYIP=auto 时必须启用');
}

// Case 4: saveProxy / saveConfigToServer 自动写入 currentConfig.反代.PROXYIP_COUNTRY 测试
{
	const env = createMockBrowserEnv({ 反代: { PROXYIP: 'auto', PROXYIP_COUNTRY: 'US' } });
	const { elements, window, getServerSavedBody } = env;

	// 用户选择新加坡 SG 并保存
	elements.proxyCountrySelect.value = 'SG';
	await window.saveProxy();

	const saved = getServerSavedBody();
	assert.ok(saved, '必须触发 saveConfigToServer');
	assert.strictEqual(saved.反代.PROXYIP_COUNTRY, 'SG', '保存到服务器的配置必须包含选中的国家代码 SG');
	assert.strictEqual(window.currentConfig.反代.PROXYIP_COUNTRY, 'SG', '本地 currentConfig 必须同步为 SG');
}

// Case 5: 直接调用 saveConfigToServer('proxy') 同样能正确注入 PROXYIP_COUNTRY
{
	const env = createMockBrowserEnv({ 反代: { PROXYIP: 'auto' } });
	const { elements, window, getServerSavedBody } = env;

	elements.proxyCountrySelect.value = 'HK';
	await window.saveConfigToServer('proxy');

	const saved = getServerSavedBody();
	assert.strictEqual(saved.反代.PROXYIP_COUNTRY, 'HK', '直接保存 proxy 时必须自动赋值 HK');
}

// Case 6: cancelEdit / applyProxyConfigToForm 恢复配置测试
{
	const env = createMockBrowserEnv({ 反代: { PROXYIP: 'auto', PROXYIP_COUNTRY: 'GB' } });
	const { elements, window } = env;

	// 用户临时切换到 JP
	elements.proxyCountrySelect.value = 'JP';
	assert.strictEqual(elements.proxyCountrySelect.value, 'JP');

	// 用户点击取消，执行 applyProxyConfigToForm
	window.applyProxyConfigToForm();
	assert.strictEqual(elements.proxyCountrySelect.value, 'GB', '取消编辑后必须恢复原始配置 GB');
}

console.log('✅ 客户端脚本状态联动全部测试通过！');

// ============================================================================
// 4. 真实/远端 Pages HTML 注入测试
// ============================================================================
console.log('🔍 开始执行真实远端 HTML 注入测试...');

async function fetchRealAdminHtml() {
	try {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 6000);
		const res = await fetch('https://edt-pages.github.io/admin/', { signal: controller.signal });
		clearTimeout(timeout);
		if (res.ok) {
			return await res.text();
		}
	} catch (e) {
		console.warn('⚠️ 网络访问远端 Pages 超时或受限，使用内置完整结构 HTML 快照测试');
	}

	// 离线完整结构快照（包含 generatorSection 与 proxyIPSection）
	return `
	<!DOCTYPE html>
	<html>
	<head><title>Admin</title></head>
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
}

const realHtml = await fetchRealAdminHtml();
const realEnhanced = 增强管理后台HTML(realHtml);

// 验证 proxyCountrySelect 注入
assert.ok(realEnhanced.includes('id="proxyCountryWrapper"'), '真实 HTML 中必须成功注入 proxyCountryWrapper');
assert.ok(realEnhanced.includes('id="proxyCountrySelect"'), '真实 HTML 中必须成功注入 proxyCountrySelect');
assert.ok(realEnhanced.includes('🇺🇸 美国 (US)'), '真实 HTML 中必须包含美区默认选项');

// 验证 generatorSection 依然正常增强，两者共存不冲突
assert.ok(realEnhanced.includes('generatorListContainer'), '真实 HTML 中 generatorListContainer 必须正常保留增强');
assert.ok(realEnhanced.includes('testAllGeneratorsBtn'), '真实 HTML 中 generatorSection 增强按钮必须正常保留');

console.log('✅ 真实 HTML 完整注入测试通过！');
console.log('✅ 管理后台 HTML 注入测试通过！');
