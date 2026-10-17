// dsh-next-step-suggest 浏览器端实现。
//
// 流程：
//   1. 在 "conversation.composer.dock" 插槽中注入组件，获取会话标准属性
//      （sessionId / useSession / inputActions / useChat 等）及模型目录。
//   2. useChat(selector) 提取最新一次已完成的回合：
//      { seq: 回合结束序号, idle: 是否已结束, u: 用户问题文本, a: 助手回答文本 }。
//   3. 当有新的已完成回合产生且开启了「自动生成」，向宿主 /api/dsh-next-step-suggest
//      发起请求（调用辅助模型生成建议），并在输入框上方以可点击的建议条展示。
//      点击建议条自动填入草稿输入框。
//   4. 工具栏图标支持手动点击生成/刷新建议；悬停弹层与面板头部均可切换自动生成开关。
window.__ModuleLoader__.load({
	id: "dsh-next-step-suggest",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const { useSyncExternalStore, useLayoutEffect, useRef, useState } = React;
		const { createPortal } = require("react-dom");

		// ------------------------------------------------------------------
		// 全面汉化与文案定义（默认且优先使用简体中文）
		// ------------------------------------------------------------------
		const LOCALE = "zh";
		const STR = {
			zh: {
				title: "下一步建议",
				button: "生成下一步建议",
				buttonTitle: "根据当前回答生成下一步建议",
				buttonDisabled: "回答生成中，暂不可用",
				auto: "回答结束后自动生成",
				autoShort: "自动生成",
				busy: "正在生成建议…",
				stop: "停止",
				error: "生成失败",
				retry: "重试",
				refresh: "重新生成",
				close: "关闭",
				empty: "当前会话还没有已完成的回答",
				noModel: "未选择模型，无法生成建议",
				fillDraft: "点击填入输入框",
				chipPrefix: "建议",
				requestError: "请求异常",
				networkError: "网络连接失败，请检查服务是否正常",
				aborted: "生成已中止",
				timeout: "生成超时，请重试"
			},
			en: {
				title: "下一步建议",
				button: "生成下一步建议",
				buttonTitle: "根据当前回答生成下一步建议",
				buttonDisabled: "回答生成中，暂不可用",
				auto: "回答结束后自动生成",
				autoShort: "自动生成",
				busy: "正在生成建议…",
				stop: "停止",
				error: "生成失败",
				retry: "重试",
				refresh: "重新生成",
				close: "关闭",
				empty: "当前会话还没有已完成的回答",
				noModel: "未选择模型，无法生成建议",
				fillDraft: "点击填入输入框",
				chipPrefix: "建议",
				requestError: "请求异常",
				networkError: "网络连接失败，请检查服务是否正常",
				aborted: "生成已中止",
				timeout: "生成超时，请重试"
			}
		};
		const t = (key) => (STR[LOCALE] && STR[LOCALE][key]) || STR.zh[key] || key;

		function formatErrorMessage(err) {
			if (!err) return "";
			const msg = typeof err === "string" ? err : (err.message || String(err));
			if (/failed to fetch|network\s*error|econnrefused/i.test(msg)) {
				return t("networkError");
			}
			if (/abort/i.test(msg)) {
				return t("aborted");
			}
			if (/timeout|timed\s*out/i.test(msg)) {
				return t("timeout");
			}
			return msg;
		}

		// ------------------------------------------------------------------
		// Diagnostics: report browser-half milestones to the host sink
		// (GET /api/dsh-next-step-suggest/diag reads them back). Never throws.
		// ------------------------------------------------------------------
		let diagSeq = 0;
		function report(event, extra) {
			try {
				diagSeq += 1;
				const payload = Object.assign({ ev: event, n: diagSeq }, extra || {});
				fetch("/api/dsh-next-step-suggest/diag", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(payload)
				}).catch(() => {});
			} catch { /* diagnostics never break the UI */ }
		}
		report("module-eval", { locale: LOCALE });
		if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
			window.addEventListener("error", (e) => report("window-error", { msg: String((e && e.message) || e) }));
		}

		// ------------------------------------------------------------------
		// Styles
		// ------------------------------------------------------------------
		const STYLE_ID = "dsh-next-step-suggest-styles";
		const SHEET = [
			".nss-root{position:relative;display:grid;place-items:center}",
			".nss-trigger{display:grid;place-items:center;width:28px;height:28px;padding:0;border:none;border-radius:14px;outline:none;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}",
			".nss-trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
			".nss-trigger:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-border-l3)}",
			".nss-trigger:disabled{opacity:.5;cursor:default}",
			".nss-spin{display:grid;place-items:center;animation:nss-rot 1s linear infinite}",
			"@keyframes nss-rot{to{transform:rotate(360deg)}}",
			".nss-dot{position:absolute;top:2px;right:2px;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-business-primary)}",
			".nss-pop{position:fixed;left:var(--nss-left,auto);top:var(--nss-top,auto);z-index:5000;width:max-content;max-width:min(360px,calc(100vw - 32px));padding:6px;border:1px solid var(--dsw-alias-border-inverted);border-radius:12px;background:var(--dsw-specific-menu);box-shadow:var(--dsw-shadow-lv3);color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px}",
			// The toggle is the whole row, not just the 40x22 track, so the hit
			// target matches what the user sees and reads.
			".nss-autoRow{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;min-height:36px;padding:6px 10px;border:none;border-radius:8px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}",
			".nss-autoRow:hover{background:var(--dsw-alias-interactive-bg-hover)}",
			".nss-autoRow:focus-visible{outline:2px solid var(--dsw-alias-border-l3);outline-offset:-2px}",
			".nss-autoRowCompact{width:auto;min-height:28px;padding:2px 8px;gap:6px}",
			".nss-autoLabel{white-space:nowrap}",
			".nss-switch{position:relative;display:block;flex:none;width:40px;height:22px;border-radius:11px;background:var(--dsw-alias-border-l2);transition:background .15s}",
			".nss-switch-on{background:var(--dsw-alias-state-business-primary)}",
			".nss-knob{position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:var(--dsw-alias-label-tertiary);transition:left .15s,background .15s;box-shadow:0 1px 2px rgba(0,0,0,.15)}",
			".nss-knob-on{left:20px;background:#fff}",
			".nss-panel{position:fixed;left:var(--nss-pl,auto);top:var(--nss-pt,auto);z-index:4900;display:flex;flex-direction:column;gap:8px;width:max-content;max-width:min(760px,calc(100vw - 48px));padding:12px 14px;border:1px solid var(--dsw-alias-border-inverted);border-radius:14px;background:var(--dsw-specific-menu);box-shadow:var(--dsw-shadow-lv3);color:var(--dsw-alias-label-primary)}",
			".nss-head{display:flex;align-items:center;gap:8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}",
			".nss-headTitle{font-weight:600;color:var(--dsw-alias-label-secondary);margin-right:auto}",
			".nss-headActions{display:flex;align-items:center;gap:4px}",
			".nss-mini{display:grid;place-items:center;width:22px;height:22px;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}",
			".nss-mini:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
			".nss-list{display:flex;flex-direction:column;gap:6px}",
			".nss-chip{display:flex;align-items:center;gap:8px;width:100%;text-align:left;padding:8px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:transparent;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;cursor:pointer;transition:border-color .12s,background .12s}",
			".nss-chip:hover{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-interactive-bg-hover)}",
			".nss-chip:focus-visible{outline:2px solid var(--dsw-alias-border-l3)}",
			".nss-chipIndex{flex:none;color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:600}",
			".nss-chipText{min-width:0;flex:1;overflow-wrap:anywhere}",
			".nss-status{display:flex;align-items:center;gap:6px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}",
			".nss-statusError{color:var(--dsw-alias-state-error-primary)}",
			".nss-retry{margin-left:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;height:22px;padding:0 8px;cursor:pointer}",
			".nss-retry:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}"
		].join("\n");

		function ensureStyles() {
			if (typeof document === "undefined") return;
			if (document.getElementById(STYLE_ID) !== null) return;
			const tag = document.createElement("style");
			tag.id = STYLE_ID;
			tag.dataset.plugin = "dsh-next-step-suggest";
			tag.dataset.pluginCss = "dsh-next-step-suggest/styles";
			tag.textContent = SHEET;
			document.head.appendChild(tag);
		}

		// ------------------------------------------------------------------
		// localStorage flags
		// ------------------------------------------------------------------
		const AUTO_KEY = "dsh-next-step-suggest:auto";
		function readAuto() {
			try {
				const raw = window.localStorage.getItem(AUTO_KEY);
				return raw === null ? true : raw !== "0";
			} catch {
				return true;
			}
		}
		function writeAuto(value) {
			try {
				window.localStorage.setItem(AUTO_KEY, value ? "1" : "0");
			} catch { /* best-effort */ }
		}

		// ------------------------------------------------------------------
		// Turn distillation selector
		// ------------------------------------------------------------------
		/** Fallback when no chat/session source is exposed: no hook, no data. */
		function noopSnapshotHook() {
			return "";
		}

		/** Selector for the session-scoped `input` source: just the draft string. */
		function draftOf(snapshot) {
			return snapshot && typeof snapshot.draft === "string" ? snapshot.draft : "";
		}

		// Kinds that close a turn (completed boundaries). Compaction rows sit
		// between turns and must never count as boundaries.
		const END_KINDS = new Set(["turn-tail", "turn-error", "turn-max-tokens"]);
		const USER_KINDS = new Set(["user", "steering", "turn-trigger"]);

		function nodeSeq(node) {
			if (typeof node.anchorSeq === "number") return node.anchorSeq;
			const data = node.data;
			if (data && typeof data.seq === "number") return data.seq;
			return null;
		}

		function contentText(content, cap) {
			const parts = [];
			if (Array.isArray(content)) {
				for (const block of content) {
					if (block && block.type === "text" && typeof block.text === "string") parts.push(block.text);
					else if (block && block.kind === "text" && typeof block.text === "string") parts.push(block.text);
				}
			}
			const joined = parts.join("\n\n").trim();
			return joined.length > cap ? joined.slice(0, cap) : joined;
		}

		function selector(snapshot) {
			try {
				// `useChat` hands us the chat snapshot itself, while a session
				// snapshot carries the same object one level down under `chat`.
				// Accept either shape so the distillation is hook-agnostic.
				const chat = snapshot && typeof snapshot.nodes === "object"
					? snapshot
					: snapshot && snapshot.chat;
				const nodes = chat && chat.nodes;
				if (!nodes || typeof nodes.values !== "function") return "";
				const arr = [];
				for (const node of nodes.values()) {
					if (!node || typeof node.kind !== "string") continue;
					const seq = nodeSeq(node);
					if (seq === null) continue;
					arr.push({ kind: node.kind, seq, data: node.data });
				}
				// Projection iteration order is not guaranteed chronological.
				arr.sort((a, b) => a.seq - b.seq);
				let endIdx = -1;
				for (let i = arr.length - 1; i >= 0; i -= 1) {
					if (END_KINDS.has(arr[i].kind)) {
						endIdx = i;
						break;
					}
				}
				if (endIdx === -1) return JSON.stringify({ seq: 0, idle: false, u: "", a: "" });
				const endNode = arr[endIdx];
				const idle = endIdx === arr.length - 1;
				let startIdx = endIdx - 1;
				while (startIdx >= 0 && !END_KINDS.has(arr[startIdx].kind)) startIdx -= 1;
				let u = "";
				let a = "";
				for (let i = startIdx + 1; i < endIdx; i += 1) {
					const node = arr[i];
					if (USER_KINDS.has(node.kind)) {
						const text = contentText(node.data && node.data.content, 2000);
						if (text !== "") u = u === "" ? text : `${u}\n\n${text}`;
					} else if (node.kind === "assistant" || node.kind === "assistant-step") {
						const blocks = node.data && (node.data.blocks || node.data.content);
						const text = contentText(blocks, 4000);
						if (text !== "") a = a === "" ? text : `${a}\n${text}`;
					}
				}
				if (a.length > 6000) a = `${a.slice(0, 2000)}\n…\n${a.slice(-4000)}`;
				return JSON.stringify({ seq: endNode.seq, idle, u, a });
			} catch {
				return "";
			}
		}

		// ------------------------------------------------------------------
		// Positioning helpers (fixed panels are immune to composer overflow
		// clipping — same lesson as the prompt-optimizer panel).
		// ------------------------------------------------------------------
		function composerTopRect() {
			const input = document.querySelector("[data-composer-input]");
			if (!input) return null;
			let card = input;
			for (let i = 0; i < 6 && card.parentElement; i += 1) {
				card = card.parentElement;
				const style = getComputedStyle(card);
				if (style.position !== "static") {
					const radius = parseFloat(style.borderRadius || "0");
					if (radius >= 6) break;
				}
			}
			const rect = card.getBoundingClientRect();
			return { top: rect.top, left: rect.left, right: rect.right };
		}

		function placePanel(panelEl, gap) {
			if (!panelEl) return;
			const anchorRect = composerTopRect();
			const pr = panelEl.getBoundingClientRect();
			const margin = 8;
			if (!anchorRect) {
				// Fallback: bottom-center dock area.
				panelEl.style.setProperty("--nss-pl", "50%");
				panelEl.style.setProperty("--nss-pt", `calc(100vh - ${String(Math.round(pr.height))}px - 120px)`);
				return;
			}
			let left = anchorRect.left;
			if (left + pr.width > window.innerWidth - margin) left = Math.max(margin, window.innerWidth - margin - pr.width);
			let top = anchorRect.top - pr.height - (gap || 10);
			if (top < margin) top = margin;
			panelEl.style.setProperty("--nss-pl", String(Math.round(left)) + "px");
			panelEl.style.setProperty("--nss-pt", String(Math.round(top)) + "px");
		}

		function placePopover(rootEl, popEl) {
			if (!rootEl || !popEl) return;
			const r = rootEl.getBoundingClientRect();
			const pr = popEl.getBoundingClientRect();
			const margin = 8;
			let left = r.right - pr.width;
			if (left < margin) left = margin;
			if (left + pr.width > window.innerWidth - margin) left = Math.max(margin, window.innerWidth - margin - pr.width);
			let top = r.top - pr.height - 8;
			if (top < margin) top = r.bottom + 8;
			popEl.style.setProperty("--nss-left", String(Math.round(left)) + "px");
			popEl.style.setProperty("--nss-top", String(Math.round(top)) + "px");
		}

		// ------------------------------------------------------------------
		// Icons
		// ------------------------------------------------------------------
		const ICON_SPARK = React.createElement(
			"svg",
			{ width: 16, height: 16, viewBox: "0 0 24 24", fill: "currentColor", "aria-hidden": "true" },
			React.createElement("path", { d: "M12 2l2.2 5.9 5.8 2.1-5.8 2.2L12 18l-2.2-5.8L4 10l5.8-2.1L12 2zm7 12l1.1 2.9 2.9 1.1-2.9 1.1L19 22l-1.1-2.9-2.9-1.1 2.9-1.1L19 14z" })
		);
		const ICON_SPIN = React.createElement(
			"svg",
			{ width: 16, height: 16, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" },
			React.createElement("circle", { cx: 8, cy: 8, r: 6, stroke: "currentColor", strokeWidth: 2, strokeDasharray: "26 12", strokeLinecap: "round" })
		);
		const ICON_REFRESH = React.createElement(
			"svg",
			{ width: 14, height: 14, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true" },
			React.createElement("path", { d: "M13.5 8a5.5 5.5 0 1 1-1.6-3.9" }),
			React.createElement("path", { d: "M13.5 1.5v3h-3" })
		);
		const ICON_CLOSE = React.createElement(
			"svg",
			{ width: 14, height: 14, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", "aria-hidden": "true" },
			React.createElement("path", { d: "M4 4l8 8M12 4l-8 8" })
		);

		// ------------------------------------------------------------------
		// Main dock component
		// ------------------------------------------------------------------
		const EMPTY_SNAPSHOT = { current: null, groups: [] };
		let dockMountedReported = false;
		let hookShapeReported = false;

		function SuggestDock(props) {
			const { available, directory, inputActions, sessionId, useSession, useChat, useInput } = props;
			ensureStyles();
			if (!dockMountedReported) {
				dockMountedReported = true;
				report("dock-mounted", { sid: String(sessionId), available: String(available) });
			}

			const subscribe = (fn) => {
				if (!directory || typeof directory.subscribe !== "function") return () => {};
				return directory.subscribe(fn);
			};
			const getSnapshot = () => {
				if (!directory || typeof directory.getSnapshot !== "function") return EMPTY_SNAPSHOT;
				return directory.getSnapshot();
			};
			const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

			// Chat content lives on its own session-scoped standard source: the
			// runtime exposes every `hooks` contribution as a `use<Name>` prop, so
			// `hooks: ["chat"]` (ui-chat) surfaces here as `useChat`. The session
			// snapshot itself carries no chat data, so reading the transcript
			// through useSession silently yields nothing. Prefer useChat and keep
			// the session hook only as a compatibility fallback. Exactly one hook
			// is invoked per render — the chosen prop is stable across renders.
			const chatHook = typeof useChat === "function"
				? useChat
				: typeof useSession === "function"
					? useSession
					: noopSnapshotHook;
			if (!hookShapeReported) {
				hookShapeReported = true;
				report("hook-shape", {
					useChat: typeof useChat,
					useSession: typeof useSession,
					useInput: typeof useInput,
					source: chatHook === useChat ? "chat" : chatHook === useSession ? "session" : "none"
				});
			}
			let turnJson = "";
			try {
				turnJson = chatHook(selector) || "";
			} catch {
				turnJson = "";
			}

			// The composer draft arrives through the session-scoped `input` source
			// (`conversation.input` -> `useInput`), not as a prop: the dock owner
			// never hands an `input` object to its occupants. Selecting just the
			// draft string keeps this subscription cheap and identity-stable.
			const inputHook = typeof useInput === "function" ? useInput : noopSnapshotHook;
			let draft = "";
			try {
				const value = inputHook(draftOf);
				if (typeof value === "string") draft = value;
			} catch {
				draft = "";
			}

			const [phase, setPhase] = useState("idle"); // idle | busy | ready | error
			const [suggestions, setSuggestions] = useState([]);
			const [errorText, setErrorText] = useState("");
			const [panelOpen, setPanelOpen] = useState(false);
			const [auto, setAuto] = useState(readAuto);
			const [hoverPop, setHoverPop] = useState(false);

			const rootRef = useRef(null);
			const panelRef = useRef(null);
			const popRef = useRef(null);
			const popTimerRef = useRef(null);
			const abortRef = useRef(null);
			const lastSeqRef = useRef(0);
			const turnRef = useRef({ seq: 0, idle: false, u: "", a: "" });

			if (turnJson !== "") {
				try {
					turnRef.current = JSON.parse(turnJson);
				} catch { /* keep previous */ }
			}

			// Hover popover open/close. The popover is portaled to document.body,
			// so it is NOT a DOM descendant of the trigger: pointer travel from
			// the icon to the panel crosses a gap that fires the root's
			// mouseleave. Closing on a short delay instead of immediately lets
			// that travel finish, and the popover's own enter cancels the timer.
			const HOVER_CLOSE_DELAY = 220;
			function cancelPopClose() {
				if (popTimerRef.current !== null) {
					window.clearTimeout(popTimerRef.current);
					popTimerRef.current = null;
				}
			}
			function openPop() {
				cancelPopClose();
				setHoverPop(true);
			}
			function closePopSoon() {
				cancelPopClose();
				popTimerRef.current = window.setTimeout(() => {
					popTimerRef.current = null;
					setHoverPop(false);
				}, HOVER_CLOSE_DELAY);
			}

			// Unmount cleanup: abort any in-flight call, drop a pending pop timer.
			useLayoutEffect(() => () => {
				cancelPopClose();
				if (abortRef.current) {
					abortRef.current.abort();
					abortRef.current = null;
				}
			}, []);

			function stop() {
				if (abortRef.current) {
					abortRef.current.abort();
					abortRef.current = null;
				}
				fetch("/api/dsh-next-step-suggest/stop", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ sessionId })
				}).catch(() => {});
			}

			function generate() {
				if (phase === "busy") {
					stop();
					setPhase("idle");
					return;
				}
				const current = state && state.current;
				if (!current || typeof current.provider !== "string" || typeof current.model !== "string") {
					setErrorText(t("noModel"));
					setPhase("error");
					setPanelOpen(true);
					return;
				}
				const snapTurn = turnRef.current;
				if (snapTurn.u === "" && snapTurn.a === "") {
					setErrorText(t("empty"));
					setPhase("error");
					setPanelOpen(true);
					return;
				}
				lastSeqRef.current = snapTurn.seq;
				setPhase("busy");
				setErrorText("");
				setPanelOpen(true);
				const controller = new AbortController();
				abortRef.current = controller;
				fetch("/api/dsh-next-step-suggest", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						provider: current.provider,
						model: current.model,
						question: snapTurn.u,
						answer: snapTurn.a,
						sessionId,
						count: 3,
						lang: LOCALE
					}),
					signal: controller.signal
				}).then((response) => {
					if (!response.ok) {
						return response.json().catch(() => ({})).then((payload) => {
							throw new Error(String((payload && payload.error) || `请求异常 (HTTP ${String(response.status)})`));
						});
					}
					return response.json();
				}).then((payload) => {
					if (abortRef.current === controller) abortRef.current = null;
					if (payload && payload.ok === true && Array.isArray(payload.suggestions) && payload.suggestions.length > 0) {
						setSuggestions(payload.suggestions);
						setPhase("ready");
					} else {
						setErrorText(formatErrorMessage((payload && payload.error) || t("error")));
						setPhase("error");
					}
				}).catch((error) => {
					if (abortRef.current === controller) abortRef.current = null;
					if (error && (error.name === "AbortError" || controller.signal.aborted)) setPhase("idle");
					else {
						setErrorText(formatErrorMessage(error));
						setPhase("error");
					}
				});
			}

			const generateRef = useRef(generate);
			generateRef.current = generate;

			// Session transition: a dock occurrence can be reused across session
			// switches. Reset all per-session state and baseline the current
			// turn so switching never fires an auto-generation or leaks a panel.
			const prevSessionIdRef = useRef(sessionId);
			const prevTurnJsonRef = useRef("");
			useLayoutEffect(() => {
				if (sessionId === prevSessionIdRef.current) return;
				prevSessionIdRef.current = sessionId;
				if (abortRef.current) {
					abortRef.current.abort();
					abortRef.current = null;
				}
				lastSeqRef.current = turnRef.current.idle ? turnRef.current.seq : 0;
				prevTurnJsonRef.current = turnJson;
				setPanelOpen(false);
				setSuggestions([]);
				setPhase("idle");
				setErrorText("");
				// eslint-disable-next-line react-hooks/exhaustive-deps
			}, [sessionId]);

			// Turn transition: a running turn invalidates stale panels; a NEW
			// completed turn auto-generates when the toggle is on.
			const autoRef = useRef(auto);
			autoRef.current = auto;
			useLayoutEffect(() => {
				if (turnJson === "" || turnJson === prevTurnJsonRef.current) return;
				const changed = prevTurnJsonRef.current !== "";
				prevTurnJsonRef.current = turnJson;
				if (!changed) {
					// First distillation after mount: settle baseline without
					// generating (avoid spamming on every session switch).
					const snapTurn = turnRef.current;
					if (snapTurn.idle) lastSeqRef.current = snapTurn.seq;
					return;
				}
				const snapTurn = turnRef.current;
				if (!snapTurn.idle) {
					stop();
					setPanelOpen(false);
					setSuggestions([]);
					setPhase("idle");
					lastSeqRef.current = 0;
					return;
				}
				if (snapTurn.seq === lastSeqRef.current) return;
				if (!autoRef.current) return;
				if (snapTurn.u === "" && snapTurn.a === "") return;
				generateRef.current();
				// eslint-disable-next-line react-hooks/exhaustive-deps
			}, [turnJson]);

			// Floating layers: position before paint, keep in sync with state.
			useLayoutEffect(() => {
				if (!panelOpen) return;
				placePanel(panelRef.current, 10);
				// Chips wrap text asynchronously; re-place once after fonts/layout settle.
				const raf = requestAnimationFrame(() => placePanel(panelRef.current, 10));
				return () => cancelAnimationFrame(raf);
			}, [panelOpen, phase, suggestions, errorText]);

			useLayoutEffect(() => {
				if (!hoverPop) return;
				placePopover(rootRef.current, popRef.current);
			}, [hoverPop]);

			useLayoutEffect(() => {
				const onResize = () => {
					if (panelOpen) placePanel(panelRef.current, 10);
					if (hoverPop) placePopover(rootRef.current, popRef.current);
				};
				window.addEventListener("resize", onResize, { passive: true });
				return () => window.removeEventListener("resize", onResize);
			}, [panelOpen, hoverPop]);

			function fillDraft(text) {
				try {
					// inputActions is the only public write path. The current draft
					// comes from the session-scoped `input` source read above; an
					// existing draft keeps its content and gains the suggestion on a
					// new line, an empty one is replaced outright.
					const current = draft;
					const next = current.trim() === "" ? text : `${current.replace(/\s+$/, "")}\n${text}`;
					inputActions.setDraft(next);
					setPanelOpen(false);
					setSuggestions([]);
					setPhase("idle");
				} catch { /* best-effort */ }
			}

			// One toggle row, shared by the hover popover and the panel head so
			// the setting is reachable without hovering at all. The whole row is
			// the control: the bare 40x22 track was a tiny target and the label
			// next to it was not clickable.
			function autoRow(compact) {
				return React.createElement(
					"button",
					{
						type: "button",
						role: "switch",
						"aria-checked": auto,
						"aria-label": t("auto"),
						className: `nss-autoRow${compact ? " nss-autoRowCompact" : ""}`,
						title: t("auto"),
						onClick: () => {
							setAuto((prev) => {
								const next = !prev;
								writeAuto(next);
								return next;
							});
						}
					},
					React.createElement("span", { className: "nss-autoLabel" }, compact ? t("autoShort") : t("auto")),
					React.createElement(
						"span",
						{ className: `nss-switch${auto ? " nss-switch-on" : ""}`, "aria-hidden": "true" },
						React.createElement("span", { className: `nss-knob${auto ? " nss-knob-on" : ""}` })
					)
				);
			}

			if (available === false) return null;

			const busy = phase === "busy";
			const turn = turnRef.current;

			return React.createElement(
				"div",
				{
					className: "nss-root",
					ref: rootRef,
					onMouseEnter: openPop,
					onMouseLeave: closePopSoon
				},
				React.createElement(
					"button",
					{
						type: "button",
						className: "nss-trigger",
						"aria-label": t("button"),
						title: busy ? t("busy") : (!turn.idle ? t("buttonDisabled") : t("buttonTitle")),
						disabled: !turn.idle && !busy,
						onClick: () => generateRef.current()
					},
					busy ? React.createElement("span", { className: "nss-spin" }, ICON_SPIN) : ICON_SPARK,
					phase === "ready" && !panelOpen ? React.createElement("span", { className: "nss-dot" }) : null
				),
				hoverPop
					? createPortal(
						React.createElement(
							"div",
							{
								className: "nss-pop",
								ref: popRef,
								onMouseEnter: openPop,
								onMouseLeave: closePopSoon
							},
							autoRow(false)
						),
						document.body
					)
					: null,
				panelOpen
					? createPortal(
						React.createElement(
							"div",
							{ className: "nss-panel", ref: panelRef, role: "group", "aria-label": t("title") },
							React.createElement(
								"div",
								{ className: "nss-head" },
								React.createElement("span", { className: "nss-headTitle" }, t("title")),
								autoRow(true),
								React.createElement(
									"div",
									{ className: "nss-headActions" },
									React.createElement("button", {
										type: "button",
										className: "nss-mini",
										title: t("refresh"),
										"aria-label": t("refresh"),
										onClick: () => {
											lastSeqRef.current = 0;
											generateRef.current();
										}
									}, ICON_REFRESH),
									React.createElement("button", {
										type: "button",
										className: "nss-mini",
										title: t("close"),
										"aria-label": t("close"),
										onClick: () => setPanelOpen(false)
									}, ICON_CLOSE)
								)
							),
							busy
								? React.createElement(
									"div",
									{ className: "nss-status" },
									React.createElement("span", { className: "nss-spin" }, ICON_SPIN),
									React.createElement("span", null, t("busy")),
									React.createElement("button", { type: "button", className: "nss-retry", onClick: stop }, t("stop"))
								)
								: null,
							!busy && phase === "error"
								? React.createElement(
									"div",
									{ className: "nss-status nss-statusError" },
									React.createElement("span", null, `${t("error")}${errorText ? `：${errorText}` : ""}`),
									React.createElement("button", { type: "button", className: "nss-retry", onClick: () => generateRef.current() }, t("retry"))
								)
								: null,
							!busy && phase === "ready"
								? React.createElement(
									"div",
									{ className: "nss-list" },
									suggestions.map((text, index) => React.createElement(
										"button",
										{
											key: `${String(index)}-${String(text).slice(0, 24)}`,
											type: "button",
											className: "nss-chip",
											title: t("fillDraft"),
											"aria-label": `${t("chipPrefix")} ${String(index + 1)}：${String(text)}`,
											onClick: () => fillDraft(String(text))
										},
										React.createElement("span", { className: "nss-chipIndex" }, String(index + 1)),
										React.createElement("span", { className: "nss-chipText" }, String(text))
									))
								)
								: null
						),
						document.body
					)
					: null
			);
		}

		// ------------------------------------------------------------------
		// Entry
		// ------------------------------------------------------------------
		const name = "dsh-next-step-suggest-client";
		const inject = ["slots", "modelDirectories", "sessions"];

		function apply(ctx) {
			report("apply-enter");
			ctx.inject(inject, (scope) => {
				report("scope-ready", {
					slots: typeof scope.slots,
					modelDirectories: typeof scope.modelDirectories,
					sessions: typeof scope.sessions
				});
				const models = scope.modelDirectories;
				const sessions = scope.sessions;
				try {
					scope.slots.inject("conversation.composer.dock", () => scope.slots.register({
						name: "conversation.composer.dock",
						id: "next-step-suggest",
						order: 80,
						inject: (sessionId) => {
							try {
								const out = {
									available: sessions.subagentAddress(sessionId) === void 0,
									directory: models.directoryFor(sessionId).store,
									sessionId
								};
								return out;
							} catch (error) {
								report("inject-throw", { sid: String(sessionId), msg: String((error && error.message) || error) });
								return { available: false, directory: null, sessionId };
							}
						}
					}, SuggestDock));
					report("slot-registered");
				} catch (error) {
					report("register-throw", { msg: String((error && error.message) || error) });
				}
			});
		}

		exports.name = name;
		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});
