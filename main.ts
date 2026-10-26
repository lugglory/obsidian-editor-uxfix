import { App, MarkdownView, Platform, Plugin, PluginSettingTab, Setting, editorInfoField } from "obsidian";
import { EditorState } from "@codemirror/state";
import { EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { foldable, foldEffect, foldedRanges, unfoldEffect } from "@codemirror/language";

const LONG_PRESS = 400; // 꾹 누르기 ms
const MOVE_SLOP = 4;    // 이만큼 넘게 움직이면 꾹 누르기가 아니다(드래그 선택)
const SCAN_UP = 2000;   // 부모를 찾아 위로 훑는 줄 수
const WHEEL_STEP = 100; // Alt+휠 한 단계로 치는 스크롤 양(px). 마우스 휠 한 칸이 보통 100, 터치패드는 잘게 나눠 온다

interface Settings {
	longPress: boolean;   // 꾹 누르기 = 그 줄 접기/펴기(자식이 없으면 부모 접기)
	clickToggle: boolean; // 캐럿 자리 클릭 = 그 줄 접기/펴기
	altWheel: boolean;      // Alt+휠 = 마우스 자리의 줄을 한 단계씩 펴기/접기
	rightWheel: boolean;    // 오른쪽 버튼을 누른 채 휠 = Alt+휠(윈도우즈)
	headerButtons: boolean; // 편집기 위쪽 줄의 한 단계 펴기/접기 버튼
	leftWheel: boolean;     // 글 왼쪽(여백, 들여쓰기, 목록 기호, 번호, 제목 #)에서 휠 = 그 자리 범위를 한 단계씩 펴기/접기
	leftClick: boolean;     // 글 왼쪽 클릭 = 그 자리 범위 접기/펴기
}

const DEFAULT_SETTINGS: Settings = { longPress: true, clickToggle: true, altWheel: true, rightWheel: true, headerButtons: true, leftWheel: true, leftClick: true };

// 편집기 확장들이 이벤트 때마다 읽는다: 설정을 바꾸면 바로 적용된다
const settings: Settings = { ...DEFAULT_SETTINGS };

// 열린 편집기마다 버튼을 다시 보이거나 감춘다(설정을 바꾸거나 읽기 모드로 바꿨을 때)
const refreshers = new Set<() => void>();
const refreshAll = () => refreshers.forEach(f => f());

type Range = { from: number; to: number };

// 그 줄 끝에서 시작하는 접힌 범위
function foldedOn(state: EditorState, lineFrom: number, lineTo: number): Range | null {
	let found: Range | null = null;
	foldedRanges(state).between(lineFrom, lineTo, (from, to) => {
		if (from >= lineFrom && from <= lineTo) { found = { from, to }; return false; }
	});
	return found;
}

// 화면에 보이는 줄. 접힌 범위 끝(… 오른쪽)은 문서상 숨은 마지막 줄이지만 화면에서는 접힌 줄이다
function visibleLine(state: EditorState, pos: number) {
	let from = pos;
	foldedRanges(state).between(pos, pos, (a, b) => { if (a < pos && pos <= b) { from = a; return false; } });
	return state.doc.lineAt(from);
}

// 그 줄을 접는 범위
function ownFold(state: EditorState, pos: number): Range | null {
	const line = visibleLine(state, pos);
	return foldable(state, line.from, line.to);
}

// 그 줄을 품은 가장 가까운 위 줄(부모 목록 항목, 제목)을 접는 범위
function parentFold(state: EditorState, pos: number): Range | null {
	const line = visibleLine(state, pos);
	for (let n = line.number - 1; n >= 1 && line.number - n <= SCAN_UP; n--) {
		const l = state.doc.line(n);
		const r = foldable(state, l.from, l.to);
		if (r && r.to >= line.to) return r;
	}
	return null;
}

// 그 범위 바로 아래(자식)의 접을 수 있는 범위들. null이면 문서 최상단
function childFolds(state: EditorState, parent: Range | null): Range[] {
	const out: Range[] = [];
	const end = parent ? parent.to : state.doc.length;
	for (let n = parent ? state.doc.lineAt(parent.from).number + 1 : 1; n <= state.doc.lines;) {
		const l = state.doc.line(n);
		if (l.from > end) break;
		const r = foldable(state, l.from, l.to);
		if (r) out.push(r);
		// 접히는 줄은 그 안(자식)을 건너뛴다: 훑는 줄은 모두 부모 바로 아래 줄이다
		n = r ? state.doc.lineAt(r.to).number + 1 : n + 1;
	}
	return out;
}

type Node = { range: Range; depth: number; folded: boolean };

// roots와 그 자손 중 화면에 보이는 접을 수 있는 줄들(roots = 깊이 0). 접힌 줄의 안은 보이지 않으니 넣지 않는다
function visibleTree(state: EditorState, roots: Range[]): Node[] {
	const out: Node[] = [];
	const walk = (ranges: Range[], depth: number) => {
		for (const r of ranges) {
			const folded = foldedOn(state, r.from, r.from);
			// 펼 때는 실제로 접혀 있는 범위 그대로 넘겨야 풀린다
			out.push({ range: folded || r, depth, folded: folded !== null });
			if (!folded) walk(childFolds(state, r), depth + 1);
		}
	};
	walk(roots, 0);
	return out;
}

// 꾹 누르기 = 그 줄 접기/펴기(자식이 없으면 부모 접기). 캐럿을 옮기지 않은 짧은 클릭 = 그 줄 접기/펴기.
// Alt+휠(윈도우즈는 오른쪽 버튼을 누른 채 휠도) = 마우스 자리의 줄(자식이 없으면 부모)과 그 안을 휠 한 칸마다 한 단계씩 펴기(위로)/접기(아래로). 마우스 자리의 줄은 제자리에 둔다.
// 편집기 위쪽 줄의 버튼 = 문서 전체를 한 단계/끝까지 펴기/접기. 누를 수 없는 버튼은 흐리게 한다
const pressFold = ViewPlugin.fromClass(class {
	timer: number | null = null;
	cleanup: (() => void) | null = null;
	release: (() => void) | null = null; // 꾹 누르기 뒤 holdUntilRelease가 건 것을 푼다
	win: Window = window; // 편집기가 있는 창(분리 창일 수 있다). 타이머도 이 창에 건다
	wheelAcc = 0;         // 아직 한 단계가 안 된 Alt+휠 양
	anchor: { pos: number; top: number } | null = null; // keepLine: 화면에 붙들어 둘 줄과 그 원래 높이
	unblockMenu: (() => void) | null = null; // blockMenu가 건 것을 푼다
	frame: number | null = null; // keepLine이 높이를 맞출 프레임
	buttons: { md: MarkdownView; open: HTMLElement; fold: HTMLElement; openAll: HTMLElement; foldAll: HTMLElement } | null = null;
	refreshTimer: number | null = null;

	constructor(readonly view: EditorView) {
		// 스크롤을 막아야 하니 passive가 아니게 직접 건다
		view.scrollDOM.addEventListener("wheel", this.onWheel, { passive: false });
		// 글 왼쪽 여백은 글 영역(contentDOM) 밖이라 스크롤 영역에서 받는다. CodeMirror가 캐럿을 옮기기 전에 봐야 하니 capture로
		view.scrollDOM.addEventListener("mousedown", this.onDown, true);
		refreshers.add(this.refresh);
		// 편집기가 막 만들어진 때라 그 노트 창이 아직 준비되지 않았을 수 있다
		window.setTimeout(this.refresh, 0);
	}

	// 노트 창(MarkdownView)의 본 편집기면 위쪽 줄에 버튼을 단다. 미리보기 팝업, 캔버스 안 편집기 등은 제외
	attach() {
		if (this.buttons) return;
		const md = this.view.state.field(editorInfoField, false);
		if (!(md instanceof MarkdownView) || (md.editor as unknown as { cm?: EditorView })?.cm !== this.view) return;
		const foldAll = md.addAction("chevrons-down-up", "끝까지 접기", () => this.foldAll());
		const fold = md.addAction("zoom-out", "한 단계 접기", () => this.step(childFolds(this.view.state, null), false));
		const open = md.addAction("zoom-in", "한 단계 펴기", () => this.step(childFolds(this.view.state, null), true));
		const openAll = md.addAction("chevrons-up-down", "끝까지 펴기", () => this.unfoldAll());
		this.buttons = { md, open, fold, openAll, foldAll };
	}

	// 아직 안 접힌 접을 수 있는 줄 모두(접힌 줄 안에 숨은 것도). 하나만 찾으면 되면 first
	unfoldedAll(first = false): Range[] {
		const { state } = this.view;
		const out: Range[] = [];
		for (let n = 1; n <= state.doc.lines; n++) {
			const l = state.doc.line(n);
			const r = foldable(state, l.from, l.to);
			if (r && !foldedOn(state, l.from, l.to)) { out.push(r); if (first) break; }
		}
		return out;
	}

	// 모든 단계를 접는다(펴면 안쪽도 접혀 있다)
	foldAll() {
		const ranges = this.unfoldedAll();
		if (ranges.length) this.foldRanges(ranges);
	}

	unfoldAll() {
		const ranges: Range[] = [];
		foldedRanges(this.view.state).between(0, this.view.state.doc.length, (from, to) => { ranges.push({ from, to }); });
		if (!ranges.length) return;
		// 캐럿이 … 오른쪽(접힌 범위 끝)이면 펴진 블록 맨 끝으로 가지 않게 접혔던 줄 끝에 둔다
		const sel = this.view.state.selection.main;
		const hit = sel.empty ? ranges.find(r => sel.head > r.from && sel.head <= r.to) : undefined;
		this.view.dispatch({ effects: ranges.map(r => unfoldEffect.of(r)), selection: hit ? { anchor: hit.from } : undefined });
	}

	// 누를 수 없는 버튼은 흐리게 한다(감추면 옆 버튼 자리가 바뀐다). 읽기 모드에서는 둘 다 감춘다
	refresh = () => {
		if (this.refreshTimer !== null) { window.clearTimeout(this.refreshTimer); this.refreshTimer = null; }
		this.attach();
		const b = this.buttons;
		if (!b) return;
		const show = settings.headerButtons && b.md.getMode() === "source";
		for (const el of [b.open, b.fold, b.openAll, b.foldAll]) el.toggle(show);
		if (!show) return;
		const { state } = this.view;
		const nodes = visibleTree(state, childFolds(state, null));
		const enable = (el: HTMLElement, on: boolean) => {
			el.toggleClass("is-disabled", !on);
			el.setAttr("aria-disabled", String(!on));
			el.style.opacity = on ? "" : "0.3";
			el.style.cursor = on ? "" : "default";
		};
		enable(b.open, nodes.some(n => n.folded));
		enable(b.fold, nodes.some(n => !n.folded));
		enable(b.openAll, foldedRanges(state).size > 0);
		// 보이는 줄이 다 접혀 있어도 그 안에 안 접힌 줄이 남아 있으면 누를 수 있다
		enable(b.foldAll, b.fold.getAttr("aria-disabled") === "false" || this.unfoldedAll(true).length > 0);
	};

	cancel() {
		if (this.timer !== null) { this.win.clearTimeout(this.timer); this.timer = null; }
		if (this.cleanup) { this.cleanup(); this.cleanup = null; }
	}

	update(u: ViewUpdate) {
		if (u.docChanged) {
			// 누르는 사이 문서가 바뀌면(동기화 등) 잰 자리가 틀리니 그만둔다
			this.cancel();
			// 글자를 칠 때마다 문서를 훑지 않게, 입력이 멈추면 버튼을 다시 본다
			if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
			this.refreshTimer = window.setTimeout(this.refresh, 300);
		} else if (foldedRanges(u.startState) !== foldedRanges(u.state)) this.refresh();
	}

	// 누르는 동안: 움직이거나, 스크롤하거나, 창을 벗어나면(Alt+Tab 등: 떼는 신호를 못 받을 수 있다)
	// 꾹 누르기로 치지 않는다. 그 전에 떼면 onUp
	track(win: Window, e: MouseEvent, onUp: () => void) {
		const x = e.clientX, y = e.clientY;
		const onMove = (m: MouseEvent) => { if (Math.abs(m.clientX - x) > MOVE_SLOP || Math.abs(m.clientY - y) > MOVE_SLOP) this.cancel(); };
		const up = () => { this.cancel(); onUp(); };
		const onBlur = () => this.cancel();
		win.addEventListener("mousemove", onMove, true);
		win.addEventListener("mouseup", up, true);
		win.addEventListener("blur", onBlur);
		this.view.scrollDOM.addEventListener("scroll", this.onScroll, { passive: true });
		this.cleanup = () => {
			win.removeEventListener("mousemove", onMove, true);
			win.removeEventListener("mouseup", up, true);
			win.removeEventListener("blur", onBlur);
			this.view.scrollDOM.removeEventListener("scroll", this.onScroll);
		};
	}

	onDown = (e: MouseEvent) => this.start(e); // 캐럿 놓기는 CodeMirror 기본 동작에 맡긴다

	start(e: MouseEvent) {
		this.cancel();
		if (e.button !== 0 || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
		const target = e.target as HTMLElement;
		// 접기 화살표, 체크박스 같은 위젯은 제 동작에 맡긴다
		if (target.closest(".cm-foldGutter, .collapse-indicator, .cm-fold-indicator, .cm-foldPlaceholder, input, button")) return;
		// 글 왼쪽 클릭 = 그 자리 범위 접기/펴기(꾹 누르기는 치지 않는다). 움직이면 보통 드래그 선택이다
		const local = settings.leftClick && e.detail === 1 ? this.leftRange(e.clientX, e.clientY) : null;
		if (local) {
			const win = this.win = this.view.dom.ownerDocument.defaultView || window;
			this.track(win, e, () => this.toggleRange(local.pos, local.range));
			return;
		}
		const pos = this.view.posAtCoords({ x: e.clientX, y: e.clientY });
		if (pos === null) return;
		// 편집기에 포커스가 있고 캐럿이 바로 그 자리: 캐럿이 옮겨지지 않는 클릭
		// (포커스가 없을 때의 클릭은 편집기로 돌아오는 클릭이라 치지 않는다)
		const sel = this.view.state.selection.main;
		const inPlace = settings.clickToggle && this.view.hasFocus && sel.empty && sel.head === pos && e.detail === 1;
		if (!settings.longPress && !inPlace) return;
		const win = this.win = this.view.dom.ownerDocument.defaultView || window;
		// 여기까지 오면 움직이지 않고 뗀 것이다(움직이거나 꾹 누르기가 되면 cancel이 이 리스너를 뗀다)
		this.track(win, e, () => { if (inPlace) this.toggle(pos, false); });
		if (!settings.longPress) return;
		this.timer = win.setTimeout(() => {
			this.timer = null;
			this.cancel();
			this.holdUntilRelease(win);
			this.toggle(pos, true);
		}, LONG_PRESS);
	}

	onScroll = () => this.cancel();

	// 꾹 누르기가 된 뒤 손을 뗄 때까지: 마우스 움직임을 CodeMirror의 드래그 선택에 보내지 않고(접히거나 펴져서
	// 자리가 바뀐 문서에 엉뚱한 범위가 잡힌다), 뗄 때의 클릭도 삼킨다(링크 위였으면 열리지 않게).
	// 떼는 신호를 놓쳤어도 새로 누르면 이전 누름은 끝난 것이니 바로 푼다(그 클릭은 삼키지 않는다)
	holdUntilRelease(win: Window) {
		const block = (ev: Event) => ev.stopPropagation();
		const stop = (ev: Event) => { ev.preventDefault(); ev.stopPropagation(); };
		const off = () => {
			win.removeEventListener("mousemove", block, true);
			win.removeEventListener("mouseup", up, true);
			win.removeEventListener("mousedown", off, true);
			win.removeEventListener("click", stop, true);
			this.release = null;
		};
		const up = () => {
			win.removeEventListener("mousemove", block, true);
			win.removeEventListener("mouseup", up, true);
			// click은 mouseup 바로 뒤에 온다
			win.setTimeout(off, 0);
		};
		win.addEventListener("mousemove", block, true);
		win.addEventListener("mouseup", up, true);
		win.addEventListener("mousedown", off, true);
		win.addEventListener("click", stop, true);
		this.release = off;
	}

	onWheel = (e: WheelEvent) => {
		if (e.ctrlKey || e.metaKey) return;
		// 오른쪽 버튼을 누른 채 굴리기 = Alt+휠. 윈도우즈만: 오른쪽 클릭 메뉴가 버튼을 뗄 때 떠서 그때 막을 수 있다
		// (맥, 리눅스는 누르는 순간 뜬다)
		const right = !e.altKey && (e.buttons & 2) !== 0 && Platform.isWin && settings.rightWheel;
		// 글 왼쪽에서는 키 없이도 그 자리 범위. Shift+휠(가로 스크롤)은 그대로 둔다
		const local = settings.leftWheel && (!e.shiftKey || e.altKey) ? this.leftRange(e.clientX, e.clientY) : null;
		if (!local && !(e.altKey ? settings.altWheel : right)) return;
		e.preventDefault();
		if (right) this.blockMenu();
		// Shift를 같이 누르면 브라우저가 가로 스크롤로 바꿔 deltaX로 보낸다
		const raw = e.deltaY !== 0 ? e.deltaY : e.deltaX;
		const delta = e.deltaMode === 1 ? raw * 40 : e.deltaMode === 2 ? raw * 800 : raw;
		// 방향이 바뀌면 쌓인 양을 버린다
		if (Math.sign(delta) !== Math.sign(this.wheelAcc)) this.wheelAcc = 0;
		this.wheelAcc += delta;
		if (Math.abs(this.wheelAcc) < WHEEL_STEP) return;
		const open = this.wheelAcc < 0; // 위로 = 펴기
		this.wheelAcc = 0;
		if (local) { this.keepLine(local.pos, () => this.step([local.range], open)); return; }
		// 마우스 자리의 줄(자식이 없으면 부모)과 그 안
		const pos = this.view.posAtCoords({ x: e.clientX, y: e.clientY });
		if (pos === null) return;
		this.keepLine(pos, () => {
			const { state } = this.view;
			const r = ownFold(state, pos) || parentFold(state, pos);
			if (r) this.step([r], open);
		});
	};

	// 마우스가 글 왼쪽(편집기 왼쪽 여백, 들여쓰기, 목록 기호, 번호, 체크박스, 제목 #)에 있으면 그 높이의 줄을 접는 범위
	// (자식이 없으면 부모)
	leftRange(x: number, y: number): { pos: number; range: Range } | null {
		const { view } = this;
		const { state } = view;
		// 여백에서는 글이 없으니 같은 높이의 글 쪽 자리로 줄을 찾는다
		const contentLeft = view.contentDOM.getBoundingClientRect().left;
		const pos = view.posAtCoords({ x: Math.max(x, contentLeft + 1), y });
		if (pos === null) return null;
		const line = visibleLine(state, pos);
		const lead = /^\s*((?:[-*+]|\d+[.)])\s+(?:\[.\]\s+)?|#{1,6}\s+)?/.exec(line.text)!;
		const text = view.coordsAtPos(line.from + lead[0].length);
		if (!text || x >= text.left) return null;
		const range = ownFold(state, line.from) || parentFold(state, line.from);
		return range ? { pos, range } : null;
	}

	// 오른쪽 버튼을 누른 채 휠을 굴렸으면 버튼을 뗄 때 뜨는 메뉴를 막는다.
	// 떼는 신호를 창 밖에서 놓쳤어도 새로 누르면 푼다
	blockMenu() {
		if (this.unblockMenu) return;
		const win = this.view.dom.ownerDocument.defaultView || window;
		const menu = (ev: Event) => { ev.preventDefault(); ev.stopPropagation(); off(); };
		const off = () => {
			win.removeEventListener("contextmenu", menu, true);
			win.removeEventListener("mousedown", off, true);
			this.unblockMenu = null;
		};
		win.addEventListener("contextmenu", menu, true);
		win.addEventListener("mousedown", off, true);
		this.unblockMenu = off;
	}

	// roots를 지금 상태에서 한 단계: 펴기는 보이는 접힌 줄 중 가장 얕은 깊이를 모두 펴고,
	// 접기는 보이는 펼친 줄 중 가장 깊은 깊이를 모두 접는다(마지막엔 roots가 접힌다). 바꿀 것이 없으면 false
	step(roots: Range[], open: boolean): boolean {
		const nodes = visibleTree(this.view.state, roots).filter(n => n.folded === open);
		if (!nodes.length) return false;
		const depth = nodes.reduce((d, n) => open ? Math.min(d, n.depth) : Math.max(d, n.depth), nodes[0].depth);
		const ranges = nodes.filter(n => n.depth === depth).map(n => n.range);
		if (open) this.view.dispatch({ effects: ranges.map(r => unfoldEffect.of(r)) });
		else this.foldRanges(ranges);
		return true;
	}

	// 접혀 있으면 편다. 아니면 그 줄을 접고, 자식이 없으면 parentIfLeaf일 때 부모를 접는다
	toggle(pos: number, parentIfLeaf: boolean) {
		if (pos > this.view.state.doc.length) return;
		this.keepLine(pos, () => {
			const { state } = this.view;
			const line = visibleLine(state, pos);
			const folded = foldedOn(state, line.from, line.to);
			if (folded) { this.unfold(folded); return; }
			const r = ownFold(state, pos) || (parentIfLeaf ? parentFold(state, pos) : null);
			if (r) this.foldRanges([r]);
		});
	}

	// 범위 r이 접혀 있으면 펴고 아니면 접는다
	toggleRange(pos: number, r: Range) {
		if (pos > this.view.state.doc.length) return;
		this.keepLine(pos, () => {
			const line = this.view.state.doc.lineAt(r.from);
			const folded = foldedOn(this.view.state, line.from, line.to);
			if (folded) this.unfold(folded);
			else this.foldRanges([r]);
		});
	}

	// change로 접고 편 뒤에도 pos의 줄이(접혀 숨으면 그 줄을 품은 접힌 줄이) 화면에서 같은 높이에 있게 스크롤한다.
	// 높이는 CodeMirror가 새 배치를 재고 제 스크롤 보정(화면 맨 위 줄을 제자리에 두기)까지 마친 뒤에 다시 재서 남은 만큼 맞춘다.
	// (requestMeasure로 맞추면 CodeMirror의 보정이 그 뒤에 한 번 더 더해진다.) 맞추기 전에 여러 번 오면(빠른 휠) 처음 높이에 맞춘다
	keepLine(pos: number, change: () => void) {
		const { view } = this;
		if (!this.anchor) {
			// pos가 … 오른쪽(숨은 본문 끝)이어도 보이는 줄 머리를 붙든다: 펴진 뒤 숨었던 본문 끝 줄을 따라가지 않게
			const from = visibleLine(view.state, pos).from;
			const c = view.coordsAtPos(from);
			if (c) this.anchor = { pos: from, top: c.top };
		}
		change();
		if (!this.anchor || this.frame !== null) return;
		// change가 건 CodeMirror의 재기보다 뒤에 걸리니, 같은 프레임에서 그다음에(그리기 전에) 돈다
		const win = view.dom.ownerDocument.defaultView || window;
		this.frame = win.requestAnimationFrame(() => {
			this.frame = null;
			const a = this.anchor;
			this.anchor = null;
			if (!a || a.pos > view.state.doc.length) return;
			const c = view.coordsAtPos(visibleLine(view.state, a.pos).from);
			if (c && c.top !== a.top) view.scrollDOM.scrollTop += c.top - a.top;
		});
	}

	// 캐럿이 접히는 안쪽에 남으면 CodeMirror가 다음 캐럿 이동 때 그 접기를 풀어 버린다: 접은 줄 끝으로 뺀다
	foldRanges(ranges: Range[]) {
		const head = this.view.state.selection.main.head;
		const hit = ranges.find(r => head > r.from && head <= r.to);
		this.view.dispatch({
			effects: ranges.map(r => foldEffect.of(r)),
			selection: hit ? { anchor: hit.from } : undefined,
		});
	}

	// 캐럿이 … 오른쪽(접힌 범위 끝)이면 펴진 블록 맨 끝으로 가지 않게 접혔던 줄 끝에 둔다
	unfold(r: Range) {
		const sel = this.view.state.selection.main;
		const atEnd = sel.empty && sel.head > r.from && sel.head <= r.to;
		this.view.dispatch({
			effects: unfoldEffect.of(r),
			selection: atEnd ? { anchor: r.from } : undefined,
		});
	}

	destroy() {
		this.cancel();
		if (this.release) this.release();
		if (this.unblockMenu) this.unblockMenu();
		if (this.frame !== null) (this.view.dom.ownerDocument.defaultView || window).cancelAnimationFrame(this.frame);
		if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
		refreshers.delete(this.refresh);
		if (this.buttons) for (const el of [this.buttons.open, this.buttons.fold, this.buttons.openAll, this.buttons.foldAll]) el.remove();
		this.view.scrollDOM.removeEventListener("wheel", this.onWheel);
		this.view.scrollDOM.removeEventListener("mousedown", this.onDown, true);
	}
});

export default class EditorUxfixPlugin extends Plugin {
	async onload() {
		// 없어진 설정 항목이 남아 있어도 읽지 않는다
		const saved = (await this.loadData()) || {};
		for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
			if (typeof saved[key] === "boolean") settings[key] = saved[key];
		}
		this.addSettingTab(new SettingTab(this.app, this));
		this.registerEditorExtension([pressFold]);
		// 읽기 모드로 바꾸면 버튼을 감춘다
		this.registerEvent(this.app.workspace.on("layout-change", refreshAll));
	}

	async saveSettings() { await this.saveData(settings); }
}

class SettingTab extends PluginSettingTab {
	constructor(app: App, readonly plugin: EditorUxfixPlugin) { super(app, plugin); }

	display() {
		const { containerEl } = this;
		containerEl.empty();
		const toggle = (key: keyof Settings, name: string, desc: string) =>
			new Setting(containerEl).setName(name).setDesc(desc).addToggle(t => t
				.setValue(settings[key])
				.onChange(async v => { settings[key] = v; refreshAll(); await this.plugin.saveSettings(); }));
		toggle("longPress", "꾹 누르기로 접기/펴기", "줄을 0.4초 누르면 그 줄을 접거나 편다. 자식이 없는 줄이면 그 줄을 품은 부모 항목이나 제목을 접는다.");
		toggle("clickToggle", "캐럿 자리 클릭으로 접기/펴기", "캐럿이 있는 바로 그 자리를 클릭하면 그 줄을 접거나 편다.");
		toggle("altWheel", "Alt+휠로 그 줄 단계별 접기/펴기", "Alt를 누른 채 휠을 굴리면 마우스가 가리키는 줄과 그 안을 한 칸마다 한 단계씩 편다(위로) 또는 접는다(아래로). 자식이 없는 줄이면 그 부모가 대상이다. 마우스가 가리키는 줄은 제자리에 남는다.");
		if (Platform.isWin) toggle("rightWheel", "오른쪽 버튼 누른 채 휠로 그 줄 단계별 접기/펴기", "오른쪽 버튼을 누른 채 휠을 굴리면 Alt+휠과 같다. 그때는 버튼을 떼도 오른쪽 클릭 메뉴가 뜨지 않는다. 윈도우즈만 지원한다.");
		toggle("headerButtons", "위쪽 줄에 펴기/접기 버튼", "편집기 위쪽(읽기 모드 전환 버튼이 있는 줄)에 문서 전체를 끝까지 펴기, 한 단계 펴기, 한 단계 접기, 끝까지 접기 버튼을 둔다. 누를 수 없는 버튼은 흐리게 한다.");
		toggle("leftWheel", "글 왼쪽에서 휠로 그 줄 단계별 접기/펴기", "글보다 왼쪽(왼쪽 여백, 들여쓰기, 목록 기호, 번호, 제목 #)에서 휠을 굴리면 키를 누르지 않아도 그 높이의 줄(자식이 없으면 부모)과 그 안을 한 칸마다 한 단계씩 편다(위로) 또는 접는다(아래로). 그 동안 그곳에서는 휠로 스크롤되지 않는다.");
		toggle("leftClick", "글 왼쪽 클릭으로 그 줄 접기/펴기", "글보다 왼쪽을 클릭하면 그 높이의 줄(자식이 없으면 부모)을 접거나 편다. 누른 채 움직이면 보통 드래그 선택이다.");
	}
}
