import assert from 'assert';
import crypto from 'crypto';
import { 读取config_JSON } from '../_worker.js';

// Node.js 环境下补全 SubtleCrypto 对 MD5 的支持（Cloudflare Workers 原生支持 MD5）
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

// -----------------------------------------------------------------------------
// 1. 计划基线校验逻辑单测
// -----------------------------------------------------------------------------
function 校验并补全配置(config) {
	if (!config.反代) config.反代 = {};
	if (!config.反代.PROXYIP) config.反代.PROXYIP = 'auto';
	if (!config.反代.PROXYIP_COUNTRY) config.反代.PROXYIP_COUNTRY = 'US';
	return config;
}

// 模拟老配置（缺失 PROXYIP_COUNTRY）
const oldConfig = { 反代: { PROXYIP: 'auto' } };
const updated = 校验并补全配置(oldConfig);
assert.strictEqual(updated.反代.PROXYIP_COUNTRY, 'US', '老配置应自动补全默认国家 US');

// 模拟显式配置
const customConfig = { 反代: { PROXYIP: 'auto', PROXYIP_COUNTRY: 'JP' } };
const updatedCustom = 校验并补全配置(customConfig);
assert.strictEqual(updatedCustom.反代.PROXYIP_COUNTRY, 'JP', '显式配置的国家代码不应被覆盖');

// 模拟完全缺失反代节点的空配置
const emptyConfig = {};
const updatedEmpty = 校验并补全配置(emptyConfig);
assert.strictEqual(updatedEmpty.反代.PROXYIP_COUNTRY, 'US', '空反代配置应自动补全默认国家 US');
assert.strictEqual(updatedEmpty.反代.PROXYIP, 'auto', '空反代配置应自动补全 PROXYIP 为 auto');

// -----------------------------------------------------------------------------
// 2. 生产模块 _worker.js 导出的 读取config_JSON 完整集成单测（带 mock env.KV）
// -----------------------------------------------------------------------------
function createMockKV(initialEntries = {}) {
	const map = new Map(Object.entries(initialEntries));
	return {
		_store: map,
		async get(key) {
			return map.has(key) ? map.get(key) : null;
		},
		async put(key, value) {
			map.set(key, typeof value === 'string' ? value : JSON.stringify(value));
		}
	};
}

const mockHostname = 'edgetunnel.test.workers.dev';
const mockUUID = 'd342d11e-d424-4583-b36e-524ab1f0afa4';

async function runKVIntegrationTests() {
	// 用例 A：全新 KV 环境（config.json 不存在），应自动写入默认配置并包含 PROXYIP_COUNTRY: 'US'
	{
		const kv = createMockKV();
		const env = { KV: kv };
		const result = await 读取config_JSON(env, mockHostname, mockUUID);
		assert.ok(result, '应成功返回配置对象');
		assert.strictEqual(result.反代.PROXYIP_COUNTRY, 'US', '默认配置应包含 PROXYIP_COUNTRY 为 US');
		assert.strictEqual(result.反代.PROXYIP, 'auto', '默认配置 PROXYIP 应为 auto');

		// 验证 KV 中已持久化默认配置 JSON
		const storedKV = JSON.parse(await kv.get('config.json'));
		assert.strictEqual(storedKV.反代.PROXYIP_COUNTRY, 'US', 'KV 中持久化的默认配置应包含 PROXYIP_COUNTRY: US');
	}

	// 用例 B：存量老配置（KV 中已有 config.json 但缺失 PROXYIP_COUNTRY 字段）
	{
		const legacyConfig = {
			HOST: mockHostname,
			UUID: mockUUID,
			PATH: '/',
			协议类型: 'vless',
			传输协议: 'ws',
			订阅转换配置: {},
			反代: {
				PROXYIP: 'auto'
				// 故意缺失 PROXYIP_COUNTRY
			}
		};
		const kv = createMockKV({ 'config.json': JSON.stringify(legacyConfig) });
		const env = { KV: kv };
		const result = await 读取config_JSON(env, mockHostname, mockUUID);
		assert.strictEqual(result.反代.PROXYIP_COUNTRY, 'US', '读取存量老配置时应自动兜底补全 PROXYIP_COUNTRY 为 US');
	}

	// 用例 C：用户显式配置非美区国家（如 JP、HK 等），读取时不应被 US 覆盖
	{
		const jpConfig = {
			HOST: mockHostname,
			UUID: mockUUID,
			PATH: '/',
			协议类型: 'vless',
			传输协议: 'ws',
			订阅转换配置: {},
			反代: {
				PROXYIP: 'auto',
				PROXYIP_COUNTRY: 'JP'
			}
		};
		const kv = createMockKV({ 'config.json': JSON.stringify(jpConfig) });
		const env = { KV: kv };
		const result = await 读取config_JSON(env, mockHostname, mockUUID);
		assert.strictEqual(result.反代.PROXYIP_COUNTRY, 'JP', '已配置的 JP 国家代码应被正确保留');
	}

	// 用例 D：重置配置（重置配置 = true），应恢复为默认配置且包含 US
	{
		const customConfig = {
			HOST: mockHostname,
			UUID: mockUUID,
			PATH: '/',
			协议类型: 'vless',
			传输协议: 'ws',
			订阅转换配置: {},
			反代: {
				PROXYIP: '1.2.3.4:443',
				PROXYIP_COUNTRY: 'SG'
			}
		};
		const kv = createMockKV({ 'config.json': JSON.stringify(customConfig) });
		const env = { KV: kv };
		const resetResult = await 读取config_JSON(env, mockHostname, mockUUID, 'Mozilla/5.0', true);
		assert.strictEqual(resetResult.反代.PROXYIP_COUNTRY, 'US', '重置后 PROXYIP_COUNTRY 应恢复为 US');
		assert.strictEqual(resetResult.反代.PROXYIP, 'auto', '重置后 PROXYIP 应恢复为 auto');

		const storedAfterReset = JSON.parse(await kv.get('config.json'));
		assert.strictEqual(storedAfterReset.反代.PROXYIP_COUNTRY, 'US', 'KV 中的持久化配置重置后应为 US');
	}

	// 用例 E：模拟管理后台保存流程（PUT 到 KV）与再次读取的生命周期
	{
		const kv = createMockKV();
		const env = { KV: kv };
		// 1. 初始化读取
		const cfg1 = await 读取config_JSON(env, mockHostname, mockUUID);
		assert.strictEqual(cfg1.反代.PROXYIP_COUNTRY, 'US');

		// 2. 模拟管理后台修改配置并保存
		cfg1.反代.PROXYIP_COUNTRY = 'KR';
		await env.KV.put('config.json', JSON.stringify(cfg1, null, 2));

		// 3. 模拟后续请求重新读取
		const cfg2 = await 读取config_JSON(env, mockHostname, mockUUID);
		assert.strictEqual(cfg2.反代.PROXYIP_COUNTRY, 'KR', '管理后台保存后的 KR 国家代码应能被后续请求准确读回');
	}
}

await runKVIntegrationTests();

console.log('✅ KV 配置兼容与默认值补全测试通过！');
