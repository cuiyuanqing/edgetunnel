import assert from 'assert';
import crypto from 'crypto';
import worker, { blogDaTree, nginx } from '../_worker.js';

console.log('🔍 开始执行 DaTree 静态博客伪装页面单元测试...');

// 0. Node.js 环境补丁：SubtleCrypto MD5 适配（Cloudflare Workers 原生支持 MD5）
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

// 1. 验证导出的 blogDaTree 和 nginx 函数
assert.strictEqual(typeof blogDaTree, 'function', 'blogDaTree 必须为可调用的异步函数');
assert.strictEqual(typeof nginx, 'function', 'nginx 兼容函数必须为可调用的异步函数');

const blogHtml = await blogDaTree();
const nginxHtml = await nginx();

assert.ok(blogHtml.length > 1000, '博客 HTML 内容长度应具备真实博客体量');
assert.ok(blogHtml.includes("DaTree's Blog"), '页面必须包含 DaTree\'s Blog 标题');
assert.ok(blogHtml.includes('DaTree'), '页面必须包含作者 DaTree 信息');
assert.ok(blogHtml.includes('深入浅出边缘计算'), '页面必须包含推荐博文 1');
assert.ok(blogHtml.includes('现代网络协议演进笔记'), '页面必须包含推荐博文 2');
assert.ok(blogHtml.includes('以简驭繁'), '页面必须包含推荐博文 3');
assert.ok(blogHtml.includes('高可用服务设计'), '页面必须包含推荐博文 4');
assert.ok(blogHtml.includes('modal-container') || blogHtml.includes('reader-modal') || blogHtml.includes('article-modal'), '页面必须包含用于无刷新阅读全文的模态/抽屉容器');
assert.ok(blogHtml.includes('theme-toggle'), '页面必须包含明暗主题切换逻辑');

// 验证 nginx() 调用返回的也是 DaTree 博客
assert.ok(nginxHtml.includes('DaTree'), 'nginx() 伪装函数应返回 DaTree 博客以增强伪装真实度');

console.log('✅ 静态博客模板内容与必要元素测试通过！');

// 2. 模拟 Worker 根路径 GET / 请求
const fakeEnv = {
	UUID: 'd342d11e-d424-4583-b36e-524ab1f0afa4',
	URL: 'nginx'
};

const reqRoot = new Request('https://proxy.example.com/', {
	method: 'GET',
	headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
});

const resRoot = await worker.fetch(reqRoot, fakeEnv, {});
assert.strictEqual(resRoot.status, 200, '根路径请求必须返回 200 状态码');
assert.ok(resRoot.headers.get('content-type')?.includes('text/html'), 'Content-Type 必须为 text/html');
const resRootText = await resRoot.text();
assert.ok(resRootText.includes("DaTree's Blog"), '根路径响应体必须包含 DaTree\'s Blog 伪装页面');

// 3. 模拟普通非节点子路径访问 (如 /about, /articles 等)
const reqSub = new Request('https://proxy.example.com/about', {
	method: 'GET',
	headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
});
const resSub = await worker.fetch(reqSub, fakeEnv, {});
assert.strictEqual(resSub.status, 200, '非节点路径请求应返回 200 伪装博客');
const resSubText = await resSub.text();
assert.ok(resSubText.includes("DaTree"), '非节点路径必须呈现 DaTree 伪装内容');

console.log('✅ Worker 请求路由与伪装页面集成测试通过！');
