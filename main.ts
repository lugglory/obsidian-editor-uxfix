import { Plugin } from "obsidian";
import { Annotation, EditorState, Transaction } from "@codemirror/state";
import { EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { foldable, foldEffect, foldedRanges, unfoldEffect } from "@codemirror/language";

const LONG_PRESS = 500; // 꾹 누르기 ms
const MOVE_SLOP = 4;    // 이만큼 넘게 움직이면 꾹 누르기가 아니다(드래그 선택)
const SCAN_UP = 2000;   // 부모를 찾아 위로 훑는 줄 수

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

// 접을 범위: 그 줄이 접히면 그 줄. withParent면 잎일 때 그 줄을 품은 가장 가까운 위 줄(부모 목록 항목, 제목)
function foldTarget(state: EditorState, pos: number, withParent: boolean): Range | null {
	const line = state.doc.lineAt(pos);
	const own = foldable(state, line.from, line.to);
	if (own || !withParent) return own;
	for (let n = line.number - 1; n >= 1 && line.number - n <= SCAN_UP; n--) {
		const l = state.doc.line(n);
		const r = foldable(state, l.from, l.to);
		if (r && r.to >= line.to) return r;
	}
	return null;
}

// 꾹 누르기 = 접기(잎이면 부모). 캐럿을 옮기지 않은 짧은 클릭 = 그 줄 접기.
// 접힌 줄이면 어느 쪽이든 편다(캐럿이 들어가며 unfoldOnEnter가 이미 폈으면 그대로).
const pressFold = ViewPlugin.fromClass(class {
	timer: number | null = null;
	cleanup: (() => void) | null = null;

	constructor(readonly view: EditorView) {}

	cancel() {
		if (this.timer !== null) { window.clearTimeout(this.timer); this.timer = null; }
		if (this.cleanup) { this.cleanup(); this.cleanup = null; }
	}

	// 누르는 사이 문서가 바뀌면(동기화 등) 잰 자리가 틀리니 그만둔다
	update(u: ViewUpdate) { if (u.docChanged) this.cancel(); }

	start(e: MouseEvent) {
		this.cancel();
		if (e.button !== 0 || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
		const target = e.target as HTMLElement;
		// 접기 화살표, 체크박스 같은 위젯은 제 동작에 맡긴다
		if (target.closest(".cm-foldGutter, .collapse-indicator, .cm-fold-indicator, input, button")) return;
		const pos = this.view.posAtCoords({ x: e.clientX, y: e.clientY });
		if (pos === null) return;
		const { state } = this.view;
		const line = state.doc.lineAt(pos);
		const wasFolded = foldedOn(state, line.from, line.to) !== null;
		// 편집기에 포커스가 있고 캐럿이 바로 그 자리: 캐럿이 옮겨지지 않는 클릭
		// (포커스가 없을 때의 클릭은 편집기로 돌아오는 클릭이라 치지 않는다)
		const sel = state.selection.main;
		const inPlace = this.view.hasFocus && sel.empty && sel.head === pos && e.detail === 1;
		const x = e.clientX, y = e.clientY;
		const win = this.view.dom.ownerDocument.defaultView || window;
		const onMove = (m: MouseEvent) => { if (Math.abs(m.clientX - x) > MOVE_SLOP || Math.abs(m.clientY - y) > MOVE_SLOP) this.cancel(); };
		const onUp = () => {
			const shortClick = this.timer !== null; // 꾹 누르기가 되기 전에, 움직이지 않고 뗐다
			this.cancel();
			// 캐럿이 그대로면 CodeMirror가 선택을 내지 않아 unfoldOnEnter도 돌지 않는다: 여기서 접거나 편다
			if (shortClick && inPlace) { if (wasFolded) this.unfold(pos); else this.fold(pos, false); }
		};
		win.addEventListener("mousemove", onMove, true);
		win.addEventListener("mouseup", onUp, true);
		this.view.scrollDOM.addEventListener("scroll", this.onScroll, { passive: true });
		this.cleanup = () => {
			win.removeEventListener("mousemove", onMove, true);
			win.removeEventListener("mouseup", onUp, true);
			this.view.scrollDOM.removeEventListener("scroll", this.onScroll);
		};
		this.timer = window.setTimeout(() => {
			this.timer = null;
			this.cancel();
			this.holdUntilRelease(win);
			if (wasFolded) this.unfold(pos); else this.fold(pos, true);
		}, LONG_PRESS);
	}

	onScroll = () => this.cancel();

	// 꾹 누르기가 된 뒤 손을 뗄 때까지: 마우스 움직임을 CodeMirror의 드래그 선택에 보내지 않고(접혀서 자리가
	// 바뀐 문서에 엉뚱한 범위가 잡힌다), 뗄 때의 클릭도 삼킨다(링크 위였으면 열리지 않게)
	holdUntilRelease(win: Window) {
		const block = (ev: Event) => ev.stopPropagation();
		const stop = (ev: Event) => { ev.preventDefault(); ev.stopPropagation(); };
		const release = () => {
			win.removeEventListener("mousemove", block, true);
			win.removeEventListener("mouseup", release, true);
			// click은 mouseup 바로 뒤에 온다
			win.setTimeout(() => win.removeEventListener("click", stop, true), 0);
		};
		win.addEventListener("mousemove", block, true);
		win.addEventListener("mouseup", release, true);
		win.addEventListener("click", stop, true);
	}

	fold(pos: number, withParent: boolean) {
		const { state } = this.view;
		if (pos > state.doc.length) return;
		const r = foldTarget(state, pos, withParent);
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

	destroy() { this.cancel(); }
}, {
	eventHandlers: {
		mousedown(e) { this.start(e); return false; }, // 캐럿 놓기는 CodeMirror 기본 동작에 맡긴다
	},
});

// 캐럿이 접힌 줄로 들어가면(클릭, 화살표) 편다. 범위 선택 중이거나 문서가 바뀐 트랜잭션은 건드리지 않는다
const unfoldOnEnter = EditorState.transactionExtender.of((tr: Transaction) => {
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

export default class LinetreePlugin extends Plugin {
	async onload() {
		this.registerEditorExtension([pressFold, unfoldOnEnter]);
	}
}
