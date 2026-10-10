import assert from 'assert';
import { 美区高可用备用热池 as worker热池, 打乱数组 as worker打乱数组, 获取出口反代候选队列 as worker获取出口反代候选队列 } from '../_worker.js';

// -----------------------------------------------------------------------------
// 1. 验证待测算法规范实现（计划定义的自包含基线算法）
// -----------------------------------------------------------------------------
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

// -----------------------------------------------------------------------------
// 2. 深入验证 _worker.js 导出模块真实运行逻辑
// -----------------------------------------------------------------------------
console.log('🔍 开始验证 _worker.js 导出的生产环境出口路由与热备引擎...');

// 2.1 验证美区热备池元素与规格
assert.strictEqual(worker热池.length, 8, '热备池必须包含正好 8 个精选 IPv4 节点');
assert.deepStrictEqual([...worker热池].sort(), [...美区高可用备用热池].sort(), 'Worker 内部热备池与基准池列表一致');
for (const ipPort of worker热池) {
    assert.match(ipPort, /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:443$/, `每个节点必须为 IPv4:443 格式: ${ipPort}`);
}

// 2.2 验证打乱数组函数特性（不破坏原数组，且打乱后元素集合一致）
const originalCopy = [...worker热池];
const shuffled = worker打乱数组(worker热池);
assert.strictEqual(shuffled.length, worker热池.length, '打乱后长度一致');
assert.deepStrictEqual([...shuffled].sort(), [...originalCopy].sort(), '打乱后元素内容集合一致');
assert.deepStrictEqual(worker热池, originalCopy, '打乱函数不得就地污染原数组');

// 2.3 验证 Worker 真实导出函数（数组模式 asArray = true）
// 场景 1: 节点级显式指定 IP
const wRes1 = worker获取出口反代候选队列({}, {}, '1.1.1.1:443', {}, true);
assert.strictEqual(wRes1[0], '1.1.1.1:443');

// 场景 2: 自动获取 + US（默认值兜底，即便未传入 config_JSON）
const wRes2 = worker获取出口反代候选队列({ cf: { colo: 'sjc' } }, {}, null, null, true);
assert.strictEqual(wRes2[0], 'us.proxyip.cmliussss.net', '首位必须为 us 动态出口域名');
assert.strictEqual(wRes2.length, 9, '总候选队列必须为 1 动态 + 8 静态');
for (const ip of worker热池) {
    assert.ok(wRes2.includes(ip), `候选队列必须包含备用热备节点: ${ip}`);
}

// 场景 3: 自动获取 + 国家指定为 GB
const wRes3 = worker获取出口反代候选队列({ cf: { colo: 'lhr' } }, { PROXYIP_COUNTRY: 'GB' }, 'auto', null, true);
assert.strictEqual(wRes3[0], 'gb.proxyip.cmliussss.net');
assert.strictEqual(wRes3.length, 9);

// 场景 4: 自动获取 + 国家指定为 AUTO（走机房代码 sjc / hkg 等）
const wRes4 = worker获取出口反代候选队列({ cf: { colo: 'hkg' } }, {}, 'auto', { 反代: { PROXYIP: 'auto', PROXYIP_COUNTRY: 'AUTO' } }, true);
assert.strictEqual(wRes4[0], 'hkg.proxyip.cmliussss.net');
assert.strictEqual(wRes4.length, 1);

// 场景 5: Worker 字符串模式 (默认 asArray = false，用于 fetch 中默认反代IP)
const strQueue = worker获取出口反代候选队列({ cf: { colo: 'sjc' } }, {}, null, { 反代: { PROXYIP: 'auto', PROXYIP_COUNTRY: 'US' } }, false);
assert.strictEqual(typeof strQueue, 'string', '默认返回逗号分隔的字符串以兼容 整理成数组()');
const parsedQueue = strQueue.split(',');
assert.strictEqual(parsedQueue[0], 'us.proxyip.cmliussss.net');
assert.strictEqual(parsedQueue.length, 9);

// 场景 6: 自定义固定 ProxyIP 模式时原样返回
const fixedIp = '104.21.5.10:443';
const fixedQueue = worker获取出口反代候选队列({}, { PROXYIP: fixedIp }, fixedIp, null, false);
assert.strictEqual(fixedQueue, fixedIp);

console.log('✅ 所有出口路由测试用例通过！');
