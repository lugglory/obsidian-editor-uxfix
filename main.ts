import { App, Plugin, PluginSettingTab, Setting } from "obsidian";
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
}

const DEFAULT_SETTINGS: Settings = { longPress: true, clickToggle: true, unfoldOnEnter: true };

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

// 그 줄을 접는 범위
function ownFold(state: EditorState, pos: number): Range | null {
	const line = state.doc.lineAt(pos);
	return foldable(state, line.from, line.to);
}

// 그 줄을 품은 가장 가까운 위 줄(부모 목록 항목, 제목)을 접는 범위
function parentFold(state: EditorState, pos: number): Range | null {
	const line = state.doc.lineAt(pos);
	for (let n = line.number - 1; n >= 1 && line.number - n <= SCAN_UP; n--) {
		const l = state.doc.line(n);
		const r = foldable(state, l.from, l.to);
		if (r && r.to >= line.to) return r;
	}
	return null;
}

// 꾹 누르기 = 부모 접기(최상단이면 그 줄). 캐럿을 옮기지 않은 짧은 클릭 = 그 줄 접기.
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

	start(e: MouseEvent) {
		this.cancel();
		if (e.button !== 0 || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
		if (!settings.longPress && !settings.clickToggle) return;
		const target = e.target as HTMLElement;
		// 접기 화살표, 체크박스 같은 위젯은 제 동작에 맡긴다
		if (target.closest(".cm-foldGutter, .collapse-indicator, .cm-fold-indicator, .cm-foldPlaceholder, input, button")) return;
		const pos = this.view.posAtCoords({ x: e.clientX, y: e.clientY });
		if (pos === null) return;
		const { state } = this.view;
		const line = state.doc.lineAt(pos);
		const wasFolded = foldedOn(state, line.from, line.to) !== null;
		// 편집기에 포커스가 있고 캐럿이 바로 그 자리: 캐럿이 옮겨지지 않는 클릭
		// (포커스가 없을 때의 클릭은 편집기로 돌아오는 클릭이라 치지 않는다)
		const sel = state.selection.main;
		const inPlace = settings.clickToggle && this.view.hasFocus && sel.empty && sel.head === pos && e.detail === 1;
		if (!settings.longPress && !inPlace) return;
		const x = e.clientX, y = e.clientY;
		const win = this.win = this.view.dom.ownerDocument.defaultView || window;
		const onMove = (m: MouseEvent) => { if (Math.abs(m.clientX - x) > MOVE_SLOP || Math.abs(m.clientY - y) > MOVE_SLOP) this.cancel(); };
		// 여기까지 오면 움직이지 않고 뗀 것이다(움직이거나 꾹 누르기가 되면 cancel이 이 리스너를 뗀다)
		const onUp = () => {
			this.cancel();
			// 캐럿이 그대로면 CodeMirror가 선택을 내지 않아 unfoldOnEnter도 돌지 않는다: 여기서 접거나 편다
			if (inPlace) { if (wasFolded) this.unfold(pos); else this.fold(pos, false); }
		};
		// 누른 채 창을 벗어나면(Alt+Tab 등) 떼는 신호를 못 받을 수 있다: 꾹 누르기로 치지 않는다
		const onBlur = () => this.cancel();
		win.addEventListener("mousemove", onMove, true);
		win.addEventListener("mouseup", onUp, true);
		win.addEventListener("blur", onBlur);
		this.view.scrollDOM.addEventListener("scroll", this.onScroll, { passive: true });
		this.cleanup = () => {
			win.removeEventListener("mousemove", onMove, true);
			win.removeEventListener("mouseup", onUp, true);
			win.removeEventListener("blur", onBlur);
			this.view.scrollDOM.removeEventListener("scroll", this.onScroll);
		};
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

	onScroll = () => this.cancel();

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

	// 아직 접혀 있으면 편다(누르는 순간 캐럿이 들어가며 이미 펴졌으면 아무것도 안 한다)
	unfold(pos: number) {
		const { state } = this.view;
		if (pos > state.doc.length) return;
		const line = state.doc.lineAt(pos);
		const r = foldedOn(state, line.from, line.to);
		if (r) this.view.dispatch({ effects: unfoldEffect.of(r), annotations: ours.of(true) });
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

// 캐럿이 접힌 줄로 들어가면(클릭, 화살표) 편다. 범위 선택 중이거나 문서가 바뀐 트랜잭션은 건드리지 않는다
const unfoldOnEnter = EditorState.transactionExtender.of((tr: Transaction) => {
	if (!settings.unfoldOnEnter) return null;
	if (!tr.selection || tr.docChanged || tr.annotation(ours)) return null;
	if (!tr.isUserEvent("select")) return null;
	const sel = tr.selection.main;
	if (!sel.empty) return null;
	const before = tr.startState;
	const line = before.doc.lineAt(sel.head);
	// 화살표는 다른 줄로 옮겨 갔을 때만. 클릭은 캐럿이 이미 그 줄에 있어도(접은 뒤 다시 누르면 편다)
	const moved = line.number !== before.doc.lineAt(before.selection.main.head).number;
	if (!moved && !tr.isUserEvent("select.pointer")) return null;
	const r = foldedOn(before, line.from, line.to);
	return r ? { effects: unfoldEffect.of(r) } : null;
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
	}
}
