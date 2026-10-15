// 验收：两个开关（悬停弹层 + 面板头部）是否共享同一份状态。
//
// 结论预期：是。autoRow() 每次调用都读同一个 `auto` useState 值，
// 两个入口只是同一状态的两个视图，点任一个都会立即反映到另一个。
// 本测试用真实 useState 驱动点击来证明，而不是只读源码。
import { readFileSync } from "node:fs";

// ── 环境 mock ─────────────────────────────────────────────────
let factory = null;
globalThis.window = {
	__ModuleLoader__: { load: (spec) => { factory = spec.factory; } },
	localStorage: (() => {
		const store = new Map();
		return {
			getItem: (k) => (store.has(k) ? store.get(k) : null),
			setItem: (k, v) => { store.set(k, String(v)); },
			_store: store
		};
	})(),
	addEventListener: () => {},
	removeEventListener: () => {},
	setTimeout: (fn, ms) => setTimeout(fn, ms),
	clearTimeout: (id) => clearTimeout(id),
	innerWidth: 1280,
	innerHeight: 800
};
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.cancelAnimationFrame = () => {};
globalThis.document = {
	documentElement: { lang: "zh-CN" },
	getElementById: () => null,
	querySelector: () => null,
	createElement: () => ({ dataset: {}, style: { setProperty() {} } }),
	head: { appendChild() {} },
	body: {}
};
globalThis.getComputedStyle = () => ({ position: "static", borderRadius: "0px" });
Object.defineProperty(globalThis, "navigator", { value: { language: "zh-CN" }, configurable: true });

// fetch mock：让 generate() 走到 panelOpen=true，从而同时渲染弹层与面板
let fetchCalls = 0;
globalThis.fetch = (url) => {
	fetchCalls += 1;
	return Promise.resolve({
		ok: true,
		json: () => Promise.resolve({ ok: true, suggestions: ["建议一", "建议二"] })
	});
};

// ── react mock：真实 useState，set 直接改状态供下次 render 读取 ──
const states = [];
let cursor = 0;
const reactMock = {
	createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat() }),
	useState(init) {
		const i = cursor++;
		if (states[i] === undefined) states[i] = typeof init === "function" ? init() : init;
		return [states[i], (next) => { states[i] = typeof next === "function" ? next(states[i]) : next; }];
	},
	useRef(init) {
		const i = cursor++;
		if (states[i] === undefined) states[i] = { current: init };
		return states[i];
	},
	useLayoutEffect(fn) { const i = cursor++; void fn; void i; },
	useEffect(fn) { void fn; },
	useSyncExternalStore(_sub, snap) { cursor++; return snap(); }
};
reactMock.default = reactMock;
const reactDomMock = { createPortal: (node) => node };
reactDomMock.default = reactDomMock;
Object.defineProperty(reactMock, "__esModule", { value: true });
Object.defineProperty(reactDomMock, "__esModule", { value: true });

const require_ = (id) => {
	if (id === "react") return reactMock;
	if (id === "react-dom") return reactDomMock;
	throw new Error("unexpected require: " + id);
};

const src = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
new Function(src)();
const exports = factory(require_);

let registered = null;
exports.apply({
	inject(_ids, fn) {
		fn({
			modelDirectories: { directoryFor: () => ({ store: { subscribe: () => () => {}, getSnapshot: () => ({ current: { provider: "deepseek", model: "d1" }, groups: [] }) } }) },
			sessions: { subagentAddress: () => undefined },
			slots: {
				inject(_name, f) { f(); },
				register(_def, component) { registered = component; return () => {}; }
			}
		});
	}
});

function findAll(node, pred, out = []) {
	if (!node || typeof node !== "object") return out;
	if (pred(node)) out.push(node);
	for (const c of node.children || []) findAll(c, pred, out);
	return out;
}
const isSwitchRow = (n) =>
	n.type === "button" && n.props && n.props.role === "switch" && String(n.props.className || "").includes("nss-autoRow");
