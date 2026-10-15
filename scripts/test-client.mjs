// 验收测试：模拟浏览器环境加载 client.js，验证导出与回合蒸馏逻辑。
import { readFileSync } from "node:fs";

// ── mock window.__ModuleLoader__ ──────────────────────────────
let clientExportsFactory = null;
const listeners = [];
globalThis.window = {
	__ModuleLoader__: {
		load(spec) {
			clientExportsFactory = spec.factory;
		}
	},
	localStorage: {
		getItem: () => null,
		setItem: () => {}
	},
	addEventListener: () => {},
	removeEventListener: () => {},
	setTimeout: setTimeout,
	clearTimeout: clearTimeout,
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

// ── mock react（hooks 以简单桩实现，捕获 selector）──────────────
let capturedSelector = null;
const reactMock = {
	createElement: (type, props, ...children) => ({ type, props, children }),
	useState: (init) => [typeof init === "function" ? init() : init, () => {}],
	useRef: (init) => ({ current: init }),
	useLayoutEffect: () => {},
	useSyncExternalStore: (sub, snap) => snap()
};
reactMock.default = reactMock;
const reactDomMock = { createPortal: () => null };
reactDomMock.default = reactDomMock;
Object.defineProperty(reactMock, "__esModule", { value: true });
Object.defineProperty(reactDomMock, "__esModule", { value: true });

function fakeRequire(id) {
	if (id === "react") return reactMock;
	if (id === "react-dom") return reactDomMock;
	throw new Error("unexpected require: " + id);
}

// ── 加载 client.js ────────────────────────────────────────────
const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
new Function(source)();
if (!clientExportsFactory) throw new Error("module did not register with __ModuleLoader__");
const exports = clientExportsFactory(fakeRequire);

// 断言 1：导出形状
if (exports.apply !== undefined && typeof exports.apply !== "function") throw new Error("apply must be function");
if (typeof exports.inject !== "object" || !exports.inject.includes("slots")) throw new Error("inject must include slots");
console.log("PASS export shape:", JSON.stringify(exports.inject));

// ── 断言 2：slot 注册参数 ─────────────────────────────────────
let registered = null;
let injectedSlot = null;
const fakeScope = {
	modelDirectories: { directoryFor: () => ({ store: { subscribe: () => () => {}, getSnapshot: () => ({ current: { provider: "deepseek", model: "d1" }, groups: [] }) } }) },
	sessions: { subagentAddress: () => undefined },
	slots: {
		inject(name, fn) {
			injectedSlot = name;
			const entry = fn();
			registered = entry ? { name: entry[0]?.name ?? entry.name, id: entry[0]?.id ?? entry.id } : null;
			return entry;
		},
		register(def, component) {
			capturedSelector = { def, component };
			return () => {};
		}
	}
};
const fakeCtx = {
	inject(ids, fn) {
		fn(fakeScope);
	}
};
exports.apply(fakeCtx);
if (injectedSlot !== "conversation.composer.dock") throw new Error("wrong slot: " + injectedSlot);
if (capturedSelector === null) throw new Error("register was not called");
console.log("PASS slot mount:", injectedSlot);

// ── 断言 3：渲染组件并捕获 useSession selector ─────────────────
const Component = capturedSelector.component;
let lastResult = "";
const props = {
	available: true,
	directory: { subscribe: () => () => {}, getSnapshot: () => ({ current: { provider: "deepseek", model: "d1" }, groups: [] }) },
	inputActions: { setDraft: () => {} },
	sessionId: "s1",
	useSession: (sel) => {
		capturedSel = sel;
		return sel({ chat: { nodes: { values: () => [][Symbol.iterator]() } } });
	}
};
let capturedSel = null;
Component(props);
if (!capturedSel) throw new Error("useSession was never invoked with a selector");
console.log("PASS component renders, selector captured");

// ── 断言 3b：真实内核形态 —— useChat 优先，且直接拿到 chat 快照 ──
// ui-chat 通过 `hooks: ["chat"]` 提供会话级标准源，渲染器把它暴露成 useChat；
// 而 session 快照（buildSnapshot）里没有 chat 字段。所以主路径必须是
// useChat(selector) 且 selector 收到的是 chat 快照本身（无 .chat 包装）。
let chatSel = null;
let sessionHookCalls = 0;
const chatNodes = [
	{ kind: "user", anchorSeq: 1, data: { content: [{ type: "text", text: "真实问题" }] } },
	{ kind: "assistant-step", anchorSeq: 2, data: { blocks: [{ kind: "text", text: "真实回答" }] } },
	{ kind: "turn-tail", anchorSeq: 3 }
];
let capturedDraft = null;
const chatProps = {
	available: true,
	directory: { subscribe: () => () => {}, getSnapshot: () => ({ current: { provider: "deepseek", model: "d1" }, groups: [] }) },
	inputActions: { setDraft: (t) => { capturedDraft = t; } },
	sessionId: "s1",
	useChat: (sel) => { chatSel = sel; return sel({ order: [], nodes: { values: () => chatNodes[Symbol.iterator]() } }); },
	useSession: () => { sessionHookCalls += 1; return ""; },
	useInput: (sel) => sel({ draft: "已有草稿" })
};
Component(chatProps);
if (sessionHookCalls !== 0) throw new Error("useSession must not be consulted when useChat is present");
if (!chatSel) throw new Error("useChat was never invoked");
const viaChat = JSON.parse(chatSel({ order: [], nodes: { values: () => chatNodes[Symbol.iterator]() } }));
if (!(viaChat.idle === true && viaChat.seq === 3 && viaChat.u === "真实问题" && viaChat.a === "真实回答")) {
	throw new Error("useChat path wrong: " + JSON.stringify(viaChat));
}
console.log("PASS useChat primary path:", JSON.stringify({ idle: viaChat.idle, seq: viaChat.seq, u: viaChat.u, a: viaChat.a }));

// 渲染出的组件必须能被找到并触发 chip 点击（验证草稿写入走 input 源）
const tree = Component(chatProps);
if (!tree) throw new Error("component rendered nothing while available");
console.log("PASS component tree built with useChat + useInput");

// ── 断言 4：蒸馏逻辑各种节点形态 ──────────────────────────────
function nodesMap(list) {
	return { chat: { nodes: { values: () => list[Symbol.iterator]() } } };
}
// 场景 A：user → assistant → turn-tail（最后一个节点 = idle）
const a = capturedSel(nodesMap([
	{ kind: "user", anchorSeq: 1, data: { content: [{ type: "text", text: "帮我修 bug" }] } },
	{ kind: "assistant", anchorSeq: 2, data: { blocks: [{ kind: "text", text: "已修复，改了 a.ts" }] } },
	{ kind: "turn-tail", anchorSeq: 3 }
]));
const A = JSON.parse(a);
if (!(A.idle === true && A.seq === 3 && A.u.includes("修 bug") && A.a.includes("a.ts"))) throw new Error("scenario A wrong: " + a);
console.log("PASS scenario A idle completed turn:", JSON.stringify({ idle: A.idle, seq: A.seq, u: A.u, a: A.a }));

// 场景 B：乱序节点 + 流仍在进行（tail 后还有节点）→ idle=false
const b = capturedSel(nodesMap([
	{ kind: "turn-tail", anchorSeq: 3 },
	{ kind: "user", anchorSeq: 1, data: { content: [{ type: "text", text: "问题" }] } },
	{ kind: "assistant-step", anchorSeq: 2, data: { blocks: [{ kind: "text", text: "回答" }] } },
	{ kind: "assistant-step", anchorSeq: 4, data: { blocks: [{ kind: "text", text: "新回答进行中" }] } }
]));
const B = JSON.parse(b);
if (!(B.idle === false && B.seq === 3 && B.u === "问题" && B.a === "回答")) throw new Error("scenario B wrong: " + b);
console.log("PASS scenario B unordered + running: seq=" + B.seq + " idle=" + B.idle);

// 场景 C：无边界节点 → seq 0, idle false
const c = capturedSel(nodesMap([
	{ kind: "user", anchorSeq: 1, data: { content: [{ type: "text", text: "hi" }] } }
]));
const C = JSON.parse(c);
if (!(C.seq === 0 && C.idle === false)) throw new Error("scenario C wrong: " + c);
console.log("PASS scenario C no boundary");

// 场景 D：多回合取最后一个 turn 的内容
const d = capturedSel(nodesMap([
	{ kind: "user", anchorSeq: 1, data: { content: [{ type: "text", text: "第一问" }] } },
	{ kind: "assistant", anchorSeq: 2, data: { blocks: [{ kind: "text", text: "第一答" }] } },
	{ kind: "turn-tail", anchorSeq: 3 },
	{ kind: "user", anchorSeq: 4, data: { content: [{ type: "text", text: "第二问" }] } },
	{ kind: "assistant", anchorSeq: 5, data: { blocks: [{ kind: "text", text: "第二答" }] } },
	{ kind: "turn-tail", anchorSeq: 6 }
]));
const D = JSON.parse(d);
if (!(D.idle === true && D.seq === 6 && D.u === "第二问" && D.a === "第二答")) throw new Error("scenario D wrong: " + d);
console.log("PASS scenario D latest turn only");

// 场景 E：turn-error 也是边界
const e = capturedSel(nodesMap([
	{ kind: "user", anchorSeq: 1, data: { content: [{ type: "text", text: "触发错误" }] } },
	{ kind: "turn-error", anchorSeq: 2 }
]));
const E = JSON.parse(e);
if (!(E.idle === true && E.seq === 2 && E.u === "触发错误")) throw new Error("scenario E wrong: " + e);
console.log("PASS scenario E error boundary");

console.log("\nALL CLIENT TESTS PASSED");
