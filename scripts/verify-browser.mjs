// 真实浏览器验收：在 Chrome 里用真实 React 18 挂载 lib/client.js，
// 用真实布局引擎与真实鼠标事件验证「整行点开关是否顺手」。
//
// 与 verify-toggle.mjs 的区别：那个用 mock react 验证组件树结构；
// 这个验证真实 DOM 尺寸、真实事件时序（尤其 hover 死亡间隙）。
//
// 依赖（本脚本不在 package.json 里声明，属于可选的重型验收）：
//   - playwright（本机全局或本地安装均可）
//   - react@18 / react-dom@18 的 UMD 构建
//   - 本机 Chrome
// 用法：
//   set NODE_PATH=%APPDATA%\npm\node_modules
//   node scripts\verify-browser.mjs
// 可用环境变量覆盖：
//   NSS_CHROME     Chrome 可执行文件路径
//   NSS_REACT_DIR  含 react/、react-dom/ 的 node_modules 目录
import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import http from "node:http";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT = join(HERE, "..", "lib", "client.js");

const CHROME = process.env.NSS_CHROME
	|| "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const REACT_DIR = process.env.NSS_REACT_DIR
	|| join(process.env.TEMP || "/tmp", "nss-harness", "node_modules");

// playwright 通常装在全局；通过 NODE_PATH 或本地解析
let chromium;
for (const spec of ["playwright", "playwright-core"]) {
	try {
		const req = createRequire(join(process.env.APPDATA || "", "npm", "node_modules", "x.js"));
		chromium = req(spec).chromium;
		break;
	} catch { /* try next */ }
}
if (!chromium) {
	try { chromium = (await import("playwright")).chromium; } catch { /* fall through */ }
}
if (!chromium) {
	console.error("未找到 playwright。请先安装：npm i -g playwright");
	process.exit(2);
}

const reactUmd = join(REACT_DIR, "react", "umd", "react.development.js");
const reactDomUmd = join(REACT_DIR, "react-dom", "umd", "react-dom.development.js");
for (const [p, what] of [[CLIENT, "client.js"], [reactUmd, "react UMD"], [reactDomUmd, "react-dom UMD"]]) {
	if (!existsSync(p)) {
		console.error(`缺少${what}：${p}`);
		console.error("提示：设置 NSS_REACT_DIR 指向含 react/ 与 react-dom/ 的 node_modules");
		process.exit(2);
	}
}
if (!existsSync(CHROME)) {
	console.error(`未找到 Chrome：${CHROME}（可用 NSS_CHROME 覆盖）`);
	process.exit(2);
}

const HTML = "<!doctype html><html lang='zh-CN'><head><meta charset='utf-8'></head><body><div id='root'></div></body></html>";

// localStorage 需要真实的 http 源（file:// 与 about:blank 会被拒）
const server = http.createServer((_req, res) => {
	res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
	res.end(HTML);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });

let failures = 0;
const check = (cond, msg) => {
	if (cond) { console.log("PASS " + msg); } else { console.log("FAIL " + msg); failures += 1; }
};

