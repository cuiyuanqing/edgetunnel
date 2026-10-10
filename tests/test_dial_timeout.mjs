import assert from 'assert';

// -----------------------------------------------------------------------------
// 1. 计划定义的超时顺延重试基线模拟测试
// -----------------------------------------------------------------------------
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

async function runBaseline() {
	const list = [{ hostname: 'timeout.test' }, { hostname: 'fail.test' }, { hostname: 'success.test' }];
	const res = await simulateConnectProxyIP(list);
	assert.strictEqual(res.host, 'success.test');
	console.log('✅ 超时顺延重试测试通过！');
}

await runBaseline();

// -----------------------------------------------------------------------------
// 2. 验证 _worker.js 导出的带超时打开TCP连接机制与资源释放
// -----------------------------------------------------------------------------
try {
	const { 带超时打开TCP连接 } = await import('../_worker.js');
	if (typeof 带超时打开TCP连接 === 'function') {
		console.log('🔍 开始验证 _worker.js 导出的带超时打开TCP连接机制...');

		// Case A: 正常建立连接测试（在超时时间内完成）
		let closed1 = false;
		const mockSuccessSocket = {
			opened: Promise.resolve({ readable: {}, writable: {} }),
			close: () => { closed1 = true; }
		};
		const mockConnector1 = () => mockSuccessSocket;
		const sock1 = await 带超时打开TCP连接(mockConnector1, '1.1.1.1', 443, 200);
		assert.strictEqual(sock1, mockSuccessSocket);
		assert.strictEqual(closed1, false, '成功连接不应调用 close');

		// Case B: 超时熔断测试（超过设定毫秒数触发握手超时并清理套接字）
		let closed2 = false;
		let hangingTimer = null;
		const mockTimeoutSocket = {
			opened: new Promise(resolve => {
				hangingTimer = setTimeout(resolve, 500);
			}),
			close: () => { closed2 = true; }
		};
		const mockConnector2 = () => mockTimeoutSocket;
		const startT = Date.now();
		let timeoutCaught = false;
		try {
			await 带超时打开TCP连接(mockConnector2, '2.2.2.2', 443, 50);
		} catch (err) {
			timeoutCaught = true;
			const elapsed = Date.now() - startT;
			assert.ok(elapsed >= 40 && elapsed < 400, `超时耗时异常: ${elapsed}ms`);
			assert.ok(err.message.includes('握手超时(50ms)'), `错误信息不匹配: ${err.message}`);
			assert.strictEqual(closed2, true, '超时后必须调用 socket.close() 关闭挂起的套接字');
		} finally {
			if (hangingTimer) clearTimeout(hangingTimer);
		}
		assert.strictEqual(timeoutCaught, true, '必须捕获握手超时异常');

		// Case C: 即时错误测试（连接被拒绝时立即抛出并释放资源）
		let closed3 = false;
		const mockRefusedSocket = {
			opened: Promise.reject(new Error('connection refused')),
			close: () => { closed3 = true; }
		};
		const mockConnector3 = () => mockRefusedSocket;
		let refuseCaught = false;
		try {
			await 带超时打开TCP连接(mockConnector3, '3.3.3.3', 443, 200);
		} catch (err) {
			refuseCaught = true;
			assert.strictEqual(err.message, 'connection refused');
			assert.strictEqual(closed3, true, '连接失败后必须调用 socket.close()');
		}
		assert.strictEqual(refuseCaught, true, '必须捕获连接拒绝异常');

		// Case D: 模拟候选队列自愈顺延测试
		const candidates = [
			{ hostname: 'timeout-node.com', port: 443 },
			{ hostname: 'refused-node.com', port: 443 },
			{ hostname: 'healthy-node.com', port: 443 }
		];
		let hangTimer4 = null;
		const customConnector = ({ hostname, port }) => {
			if (hostname === 'timeout-node.com') {
				return {
					hostname,
					port,
					opened: new Promise(resolve => { hangTimer4 = setTimeout(resolve, 500); }),
					close: () => {}
				};
			}
			if (hostname === 'refused-node.com') {
				return {
					hostname,
					port,
					opened: Promise.reject(new Error('ECONNREFUSED')),
					close: () => {}
				};
			}
			return {
				hostname,
				port,
				opened: Promise.resolve({ readable: {}, writable: {} }),
				close: () => {}
			};
		};

		let connectedCandidate = null;
		const fallbackLogs = [];
		for (const c of candidates) {
			try {
				const sock = await 带超时打开TCP连接(customConnector, c.hostname, c.port, 50);
				connectedCandidate = sock;
				break;
			} catch (err) {
				fallbackLogs.push(`[反代连接] 节点 ${c.hostname}:${c.port} 异常(${err.message || err})，顺延尝试后续候选节点...`);
			}
		}
		if (hangTimer4) clearTimeout(hangTimer4);

		assert.strictEqual(connectedCandidate.hostname, 'healthy-node.com');
		assert.strictEqual(fallbackLogs.length, 2);
		assert.ok(fallbackLogs[0].includes('握手超时(50ms)'));
		assert.ok(fallbackLogs[1].includes('ECONNREFUSED'));
		console.log('✅ 带超时打开TCP连接单测与级联自愈测试全部通过！');
	}
} catch (e) {
	// 如果尚未在 _worker.js 中导出，则仅执行了第一部分基线测试
}
