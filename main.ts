import { Plugin } from "obsidian";
import { Annotation, EditorState, StateEffect, Transaction } from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";
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

// 꾹 누른 줄의 접을 범위: 그 줄이 접히면 그 줄, 아니면(잎) 그 줄을 품은 가장 가까운 위 줄(부모 목록 항목, 제목)
function foldTarget(state: EditorState, pos: number): Range | null {
	const line = state.doc.lineAt(pos);
	const own = foldable(state, line.from, line.to);
	if (own) return own;
	for (let n = line.number - 1; n >= 1 && line.number - n <= SCAN_UP; n--) {
		const l = state.doc.line(n);
		const r = foldable(state, l.from, l.to);
		if (r && r.to >= line.to) return r;
	}
	return null;
}

function swallowNextClick() {
	const stop = (e: Event) => { e.preventDefault(); e.stopPropagation(); };
	window.addEventListener("click", stop, { capture: true, once: true });
	window.setTimeout(() => window.removeEventListener("click", stop, { capture: true }), 400);
}

// 꾹 누르기 = 접기. 접힌 줄을 누르면 누르는 순간(캐럿이 들어가며) 펴지므로 꾹 눌러도 다시 접지 않는다
const longPress = ViewPlugin.fromClass(class {
	timer: number | null = null;
	cleanup: (() => void) | null = null;

	constructor(readonly view: EditorView) {}

	cancel() {
		if (this.timer !== null) { window.clearTimeout(this.timer); this.timer = null; }
		if (this.cleanup) { this.cleanup(); this.cleanup = null; }
	}

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
		// 캐럿이 있는 바로 그 자리를 누름: 캐럿이 옮겨지지 않으니 짧은 클릭이면 접기
		const sel = state.selection.main;
		const inPlace = sel.empty && sel.head === pos && e.detail === 1;
		const x = e.clientX, y = e.clientY;
		const doc = this.view.dom.ownerDocument;
		const onMove = (m: MouseEvent) => { if (Math.abs(m.clientX - x) > MOVE_SLOP || Math.abs(m.clientY - y) > MOVE_SLOP) this.cancel(); };
		const onUp = () => {
			const shortClick = this.timer !== null; // 꾹 누르기가 되기 전에, 움직이지 않고 뗐다
			this.cancel();
			// 접힌 줄이었으면 누르는 순간 이미 펴졌다
			if (shortClick && inPlace && !wasFolded) this.fold(pos);
		};
		doc.addEventListener("mousemove", onMove);
		doc.addEventListener("mouseup", onUp);
		this.view.scrollDOM.addEventListener("scroll", onUp, { passive: true });
		this.cleanup = () => {
			doc.removeEventListener("mousemove", onMove);
			doc.removeEventListener("mouseup", onUp);
			this.view.scrollDOM.removeEventListener("scroll", onUp);
		};
		this.timer = window.setTimeout(() => {
			this.timer = null;
			this.cancel();
			swallowNextClick(); // 링크 위에서 꾹 눌렀으면 뗄 때 열리지 않게
			if (wasFolded) return; // 이미 누르는 순간 펴졌다
			this.fold(pos);
		}, LONG_PRESS);
	}

	fold(pos: number) {
		const { state } = this.view;
		if (pos > state.doc.length) return;
		const r = foldTarget(state, pos);
		if (!r) return;
		const head = state.selection.main.head;
		const effects: StateEffect<unknown>[] = [foldEffect.of(r)];
		// 캐럿이 접히는 안쪽에 있으면 접은 줄 끝으로
		const inside = head > r.from && head <= r.to;
		this.view.dispatch({
			effects,
			selection: inside ? { anchor: r.from } : undefined,
			annotations: ours.of(true),
		});
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
		this.registerEditorExtension([longPress, unfoldOnEnter]);
	}
}