try {
	await page.goto(BASE, { waitUntil: "domcontentloaded" });
	await page.addScriptTag({ path: reactUmd });
	await page.addScriptTag({ path: reactDomUmd });

	await page.evaluate(() => {
		window.localStorage.removeItem("dsh-next-step-suggest:auto");
		window.__loaded = null;
		window.__ModuleLoader__ = { load: (spec) => { window.__loaded = spec; } };
		window.fetch = () => Promise.resolve({
			ok: true,
			json: () => Promise.resolve({ ok: true, suggestions: ["建议一", "建议二"] })
		});
	});
	await page.addScriptTag({ content: readFileSync(CLIENT, "utf8") });

	const mounted = await page.evaluate(() => {
		const spec = window.__loaded;
		if (!spec) return "模块未注册";
		const React = window.React;
		const rs = Object.assign({}, React); rs.default = rs;
		const rds = { createPortal: window.ReactDOM.createPortal }; rds.default = rds;
		const req = (id) => {
			if (id === "react") return rs;
			if (id === "react-dom") return rds;
			throw new Error("unexpected require: " + id);
		};
		// useSyncExternalStore 要求 getSnapshot 返回稳定引用，
		// 否则真实 React 会因快照恒变而无限重渲染。
		const snap = { current: { provider: "deepseek", model: "d1" }, groups: [] };
		const store = { subscribe: () => () => {}, getSnapshot: () => snap };
		let registered = null;
		spec.factory(req).apply({
			inject(_ids, fn) {
				fn({
					modelDirectories: { directoryFor: () => ({ store }) },
					sessions: { subagentAddress: () => undefined },
					slots: { inject(_n, f) { f(); }, register(_d, c) { registered = c; return () => {}; } }
				});
			}
		});
		if (!registered) return "组件未注册";
		const chatNodes = [
			{ kind: "user", anchorSeq: 1, data: { content: [{ type: "text", text: "问题" }] } },
			{ kind: "assistant-step", anchorSeq: 2, data: { blocks: [{ kind: "text", text: "回答" }] } },
			{ kind: "turn-tail", anchorSeq: 3 }
		];
		window.ReactDOM.createRoot(document.getElementById("root")).render(
			React.createElement(registered, {
				available: true,
				directory: store,
				inputActions: { setDraft: () => {} },
				sessionId: "s1",
				useChat: (sel) => sel({ order: [], nodes: { values: () => chatNodes[Symbol.iterator]() } }),
				useInput: (sel) => sel({ draft: "" })
			})
		);
		return "";
	});
	check(!mounted, `在真实 Chrome 中挂载${mounted ? "失败：" + mounted : "成功"}`);

	await page.hover(".nss-trigger");
	await page.waitForSelector(".nss-pop", { timeout: 3000 });
	check(true, "悬停打开弹层");

	// 真实尺寸：整行应明显大于轨道，高度够触控
	const dims = await page.evaluate(() => {
		const row = document.querySelector(".nss-pop .nss-autoRow");
		const track = row.querySelector(".nss-switch");
		const rr = row.getBoundingClientRect(), tr = track.getBoundingClientRect();
		return {
			rowW: rr.width, rowH: rr.height, trackW: tr.width, trackH: tr.height,
			tag: row.tagName, role: row.getAttribute("role"), checked: row.getAttribute("aria-checked"),
			trackTag: track.tagName, trackHidden: track.getAttribute("aria-hidden"),
			cursor: getComputedStyle(row).cursor
		};
	});
	console.log(`     整行 ${dims.rowW}x${dims.rowH}，轨道 ${dims.trackW}x${dims.trackH}`);
	check(dims.tag === "BUTTON" && dims.role === "switch", "开关行是 button[role=switch]");
	check(dims.rowH >= 34, `整行高度 ${dims.rowH}px 达到触控目标`);
	check(dims.rowW > dims.trackW + 40, "整行明显宽于轨道（文字也是热区）");
	check(dims.trackTag !== "BUTTON" && dims.trackHidden === "true", "轨道是装饰元素（无重复 tab 停靠点）");
	check(dims.cursor === "pointer", "整行 cursor:pointer");

	// 点击文字区域（远离轨道）也应生效
	const labelPt = await page.evaluate(() => {
		const l = document.querySelector(".nss-pop .nss-autoLabel").getBoundingClientRect();
		return { x: l.x + l.width / 2, y: l.y + l.height / 2 };
	});
	await page.mouse.click(labelPt.x, labelPt.y);
	check(await page.getAttribute(".nss-pop .nss-autoRow", "aria-checked") === "false",
		"点击文字区域即翻转（不必瞄准轨道）");
	check(await page.evaluate(() => localStorage.getItem("dsh-next-step-suggest:auto")) === "0",
		"切换已持久化到 localStorage");

	// 死亡间隙：鼠标从图标逐步移入弹层
	const trig = await page.evaluate(() => {
		const r = document.querySelector(".nss-trigger").getBoundingClientRect();
		return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
	});
	const popPt = await page.evaluate(() => {
		const r = document.querySelector(".nss-pop").getBoundingClientRect();
		return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
	});
	await page.mouse.move(trig.x, trig.y);
	for (let i = 1; i <= 12; i++) {
		const t = i / 12;
		await page.mouse.move(trig.x + (popPt.x - trig.x) * t, trig.y + (popPt.y - trig.y) * t);
		await page.waitForTimeout(20);
	}
	check(!!(await page.$(".nss-pop")), "鼠标从图标移入弹层全程存活（死亡间隙已修复）");

	// 打开建议面板，验证两处开关状态同步
	await page.evaluate(() => {
		document.querySelector(".nss-trigger").dispatchEvent(new MouseEvent("click", { bubbles: true }));
	});
	await page.waitForSelector(".nss-head .nss-autoRow", { timeout: 5000 });
	check(true, "建议面板头部含常驻开关");

	const read2 = () => page.evaluate(() => {
		const p = document.querySelector(".nss-pop .nss-autoRow");
		const h = document.querySelector(".nss-head .nss-autoRow");
		return { pop: p && p.getAttribute("aria-checked"), panel: h && h.getAttribute("aria-checked") };
	});
	const before = await read2();
	check(before.pop === before.panel, `两处开关初始一致（${before.pop}）`);

	await page.click(".nss-head .nss-autoRow");
	await page.waitForTimeout(120);
	const afterPanel = await read2();
	check(afterPanel.panel === "true" && afterPanel.pop === "true",
		"点面板开关 → 弹层开关同步");

	await page.click(".nss-pop .nss-autoRow");
	await page.waitForTimeout(120);
	const afterPop = await read2();
	check(afterPop.pop === "false" && afterPop.panel === "false",
		"点弹层开关 → 面板开关同步（双向一致）");

	if (errors.length) {
		console.log("--- 页面错误 ---");
		errors.slice(0, 10).forEach((e) => console.log("  " + e));
	}
} finally {
	await browser.close();
	server.close();
}

console.log("");
if (failures === 0) {
	console.log("ALL REAL-BROWSER CHECKS PASSED");
} else {
	console.log(`${failures} 项失败`);
	process.exit(1);
}