const byClass = (cls) => (n) => n.props && String(n.props.className || "").split(/\s+/).includes(cls);

const chatNodes = [
	{ kind: "user", anchorSeq: 1, data: { content: [{ type: "text", text: "问题" }] } },
	{ kind: "assistant-step", anchorSeq: 2, data: { blocks: [{ kind: "text", text: "回答" }] } },
	{ kind: "turn-tail", anchorSeq: 3 }
];
const props = {
	available: true,
	directory: { subscribe: () => () => {}, getSnapshot: () => ({ current: { provider: "deepseek", model: "d1" }, groups: [] }) },
	inputActions: { setDraft: () => {} },
	sessionId: "s1",
	useChat: (sel) => sel({ order: [], nodes: { values: () => chatNodes[Symbol.iterator]() } }),
	useInput: (sel) => sel({ draft: "" })
};

let tree = null;
function render() { cursor = 0; tree = registered(props); return tree; }

// ── 让弹层与面板同时出现 ──────────────────────────────────────
render();
// 1) 悬停打开弹层
findAll(tree, byClass("nss-root"))[0].props.onMouseEnter();
render();
// 2) 点击 ✨ 触发 generate() → panelOpen=true（fetch 已 mock）
findAll(tree, byClass("nss-trigger"))[0].props.onClick();
// 等待 fetch 的 promise 链落定（.then 里 setPhase/setSuggestions）
await new Promise((r) => setTimeout(r, 20));
render();

if (fetchCalls === 0) throw new Error("generate() 未发起请求，panelOpen 路径没走到");

const rows = findAll(tree, isSwitchRow);
if (rows.length !== 2) throw new Error(`期望同时存在 2 个开关（弹层+面板），实际 ${rows.length}`);
console.log("PASS 弹层与面板同时渲染出 2 个开关");

const [popRow, panelRow] = rows;
if (popRow.props["aria-checked"] !== panelRow.props["aria-checked"]) {
	throw new Error("初始状态就不一致");
}
console.log("PASS 初始状态一致:", popRow.props["aria-checked"]);

// ── 点弹层里的开关，面板里的应同步 ────────────────────────────
popRow.props.onClick();
render();
let after = findAll(tree, isSwitchRow);
if (after.length !== 2) throw new Error("点击后开关数量变化: " + after.length);
if (after[0].props["aria-checked"] !== false || after[1].props["aria-checked"] !== false) {
	throw new Error(`点弹层后未同步: pop=${after[0].props["aria-checked"]} panel=${after[1].props["aria-checked"]}`);
}
if (window.localStorage.getItem("dsh-next-step-suggest:auto") !== "0") throw new Error("未持久化");
console.log("PASS 点弹层开关 → 面板开关同步为 false，且已持久化");

// ── 点面板里的开关，弹层里的应同步 ────────────────────────────
const panelRow2 = findAll(tree, isSwitchRow)[1];
panelRow2.props.onClick();
render();
after = findAll(tree, isSwitchRow);
if (after[0].props["aria-checked"] !== true || after[1].props["aria-checked"] !== true) {
	throw new Error(`点面板后未同步: pop=${after[0].props["aria-checked"]} panel=${after[1].props["aria-checked"]}`);
}
if (window.localStorage.getItem("dsh-next-step-suggest:auto") !== "1") throw new Error("未持久化 true");
console.log("PASS 点面板开关 → 弹层开关同步为 true，且已持久化");

// ── 二者同源的结构性证据：都调用同一个 autoRow() ──────────────
const callSites = (src.match(/autoRow\((?:true|false)\)/g) || []).length;
if (callSites !== 2) throw new Error("autoRow 调用点应为 2 处，实际 " + callSites);
const stateDecls = (src.match(/useState\(readAuto\)/g) || []).length;
if (stateDecls !== 1) throw new Error("auto 状态应只声明一次，实际 " + stateDecls);
console.log("PASS 结构证据：autoRow 2 处调用，共用 1 个 useState(readAuto)");

console.log("\nALL SYNC CHECKS PASSED");
