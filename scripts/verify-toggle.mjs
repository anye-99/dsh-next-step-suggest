// 一次性验收：验证「自动生成」开关的可点击性改造。
// 检查项：
//   1. 悬停弹层与面板头部都渲染出开关行；
//   2. 开关行是整行 button[role=switch]，而不是只有 40x22 的小轨道；
//   3. 轨道本身不再是可聚焦控件（aria-hidden），避免双重 tab 停靠点；
//   4. 点击整行能翻转状态并写回 localStorage；
//   5. 弹层有延迟关闭（消除 hover 死亡间隙），进入弹层会取消关闭。
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

// ── react mock：真实驱动 useState，才能验证点击翻转 ────────────
let pending = [];
function makeHooks() {
	const states = [];
	let cursor = 0;
	const effects = [];
	return {
		reset() { cursor = 0; },
		useState(init) {
			const i = cursor++;
			if (states[i] === undefined) states[i] = typeof init === "function" ? init() : init;
			const set = (next) => {
				states[i] = typeof next === "function" ? next(states[i]) : next;
			};
			return [states[i], set];
		},
		useRef(init) {
			const i = cursor++;
			if (states[i] === undefined) states[i] = { current: init };
			return states[i];
		},
		useLayoutEffect(fn) { const i = cursor++; effects[i] = fn; },
		useSyncExternalStore(_sub, snap) { cursor++; return snap(); },
		useEffect(fn) { const i = cursor++; effects[i] = fn; },
		effects
	};
}
const hooks = makeHooks();
const reactMock = {
	createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat() }),
	useState: (i) => hooks.useState(i),
	useRef: (i) => hooks.useRef(i),
	useLayoutEffect: (fn) => hooks.useLayoutEffect(fn),
	useEffect: (fn) => hooks.useEffect(fn),
	useSyncExternalStore: (a, b) => hooks.useSyncExternalStore(a, b)
};
reactMock.default = reactMock;
const portals = [];
const reactDomMock = { createPortal: (node) => { portals.push(node); return node; } };
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

// ── 工具：在组件树里查找 ──────────────────────────────────────
function findAll(node, pred, out = []) {
	if (!node || typeof node !== "object") return out;
	if (pred(node)) out.push(node);
	for (const c of node.children || []) findAll(c, pred, out);
	return out;
}
const isSwitchRow = (n) =>
	n.type === "button" && n.props && n.props.role === "switch" && String(n.props.className || "").includes("nss-autoRow");

// ── 渲染 ──────────────────────────────────────────────────────
const chatNodes = [
	{ kind: "user", anchorSeq: 1, data: { content: [{ type: "text", text: "问题" }] } },
	{ kind: "assistant-step", anchorSeq: 2, data: { blocks: [{ kind: "text", text: "回答" }] } },
	{ kind: "turn-tail", anchorSeq: 3 }
];
let tree = null;
const props = {
	available: true,
	directory: { subscribe: () => () => {}, getSnapshot: () => ({ current: { provider: "deepseek", model: "d1" }, groups: [] }) },
	inputActions: { setDraft: () => {} },
	sessionId: "s1",
	useChat: (sel) => sel({ order: [], nodes: { values: () => chatNodes[Symbol.iterator]() } }),
	useInput: (sel) => sel({ draft: "" })
};

function render() {
	hooks.reset();
	portals.length = 0;
	tree = registered(props);
	return tree;
}

// 第一次渲染：hoverPop=false、panelOpen=false → 无弹层
render();
if (portals.length !== 0) throw new Error("初始不应有浮层");
console.log("PASS 初始无浮层");

// 触发 hover：找到 nss-root 的 onMouseEnter
const root = findAll(tree, (n) => n.props && String(n.props.className || "").includes("nss-root"))[0];
if (!root) throw new Error("未找到 nss-root");
if (typeof root.props.onMouseEnter !== "function") throw new Error("nss-root 缺少 onMouseEnter");
root.props.onMouseEnter();
render();

