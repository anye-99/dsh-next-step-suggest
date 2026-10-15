// 冒烟测试：直接 import 宿主端模块，验证依赖可解析 + 纯函数行为。
import assert from "node:assert";

// 用真实 http 模块起一个假 req/res，驱动路由 handler 需要 ctx.llm/ctx.webServer——
// 太依赖 cordis 上下文；这里改为验证：1) 模块能 import（dsh-llm 可解析）
// 2) inject/name 导出 3) 通过 webServer 捕获 handler 并用伪造 ctx 跑通 JSON 解析分支。

const mod = await import("../lib/index.js");
assert.strictEqual(mod.name, "dsh-next-step-suggest");
assert.ok(mod.inject.includes("llm") && mod.inject.includes("webServer"));
assert.strictEqual(typeof mod.apply, "function");
console.log("PASS import host module (dsh-llm resolvable), exports ok");

// ── 伪造 ctx 捕获路由 handler ────────────────────────────────
const routes = new Map();
const effects = [];
const fakeCtx = {
	get(key) {
		if (key === "llm") return { stream: () => [][Symbol.iterator]() };
		return undefined;
	},
	effect(fn, name) {
		effects.push(name);
		const dispose = fn();
		effects.push({ name, dispose });
	},
	webServer: {
		register(spec) {
			routes.set(spec.path, spec);
			return () => routes.delete(spec.path);
		}
	}
};
mod.apply(fakeCtx);
assert.ok(routes.has("/api/dsh-next-step-suggest"), "main route missing");
assert.ok(routes.has("/api/dsh-next-step-suggest/stop"), "stop route missing");
console.log("PASS routes registered:", [...routes.keys()].join(", "));

// ── 用伪造 req/res 走 403/405/400 分支 ───────────────────────
function fakeReq({ method = "POST", remote = "127.0.0.1", host = "127.0.0.1:19387", body = "{}" }) {
	const dataFns = [];
	const req = {
		method,
		headers: { host },
		socket: { remoteAddress: remote },
		on(event, fn) {
			if (event === "data") dataFns.push(fn);
			if (event === "end") setImmediate(() => {
				const buf = Buffer.from(body, "utf8");
				for (const data of dataFns) data(buf);
				fn();
			});
			if (event === "error") return;
		},
		removeListener() {},
		destroy() {}
	};
	return { req };
}
function fakeRes() {
	const res = {
		statusCode: 0,
		body: "",
		writableEnded: false,
		writeHead(status) { res.statusCode = status; },
		end(data) { if (data) res.body += data; res.writableEnded = true; },
		write(data) { res.body += data; },
		flushHeaders() {}
	};
	return res;
}

const main = routes.get("/api/dsh-next-step-suggest");

{
	const { req } = fakeReq({ remote: "10.0.0.5" });
	const res = fakeRes();
	await main.handler(req, res);
	assert.strictEqual(res.statusCode, 403);
	console.log("PASS 403 loopback-only");
}
{
	const { req } = fakeReq({ method: "GET" });
	const res = fakeRes();
	await main.handler(req, res);
	assert.strictEqual(res.statusCode, 405);
	console.log("PASS 405 method");
}
{
	const { req } = fakeReq({ body: JSON.stringify({ provider: "", model: "", question: "x", answer: "y" }) });
	const res = fakeRes();
	await main.handler(req, res);
	assert.strictEqual(res.statusCode, 400);
	console.log("PASS 400 empty provider/model");
}
{
	const { req } = fakeReq({ body: JSON.stringify({ provider: "deepseek", model: "m", question: "", answer: "" }) });
	const res = fakeRes();
	await main.handler(req, res);
	assert.strictEqual(res.statusCode, 400);
	console.log("PASS 400 empty question+answer");
}

// ── llm.stream 正常返回 JSON 数组 ────────────────────────────
{
	class FakeAssemblerStream {
		constructor() { this.i = 0; }
	}
	function* streamOk() {
		yield { type: "text-delta", text: '```json\n["跑一下测试","提交并推送","检查 lint 报错"]\n```' };
		yield { type: "finish", reason: { kind: "stop" } };
	}
	const ctx2 = {
		get(key) { return key === "llm" ? { stream: () => streamOk() } : undefined; },
		effect() {},
		webServer: { register: () => () => {} }
	};
	// 直接调用内部 handler：重新注册捕获
	const routes2 = new Map();
	const ctxCapture = {
		get: ctx2.get,
		effect(fn) { fn(); },
		webServer: { register: (spec) => { routes2.set(spec.path, spec); return () => {}; } }
	};
	mod.apply(ctxCapture);
	const handler = routes2.get("/api/dsh-next-step-suggest").handler;
	const { req } = fakeReq({ body: JSON.stringify({ provider: "deepseek", model: "m", question: "修好了吗", answer: "已修复 a.ts", sessionId: "s2", count: 3, lang: "zh" }) });
	const res = fakeRes();
	await handler(req, res);
	assert.strictEqual(res.statusCode, 200);
	const payload = JSON.parse(res.body);
	assert.strictEqual(payload.ok, true);
	assert.deepStrictEqual(payload.suggestions, ["跑一下测试", "提交并推送", "检查 lint 报错"]);
	console.log("PASS suggestions parsed:", JSON.stringify(payload.suggestions));
}

// ── 模型返回非 JSON（逐行兜底） ──────────────────────────────
{
	function* streamLines() {
		yield { type: "text-delta", text: "1. 跑一下单元测试\n2. 提交并推送" };
		yield { type: "finish", reason: { kind: "max-tokens" } };
	}
	const routes3 = new Map();
	const ctx3 = {
		get(key) { return key === "llm" ? { stream: () => streamLines() } : undefined; },
		effect(fn) { fn(); },
		webServer: { register: (spec) => { routes3.set(spec.path, spec); return () => {}; } }
	};
	mod.apply(ctx3);
	const handler = routes3.get("/api/dsh-next-step-suggest").handler;
	const { req } = fakeReq({ body: JSON.stringify({ provider: "p", model: "m", question: "q", answer: "a", count: 3 }) });
	const res = fakeRes();
	await handler(req, res);
	assert.strictEqual(res.statusCode, 200);
	const payload = JSON.parse(res.body);
	assert.strictEqual(payload.suggestions.length, 2);
	assert.ok(payload.suggestions[0].includes("单元测试"));
	console.log("PASS line-salvage fallback:", JSON.stringify(payload.suggestions));
}

// ── finish=error → 502 ──────────────────────────────────────
{
	function* streamErr() {
		yield { type: "text-delta", text: "x" };
		yield { type: "finish", reason: { kind: "error", failure: { message: "provider down" } } };
	}
	const routes4 = new Map();
	const ctx4 = {
		get(key) { return key === "llm" ? { stream: () => streamErr() } : undefined; },
		effect(fn) { fn(); },
		webServer: { register: (spec) => { routes4.set(spec.path, spec); return () => {}; } }
	};
	mod.apply(ctx4);
	const handler = routes4.get("/api/dsh-next-step-suggest").handler;
	const { req } = fakeReq({ body: JSON.stringify({ provider: "p", model: "m", question: "q", answer: "a" }) });
	const res = fakeRes();
	await handler(req, res);
	assert.strictEqual(res.statusCode, 502);
	console.log("PASS 502 on provider error");
}

console.log("\nALL HOST TESTS PASSED");
