import { App, Platform, Plugin, PluginSettingTab, Setting } from "obsidian";
import { Annotation, EditorState, Transaction } from "@codemirror/state";
import { EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { foldable, foldEffect, foldedRanges, unfoldEffect } from "@codemirror/language";

const LONG_PRESS = 500; // 꾹 누르기 ms
const MOVE_SLOP = 4;    // 이만큼 넘게 움직이면 꾹 누르기가 아니다(드래그 선택)
const SCAN_UP = 2000;   // 부모를 찾아 위로 훑는 줄 수

interface Settings {
	longPress: boolean;     // 꾹 누르기 = 부모 접기
	clickToggle: boolean;   // 캐럿 자리 클릭 = 그 줄 접기/펴기
	unfoldOnEnter: boolean; // 캐럿이 접힌 줄로 들어가면 펴기
	siblingFold: boolean;   // 오른쪽 꾹 누르기 = 그 줄과 형제 접기(Windows)
}

const DEFAULT_SETTINGS: Settings = { longPress: true, clickToggle: true, unfoldOnEnter: true, siblingFold: true };

// 편집기 확장들이 이벤트 때마다 읽는다: 설정을 바꾸면 바로 적용된다
const settings: Settings = { ...DEFAULT_SETTINGS };

// 우리가 낸 접기 트랜잭션: 캐럿이 옮겨져도 "접힌 줄로 들어가면 편다"에 걸리지 않게
const ours = Annotation.define<boolean>();

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

// 목록 항목이면 들여쓰기, 제목이면 수준: 형제를 가르는 기준
function lineKind(text: string): string | null {
	const h = /^(#{1,6})\s/.exec(text);
	if (h) return "h" + h[1].length;
	const li = /^(\s*)([-*+]|\d+[.)])\s/.exec(text);
	return li ? "li" + li[1] : null;
}

// 그 줄과 형제(같은 부모 아래 같은 수준의 목록 항목이나 제목) 중 접을 수 있는 범위들. 부모가 없으면 문서 전체에서
function siblingFolds(state: EditorState, pos: number): Range[] {
	const kind = lineKind(visibleLine(state, pos).text);
	if (!kind) return [];
	const parent = parentFold(state, pos);
	const end = parent ? parent.to : state.doc.length;
	const out: Range[] = [];
	for (let n = parent ? state.doc.lineAt(parent.from).number + 1 : 1; n <= state.doc.lines;) {
		const l = state.doc.line(n);
		if (l.from > end) break;
		const r = foldable(state, l.from, l.to);
		if (r && lineKind(l.text) === kind) out.push(r);
		// 접히는 줄은 그 안(자식)을 건너뛴다: 훑는 줄은 모두 부모 바로 아래 줄이다
		n = r ? state.doc.lineAt(r.to).number + 1 : n + 1;
	}
	return out;
}

// 꾹 누르기 = 부모 접기(최상단이면 그 줄). 오른쪽 꾹 누르기(Windows) = 그 줄과 형제 접기.
// 캐럿을 옮기지 않은 짧은 클릭 = 그 줄 접기.
// 접힌 줄을 짧게 클릭하면 편다(캐럿이 들어가며 unfoldOnEnter가 이미 폈으면 그대로).
const pressFold = ViewPlugin.fromClass(class {
	timer: number | null = null;
	cleanup: (() => void) | null = null;
	release: (() => void) | null = null; // 꾹 누르기 뒤 holdUntilRelease가 건 것을 푼다
	win: Window = window; // 편집기가 있는 창(분리 창일 수 있다). 타이머도 이 창에 건다

	constructor(readonly view: EditorView) {}

	cancel() {
		if (this.timer !== null) { this.win.clearTimeout(this.timer); this.timer = null; }
		if (this.cleanup) { this.cleanup(); this.cleanup = null; }
	}

	// 누르는 사이 문서가 바뀌면(동기화 등) 잰 자리가 틀리니 그만둔다
	update(u: ViewUpdate) { if (u.docChanged) this.cancel(); }

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

	start(e: MouseEvent) {
		this.cancel();
		if (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
		const target = e.target as HTMLElement;
		// 접기 화살표, 체크박스 같은 위젯은 제 동작에 맡긴다
		if (target.closest(".cm-foldGutter, .collapse-indicator, .cm-fold-indicator, .cm-foldPlaceholder, input, button")) return;
		if (e.button === 2) { if (Platform.isWin && settings.siblingFold) this.startRight(e); return; }
		if (e.button !== 0) return;
		const pos = this.view.posAtCoords({ x: e.clientX, y: e.clientY });
		if (pos === null) return;
		const { state } = this.view;
		const line = visibleLine(state, pos);
		const folded = foldedOn(state, line.from, line.to);
		const wasFolded = folded !== null;
		// … 오른쪽을 누르면 캐럿이 접힌 범위 끝에 놓인다. 누를 때 펴면 CodeMirror가 뗄 때 바뀐 자리로
		// 선택을 다시 잡아 블록 전체가 선택되니, unfoldOnEnter 대신 여기서 뗀 뒤에 편다
		const atFoldEnd = settings.unfoldOnEnter && folded !== null && pos > folded.from;
		// 편집기에 포커스가 있고 캐럿이 바로 그 자리: 캐럿이 옮겨지지 않는 클릭
		// (포커스가 없을 때의 클릭은 편집기로 돌아오는 클릭이라 치지 않는다)
		const sel = state.selection.main;
		const inPlace = settings.clickToggle && this.view.hasFocus && sel.empty && sel.head === pos && e.detail === 1;
		if (!settings.longPress && !inPlace && !atFoldEnd) return;
		const win = this.win = this.view.dom.ownerDocument.defaultView || window;
		// 여기까지 오면 움직이지 않고 뗀 것이다(움직이거나 꾹 누르기가 되면 cancel이 이 리스너를 뗀다)
		this.track(win, e, () => {
			// 캐럿이 그대로면 CodeMirror가 선택을 내지 않아 unfoldOnEnter도 돌지 않는다: 여기서 접거나 편다.
			// CodeMirror가 뗄 때 선택을 다시 잡은 뒤에 한다(그 전에 자리가 바뀌면 엉뚱한 범위가 잡힌다)
			if (inPlace || atFoldEnd) win.setTimeout(() => { if (wasFolded) this.unfold(pos); else this.fold(pos, false); }, 0);
		});
		if (!settings.longPress) return;
		this.timer = win.setTimeout(() => {
			this.timer = null;
			this.cancel();
			this.holdUntilRelease(win);
			// 부모가 있으면 접힌 줄이어도 부모를 접는다. 최상단의 접힌 줄은 편다
			// (보통은 누르는 순간 캐럿이 들어가며 이미 펴졌다: 다시 접으면 누른 보람이 없다)
			if (wasFolded && pos <= this.view.state.doc.length && !parentFold(this.view.state, pos)) this.unfold(pos);
			else this.fold(pos, true);
		}, LONG_PRESS);
	}

	// 오른쪽 꾹 누르기 = 그 줄과 형제 접기. Windows만: 오른쪽 클릭 메뉴가 뗄 때 떠서 그 전에 잴 수 있다
	// (macOS, Linux는 누르는 순간 뜬다). 짧게 누르면 보통 메뉴
	startRight(e: MouseEvent) {
		const pos = this.view.posAtCoords({ x: e.clientX, y: e.clientY });
		if (pos === null) return;
		const win = this.win = this.view.dom.ownerDocument.defaultView || window;
		this.track(win, e, () => {});
		this.timer = win.setTimeout(() => {
			this.timer = null;
			this.cancel();
			this.swallowMenu(win);
			this.foldSiblings(pos);
		}, LONG_PRESS);
	}

	onScroll = () => this.cancel();

	// 오른쪽 꾹 누르기가 된 뒤 뗄 때 뜨는 메뉴를 삼킨다. 메뉴 신호를 놓쳤어도 새로 누르면 푼다
	swallowMenu(win: Window) {
		const stop = (ev: Event) => { ev.preventDefault(); ev.stopPropagation(); off(); };
		const off = () => {
			win.removeEventListener("contextmenu", stop, true);
			win.removeEventListener("mousedown", off, true);
			this.release = null;
		};
		win.addEventListener("contextmenu", stop, true);
		win.addEventListener("mousedown", off, true);
		this.release = off;
	}

	// 꾹 누르기가 된 뒤 손을 뗄 때까지: 마우스 움직임을 CodeMirror의 드래그 선택에 보내지 않고(접혀서 자리가
	// 바뀐 문서에 엉뚱한 범위가 잡힌다), 뗄 때의 클릭도 삼킨다(링크 위였으면 열리지 않게).
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

	// parent면 부모를, 부모가 없으면(최상단) 그 줄을 접는다
	fold(pos: number, parent: boolean) {
		const { state } = this.view;
		if (pos > state.doc.length) return;
		const r = (parent && parentFold(state, pos)) || ownFold(state, pos);
		if (!r) return;
		// 캐럿이 접히는 안쪽에 있으면 접은 줄 끝으로
		const head = state.selection.main.head;
		const inside = head > r.from && head <= r.to;
		this.view.dispatch({
			effects: foldEffect.of(r),
			selection: inside ? { anchor: r.from } : undefined,
			annotations: ours.of(true),
		});
	}

	// 그 줄과 형제 중 아직 안 접힌 것을 모두 접는다
	foldSiblings(pos: number) {
		const { state } = this.view;
		if (pos > state.doc.length) return;
		const ranges = siblingFolds(state, pos).filter(r => !foldedOn(state, r.from, r.from));
		if (!ranges.length) return;
		// 캐럿이 접히는 안쪽에 있으면 그 줄 끝으로
		const head = state.selection.main.head;
		const hit = ranges.find(r => head > r.from && head <= r.to);
		this.view.dispatch({
			effects: ranges.map(r => foldEffect.of(r)),
			selection: hit ? { anchor: hit.from } : undefined,
			annotations: ours.of(true),
		});
	}

	// 아직 접혀 있으면 편다(누르는 순간 캐럿이 들어가며 이미 펴졌으면 아무것도 안 한다).
	// 캐럿이 … 오른쪽(접힌 범위 끝)이면 펴진 블록 맨 끝으로 가지 않게 접혔던 줄 끝에 둔다
	unfold(pos: number) {
		const { state } = this.view;
		if (pos > state.doc.length) return;
		const line = visibleLine(state, pos);
		const r = foldedOn(state, line.from, line.to);
		if (!r) return;
		const head = state.selection.main.head;
		const atEnd = state.selection.main.empty && head > r.from && head <= r.to;
		this.view.dispatch({
			effects: unfoldEffect.of(r),
			selection: atEnd ? { anchor: r.from } : undefined,
			annotations: ours.of(true),
		});
	}

	destroy() {
		this.cancel();
		if (this.release) this.release();
	}
}, {
	eventHandlers: {
		mousedown(e) { this.start(e); return false; }, // 캐럿 놓기는 CodeMirror 기본 동작에 맡긴다
	},
});

// 캐럿이 접힌 줄이나 그 자식으로 들어가면 편다. 범위 선택 중이거나 문서가 바뀐 트랜잭션은 건드리지 않는다
const unfoldOnEnter = EditorState.transactionExtender.of((tr: Transaction) => {
	if (!settings.unfoldOnEnter) return null;
	if (!tr.selection || tr.docChanged || tr.annotation(ours)) return null;
	const sel = tr.selection.main;
	if (!sel.empty) return null;
	const before = tr.startState;
	const line = visibleLine(before, sel.head);
	const r = foldedOn(before, line.from, line.to);
	if (!r) return null;
	const pointer = tr.isUserEvent("select.pointer");
	// 자식(… 오른쪽, 접힌 범위 끝)에 놓이면 어떻게 왔든(화살표, 검색, 이동 명령) 편다. 클릭이면 pressFold가 뗀 뒤에 편다
	// (자식 한가운데는 CodeMirror가 알아서 편다)
	if (sel.head > r.from) return pointer ? null : { effects: unfoldEffect.of(r) };
	// 접힌 줄 자체는 사용자가 옮긴 캐럿만. 화살표는 다른 줄에서 왔을 때만, 클릭은 이미 그 줄에 있어도(접은 뒤 다시 누르면 편다)
	if (!tr.isUserEvent("select")) return null;
	const moved = line.number !== visibleLine(before, before.selection.main.head).number;
	return moved || pointer ? { effects: unfoldEffect.of(r) } : null;
});

export default class EditorUxfixPlugin extends Plugin {
	async onload() {
		Object.assign(settings, DEFAULT_SETTINGS, await this.loadData());
		this.addSettingTab(new SettingTab(this.app, this));
		this.registerEditorExtension([pressFold, unfoldOnEnter]);
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
				.onChange(async v => { settings[key] = v; await this.plugin.saveSettings(); }));
		toggle("longPress", "꾹 누르기로 부모 접기", "줄을 0.5초 누르면 그 줄을 품은 부모 항목이나 제목을 접는다. 부모가 없으면 그 줄을 접는다.");
		toggle("clickToggle", "캐럿 자리 클릭으로 접기/펴기", "캐럿이 있는 바로 그 자리를 클릭하면 그 줄을 접거나 편다.");
		toggle("unfoldOnEnter", "캐럿이 들어가면 펴기", "화살표나 클릭으로 캐럿이 접힌 줄에 들어가면 편다.");
		if (Platform.isWin) toggle("siblingFold", "오른쪽 꾹 누르기로 형제 접기", "줄을 오른쪽 버튼으로 0.5초 누르면 그 줄과 같은 수준의 형제 항목이나 제목을 모두 접는다. 짧게 누르면 보통 메뉴가 뜬다.");
	}
}