const popSwitchRows = findAll(tree, isSwitchRow);
if (popSwitchRows.length !== 1) throw new Error("悬停弹层应恰好有 1 个开关行，实际 " + popSwitchRows.length);
const row = popSwitchRows[0];
if (String(row.props.className).includes("nss-autoRowCompact")) throw new Error("弹层开关不应是 compact 形态");
console.log("PASS 悬停弹层含整行开关（button[role=switch]）");

// 开关行必须包含轨道，且轨道不是可交互控件
const track = findAll(row, (n) => n.props && String(n.props.className || "").includes("nss-switch"))[0];
if (!track) throw new Error("开关行内缺少 nss-switch 轨道");
if (track.type === "button") throw new Error("轨道不应再是 button（避免双重 tab 停靠点）");
if (track.props["aria-hidden"] !== "true") throw new Error("轨道应 aria-hidden");
console.log("PASS 轨道是装饰元素（aria-hidden），整行才是控件");

// 标签存在且文案正确
const label = findAll(row, (n) => n.props && String(n.props.className || "").includes("nss-autoLabel"))[0];
if (!label || label.children[0] !== "回答结束后自动生成") throw new Error("标签文案不对: " + JSON.stringify(label && label.children));
console.log("PASS 标签文案:", label.children[0]);

// 点击整行 → 翻转并写回 localStorage
if (row.props["aria-checked"] !== true) throw new Error("默认应为开");
row.props.onClick();
const stored = window.localStorage.getItem("dsh-next-step-suggest:auto");
if (stored !== "0") throw new Error("点击后应写入 0，实际 " + stored);
console.log("PASS 点击整行翻转并持久化 (auto=0)");

render();
const rowAfter = findAll(tree, isSwitchRow)[0];
if (rowAfter.props["aria-checked"] !== false) throw new Error("再次渲染后应为关");
console.log("PASS 状态回读正确 (aria-checked=false)");

// 延迟关闭：mouseleave 后弹层仍在，进入弹层取消关闭
const root2 = findAll(tree, (n) => n.props && String(n.props.className || "").includes("nss-root"))[0];
root2.props.onMouseLeave();
render();
if (findAll(tree, isSwitchRow).length !== 1) throw new Error("mouseleave 后应仍在（延迟关闭），立即消失说明间隙未修复");
console.log("PASS mouseleave 不立即关闭（消除 hover 死亡间隙）");

const pop = findAll(tree, (n) => n.props && String(n.props.className || "").includes("nss-pop"))[0];
if (!pop) throw new Error("未找到弹层");
pop.props.onMouseEnter();
render();
if (findAll(tree, isSwitchRow).length !== 1) throw new Error("进入弹层后应保持打开");
console.log("PASS 进入弹层取消关闭");

// 面板头部也有开关（不依赖悬停）
const trigger = findAll(tree, (n) => n.type === "button" && String(n.props.className || "").includes("nss-trigger"))[0];
if (!trigger) throw new Error("未找到 trigger");
// 面板只在 panelOpen 时渲染；通过点击 trigger 触发一次生成会打开面板，
// 但生成会发 fetch。这里改为直接断言源码里面板头部引用了 autoRow(true)。
const sourceHasPanelToggle = /className: "nss-head"[\s\S]{0,200}autoRow\(true\)/.test(src);
if (!sourceHasPanelToggle) throw new Error("面板头部未挂载开关（autoRow(true)）");
console.log("PASS 面板头部常驻开关（不依赖悬停）");

// 样式断言
if (!/\.nss-autoRow\{[^}]*min-height:36px/.test(src)) throw new Error("开关行缺少 36px 最小高度");
if (!/\.nss-switch\{[^}]*width:40px;height:22px/.test(src)) throw new Error("轨道尺寸未放大到 40x22");
console.log("PASS 触控尺寸：整行 36px 高、轨道 40x22");

console.log("\nALL TOGGLE CHECKS PASSED");
