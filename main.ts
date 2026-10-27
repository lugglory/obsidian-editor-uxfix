import { App, MarkdownView, Plugin, PluginSettingTab, Setting, SettingDefinitionItem, editorInfoField, moment } from "obsidian";
import { EditorState, Line, RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { foldable, foldEffect, foldedRanges, unfoldEffect } from "@codemirror/language";

const GAUGE_DELAY = 120; // 꾹 누르기 게이지를 띄우기까지 ms(짧은 클릭에는 안 보이게)
const MOVE_SLOP = 4;    // 이만큼 넘게 움직이면 꾹 누르기가 아니다(드래그 선택)
const SCAN_UP = 2000;   // 부모를 찾아 위로 훑는 줄 수
const WHEEL_STEP = 100; // 휠 한 단계로 치는 스크롤 양(px). 마우스 휠 한 칸이 보통 100, 터치패드는 잘게 나눠 온다
const WHEEL_IDLE = 300; // 이만큼(ms) 휠이 멈추면 덜 찬 양을 버린다

interface Settings {
	longPress: boolean;   // 꾹 누르기 = 그 줄 접기/펴기(자식이 없으면 부모 접기)
	longPressMs: number;  // 꾹 누르기로 치는 시간(ms)
	clickToggle: boolean; // 캐럿 자리 클릭 = 그 줄 접기/펴기
	headerButtons: boolean; // 편집기 위쪽 줄의 끝까지 펴기/접기 버튼
	leftWheel: boolean;     // 글 왼쪽(여백, 들여쓰기, 목록 기호, 번호, 제목 #)에서 휠 = 그 줄을 한 단계씩 펴기/접기
	leftClick: boolean;     // 글 왼쪽 클릭 = 그 높이의 줄 접기/펴기(꺾쇠 단추처럼, 캐럿은 그대로)
}

const DEFAULT_SETTINGS: Settings = { longPress: true, longPressMs: 400, clickToggle: true, headerButtons: true, leftWheel: true, leftClick: true };

type BoolKey = Exclude<keyof Settings, "longPressMs">;
const BOOL_KEYS: BoolKey[] = ["longPress", "clickToggle", "headerButtons", "leftWheel", "leftClick"];
const clampMs = (v: number) => Math.min(1000, Math.max(200, v));

// 편집기 확장들이 이벤트 때마다 읽는다: 설정을 바꾸면 바로 적용된다
const settings: Settings = { ...DEFAULT_SETTINGS };

// 열린 편집기마다 버튼을 다시 보이거나 감춘다(설정을 바꾸거나 읽기 모드로 바꿨을 때)
const refreshers = new Set<() => void>();
const refreshAll = () => refreshers.forEach(f => f());

type Range = { from: number; to: number };

// 화면 문구. 옵시디언 언어가 한국어면 한국어, 아니면 영어(옵시디언은 날짜 표시용 moment의 언어를 앱 언어로 맞춘다)
const STRINGS = {
	en: {
		foldAll: "Fold all",
		unfoldAll: "Unfold all",
		longPress: ["Long-press to fold",
			"Hold a line to fold or unfold it. On a line with no children, its parent (list item or heading) folds. Left of the text (with Click left of text on), the parent folds even if the line has children. Directional chevrons next to the mouse fill up while you hold: outward to unfold, inward to fold."],
		longPressMs: ["Long-press time", "How long to hold, in milliseconds, before a press counts as a long-press."],
		clickToggle: ["Click the caret spot to fold",
			"Clicking exactly where the caret already is folds or unfolds that line."],
		headerButtons: ["Fold all / unfold all buttons",
			"Adds fold-all and unfold-all buttons to the view header (next to the reading view toggle). Fold all folds every level, hidden ones included. A button is dimmed when there is nothing to do."],
		leftWheel: ["Wheel left of text folds step by step",
			"Wheeling left of the text (margin, indentation, list markers, numbers, heading #) unfolds (up) or folds (down) that line and its children one level per notch, and doesn't scroll there. Nothing happens on a line with no children. The line under the mouse stays in place. While this or Click left of text is on, hovering there tints the line and its children and shows a pointer cursor."],
		leftClick: ["Click left of text to fold",
			"Clicking left of the text folds or unfolds that line, like the fold chevron: the caret and focus stay put, and nothing happens on a line with no children. No drag selection starts there."],
	},
	ko: {
		foldAll: "끝까지 접기",
		unfoldAll: "끝까지 펴기",
		longPress: ["꾹 누르기로 접기/펴기",
			"줄을 꾹 누르면 그 줄을 접거나 편다. 자식이 없는 줄이면 그 줄을 품은 부모 항목이나 제목을 접는다. 글 왼쪽(글 왼쪽 클릭이 켜져 있을 때)을 꾹 누르면 자식이 있어도 부모를 접는다. 누르는 동안 마우스 옆에 꺾쇠 게이지가 차오른다. 펼 때는 바깥쪽, 접을 때는 가운데를 향한다."],
		longPressMs: ["꾹 누르기 시간", "이만큼(밀리초) 누르고 있어야 꾹 누르기로 친다."],
		clickToggle: ["캐럿 자리 클릭으로 접기/펴기",
			"캐럿이 있는 바로 그 자리를 클릭하면 그 줄을 접거나 편다."],
		headerButtons: ["끝까지 펴기/접기 버튼",
			"편집기 위쪽(읽기 모드 전환 버튼이 있는 줄)에 끝까지 접기, 끝까지 펴기 버튼을 둔다. 끝까지 접기는 숨은 안쪽까지 모두 접는다. 누를 수 없는 버튼은 흐리게 한다."],
		leftWheel: ["글 왼쪽에서 휠로 그 줄 단계별 접기/펴기",
			"글보다 왼쪽(왼쪽 여백, 들여쓰기, 목록 기호, 번호, 제목 #)에서 휠을 굴리면 그 줄과 그 안을 한 칸마다 한 단계씩 편다(위로) 또는 접는다(아래로). 그곳에서는 스크롤되지 않고, 자식이 없는 줄이면 아무 일도 없다. 마우스가 가리키는 줄은 제자리에 남는다. 이 설정이나 글 왼쪽 클릭이 켜져 있으면, 그곳에 마우스를 올린 줄과 그 안을 옅게 칠하고 커서를 손가락 모양으로 바꾼다."],
		leftClick: ["글 왼쪽 클릭으로 그 줄 접기/펴기",
			"글보다 왼쪽을 클릭하면 접기 꺾쇠 단추처럼 그 줄을 접거나 편다. 캐럿과 포커스는 그대로이고, 자식이 없는 줄이면 아무 일도 없다. 그곳에서는 드래그 선택이 시작되지 않는다."],
	},
};
const t = () => moment.locale().startsWith("ko") ? STRINGS.ko : STRINGS.en;

// 글 왼쪽에 마우스를 올렸을 때 옅게 칠하는 범위(그 줄과 그 안)
const setHover = StateEffect.define<Range | null>();
const hoverField = StateField.define<Range | null>({
	create: () => null,
	update(v, tr) {
		for (const e of tr.effects) if (e.is(setHover)) return e.value;
		return tr.docChanged ? null : v; // 글이 바뀌면 다음 마우스 움직임에서 다시 잡는다
	},
});
const hoverLine = Decoration.line({ class: "editor-uxfix-hover" }); // 모양은 styles.css

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
// 글 왼쪽 휠 = 그 높이의 줄과 그 안을 휠 한 칸마다 한 단계씩 펴기(위로)/접기(아래로). 마우스 자리의 줄은 제자리에 둔다. 자식이 없는 줄이면 아무 일도 없다.
// 편집기 위쪽 줄의 버튼 = 문서 전체를 끝까지 펴기/접기. 누를 수 없는 버튼은 흐리게 한다
const pressFold = ViewPlugin.fromClass(class {
	timer: number | null = null;
	cleanup: (() => void) | null = null;
	release: (() => void) | null = null; // 꾹 누르기 뒤 holdUntilRelease가 건 것을 푼다
	win: Window = window; // 편집기가 있는 창(분리 창일 수 있다). 타이머도 이 창에 건다
	wheelAcc = 0;         // 아직 한 단계가 안 된 휠 양
	wheelAt = 0;          // 마지막 휠 시각
	anchor: { pos: number; top: number } | null = null; // keepLine: 화면에 붙들어 둘 줄과 그 원래 높이
	frame: number | null = null; // keepLine이 높이를 맞출 프레임
	buttons: { md: MarkdownView; openAll: HTMLElement; foldAll: HTMLElement } | null = null;
	refreshTimer: number | null = null;
	gauge: HTMLElement | null = null; // 꾹 누르기 게이지
	gaugeTimer: number | null = null;
	decorations: DecorationSet = Decoration.none; // 호버 칠하기
	mouse: { x: number; y: number } | null = null; // 편집기 위의 마지막 마우스 자리(버튼을 누르지 않았을 때)
	hoverFrame: number | null = null;

	constructor(readonly view: EditorView) {
		// 스크롤을 막아야 하니 passive가 아니게 직접 건다
		view.scrollDOM.addEventListener("wheel", this.onWheel, { passive: false });
		// 글 왼쪽 여백은 글 영역(contentDOM) 밖이라 스크롤 영역에서 받는다. CodeMirror가 캐럿을 옮기기 전에 봐야 하니 capture로
		view.scrollDOM.addEventListener("mousedown", this.onDown, true);
		view.scrollDOM.addEventListener("mousemove", this.onHoverMove, { passive: true });
		view.scrollDOM.addEventListener("mouseleave", this.onHoverLeave, { passive: true });
		// 스크롤하거나 접고 펴면 마우스 아래 줄이 바뀐다
		view.scrollDOM.addEventListener("scroll", this.hoverSoon, { passive: true });
		refreshers.add(this.refresh);
		// 편집기가 막 만들어진 때라 그 노트 창이 아직 준비되지 않았을 수 있다
		window.setTimeout(this.refresh, 0);
	}

	// 노트 창(MarkdownView)의 본 편집기면 위쪽 줄에 버튼을 단다. 미리보기 팝업, 캔버스 안 편집기 등은 제외
	attach() {
		if (this.buttons) return;
		const md = this.view.state.field(editorInfoField, false);
		if (!(md instanceof MarkdownView) || (md.editor as unknown as { cm?: EditorView })?.cm !== this.view) return;
		const foldAll = md.addAction("chevrons-down-up", t().foldAll, () => this.foldAll());
		const openAll = md.addAction("chevrons-up-down", t().unfoldAll, () => this.unfoldAll());
		this.buttons = { md, openAll, foldAll };
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

	// 누를 수 없는 버튼은 흐리게 한다(감추면 옆 버튼 자리가 바뀐다). 읽기 모드에서는 모두 감춘다
	refresh = () => {
		if (this.refreshTimer !== null) { window.clearTimeout(this.refreshTimer); this.refreshTimer = null; }
		this.hoverSoon(); // 설정을 바꿨으면 칠하기도 다시 본다
		this.attach();
		const b = this.buttons;
		if (!b) return;
		const show = settings.headerButtons && b.md.getMode() === "source";
		for (const el of [b.openAll, b.foldAll]) el.toggle(show);
		if (!show) return;
		const { state } = this.view;
		const enable = (el: HTMLElement, on: boolean) => {
			el.toggleClass("editor-uxfix-disabled", !on);
			el.setAttr("aria-disabled", String(!on));
		};
		enable(b.openAll, foldedRanges(state).size > 0);
		// 보이는 줄이 다 접혀 있어도 그 안에 안 접힌 줄이 남아 있으면 누를 수 있다
		enable(b.foldAll, this.unfoldedAll(true).length > 0);
	};

	cancel() {
		if (this.timer !== null) { this.win.clearTimeout(this.timer); this.timer = null; }
		if (this.cleanup) { this.cleanup(); this.cleanup = null; }
		this.stopGauge();
	}

	// 펼 때는 바깥쪽, 접을 때는 안쪽을 향해 차오르는 꺾쇠 게이지를 마우스 오른쪽 아래에 띄운다. 짧은 클릭에는 안 보이게 조금 뒤에, 그만큼 찬 채로 띄운다
	startGauge(win: Window, x: number, y: number, action: "fold" | "unfold") {
		this.gaugeTimer = win.setTimeout(() => {
			this.gaugeTimer = null;
			// 모양과 차오르는 애니메이션은 styles.css. 여기서는 동작에 맞는 경로, 자리, 시작 양, 걸리는 시간을 넘긴다
			const doc = win.document, ns = "http://www.w3.org/2000/svg";
			const el = doc.body.createDiv({ cls: "editor-uxfix-gauge" });
			el.setAttribute("aria-hidden", "true");
			el.dataset.action = action;
			el.setCssProps({
				// 화살표 커서 몸통은 비키되 커서에 붙은 표시로 보이게, 선이 끝점에서 10px 떨어진 곳부터 그려지게 둔다
				left: `${x + 10}px`,
				top: `${y + 10}px`,
				"--editor-uxfix-gauge-start": String(1 - GAUGE_DELAY / settings.longPressMs),
				"--editor-uxfix-gauge-time": `${settings.longPressMs - GAUGE_DELAY}ms`,
			});
			const svg = doc.createElementNS(ns, "svg");
			svg.setAttribute("viewBox", "-1.5 -1.5 15.5 19");
			// 꺾쇠의 양 끝에서 꼭짓점으로 동시에 채워 방향을 드러낸다.
			const paths = action === "unfold"
				? ["M 0 5.33 L 6.25 0", "M 12.5 5.33 L 6.25 0", "M 0 10.67 L 6.25 16", "M 12.5 10.67 L 6.25 16"]
				: ["M 0 0 L 6.25 5.33", "M 12.5 0 L 6.25 5.33", "M 0 16 L 6.25 10.67", "M 12.5 16 L 6.25 10.67"];
			for (const cls of ["editor-uxfix-gauge-track", "editor-uxfix-gauge-bar"]) {
				for (const d of paths) {
					const path = doc.createElementNS(ns, "path");
					for (const [k, v] of [["d", d], ["pathLength", "1"], ["class", cls]]) path.setAttribute(k, v);
					svg.appendChild(path);
				}
			}
			el.appendChild(svg);
			this.gauge = el;
		}, GAUGE_DELAY);
	}

	stopGauge() {
		if (this.gaugeTimer !== null) { this.win.clearTimeout(this.gaugeTimer); this.gaugeTimer = null; }
		if (this.gauge) { this.gauge.remove(); this.gauge = null; }
	}

	update(u: ViewUpdate) {
		if (u.docChanged) {
			// 누르는 사이 문서가 바뀌면(동기화 등) 잰 자리가 틀리니 그만둔다
			this.cancel();
			// 글자를 칠 때마다 문서를 훑지 않게, 입력이 멈추면 버튼을 다시 본다
			if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
			this.refreshTimer = window.setTimeout(this.refresh, 300);
		} else if (foldedRanges(u.startState) !== foldedRanges(u.state)) { this.refresh(); this.hoverSoon(); }
		if (u.docChanged || u.viewportChanged || u.startState.field(hoverField, false) !== u.state.field(hoverField, false))
			this.decorations = this.hoverDecorations();
	}

	onHoverMove = (e: MouseEvent) => {
		if (e.buttons !== 0) return; // 드래그 선택하는 동안은 그대로 둔다
		this.mouse = { x: e.clientX, y: e.clientY };
		this.hoverSoon();
	};

	onHoverLeave = () => { this.mouse = null; this.hoverSoon(); };

	// 마우스 아래가 글 왼쪽(휠, 클릭이 되는 곳)이면 그 줄과 그 안을 칠한다. 줄 위치를 재야 하니 업데이트 밖에서, 한 프레임에 한 번
	hoverSoon = () => {
		if (this.hoverFrame !== null) return;
		this.hoverFrame = (this.view.dom.ownerDocument.defaultView || window).requestAnimationFrame(() => {
			this.hoverFrame = null;
			const m = this.mouse;
			const hit = m && (settings.leftWheel || settings.leftClick) ? this.leftRange(m.x, m.y) : null;
			let next: Range | null = null;
			if (hit) next = { from: hit.line.from, to: hit.range ? Math.max(hit.range.to, hit.line.to) : hit.line.to };
			// 휠, 클릭이 되는 곳임을 알 수 있게 손가락 커서
			this.setCursor(hit !== null);
			const cur = this.view.state.field(hoverField, false);
			if (cur === undefined || (cur?.from === next?.from && cur?.to === next?.to)) return;
			this.view.dispatch({ effects: setHover.of(next) });
		});
	};

	setCursor(on: boolean) {
		this.view.dom.toggleClass("editor-uxfix-pointer", on); // 모양은 styles.css
	}

	// 칠할 범위 중 화면에 그려진 줄만. 접힌 줄 안은 접힌 줄로 친다
	hoverDecorations(): DecorationSet {
		const h = this.view.state.field(hoverField, false);
		if (!h) return Decoration.none;
		const { state } = this.view;
		const b = new RangeSetBuilder<Decoration>();
		let last = -1;
		for (const { from, to } of this.view.visibleRanges) {
			for (let pos = Math.max(from, h.from); pos <= Math.min(to, h.to);) {
				const l = visibleLine(state, pos);
				if (l.from > last) { b.add(l.from, l.from, hoverLine); last = l.from; }
				pos = state.doc.lineAt(pos).to + 1;
			}
		}
		return b.finish();
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
		// 글 왼쪽 클릭 = 접기 꺾쇠 단추처럼 그 높이의 줄 접기/펴기만(자식이 없으면 아무 일도 없다).
		// 글 왼쪽 꾹 누르기 = 그 줄의 부모 접기(부모가 없으면 그 줄).
		// CodeMirror에 넘기지 않으니 캐럿도 포커스도 그대로고, 드래그 선택도 시작되지 않는다. 움직였다 떼면 아무 일도 없다
		const local = settings.leftClick ? this.leftRange(e.clientX, e.clientY) : null;
		if (local) {
			e.preventDefault();
			e.stopPropagation();
			if (e.detail !== 1) return; // 더블클릭의 두 번째는 다시 토글하지 않는다
			const range = local.range;
			const win = this.win = this.view.dom.ownerDocument.defaultView || window;
			this.track(win, e, () => { if (range) this.toggleRange(local.pos, range); });
			// 꾹 눌러도 접을 것이 없으면 꾹 누르기(게이지도)를 걸지 않는다
			if (!settings.longPress || !this.upTarget(local.pos)) return;
			this.timer = win.setTimeout(() => {
				this.timer = null;
				this.cancel();
				this.holdUntilRelease(win);
				this.foldUp(local.pos);
			}, settings.longPressMs);
			this.startGauge(win, e.clientX, e.clientY, "fold");
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
		const pending = this.toggleTarget(pos, true);
		if (!pending) return;
		this.timer = win.setTimeout(() => {
			this.timer = null;
			this.cancel();
			this.holdUntilRelease(win);
			this.toggle(pos, true);
		}, settings.longPressMs);
		this.startGauge(win, e.clientX, e.clientY, pending.folded ? "unfold" : "fold");
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
		// 글 왼쪽에서만. Shift+휠(가로 스크롤)은 그대로 둔다
		if (e.shiftKey) return;
		const local = settings.leftWheel ? this.leftRange(e.clientX, e.clientY) : null;
		if (!local) return;
		e.preventDefault();
		const delta = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaMode === 2 ? e.deltaY * 800 : e.deltaY;
		// 방향이 바뀌거나 한동안 멈췄으면 쌓인 양을 버린다(한참 전에 조금 굴린 것이 다음 휠에 더해지지 않게)
		if (Math.sign(delta) !== Math.sign(this.wheelAcc) || e.timeStamp - this.wheelAt > WHEEL_IDLE) this.wheelAcc = 0;
		this.wheelAt = e.timeStamp;
		this.wheelAcc += delta;
		if (Math.abs(this.wheelAcc) < WHEEL_STEP) return;
		const open = this.wheelAcc < 0; // 위로 = 펴기
		this.wheelAcc = 0;
		const { pos } = local;
		this.keepLine(pos, () => this.stepLine(pos, open));
	};

	// 그 줄과 그 안을 한 단계. 자식이 없는 줄이면 아무 일도 없다
	stepLine(pos: number, open: boolean) {
		const own = ownFold(this.view.state, pos);
		if (own) this.step([own], open);
	}

	// 마우스가 글 왼쪽(편집기 왼쪽 여백, 들여쓰기, 목록 기호, 번호, 체크박스, 제목 #)에 있으면 그 높이의 줄과 그 줄을 접는 범위.
	// 자식이 없는 줄이면 range가 null이다(그래도 글 왼쪽이니 휠은 스크롤하지 않는다)
	leftRange(x: number, y: number): { pos: number; line: Line; range: Range | null } | null {
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
		return { pos, line, range: ownFold(state, line.from) };
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

	// toggle이 할 일: 펼 접힌 범위, 또는 접을 범위. 없으면 null
	toggleTarget(pos: number, parentIfLeaf: boolean): { folded: Range | null; fold: Range | null } | null {
		const { state } = this.view;
		if (pos > state.doc.length) return null;
		const line = visibleLine(state, pos);
		const folded = foldedOn(state, line.from, line.to);
		if (folded) return { folded, fold: null };
		const r = ownFold(state, pos) || (parentIfLeaf ? parentFold(state, pos) : null);
		return r ? { folded: null, fold: r } : null;
	}

	// 접혀 있으면 편다. 아니면 그 줄을 접고, 자식이 없으면 parentIfLeaf일 때 부모를 접는다
	toggle(pos: number, parentIfLeaf: boolean) {
		if (pos > this.view.state.doc.length) return;
		this.keepLine(pos, () => {
			const t = this.toggleTarget(pos, parentIfLeaf);
			if (t?.folded) this.unfold(t.folded);
			else if (t?.fold) this.foldRanges([t.fold]);
		});
	}

	// foldUp이 접을 범위: 그 줄의 부모, 부모가 없으면(맨 바깥 줄) 그 줄. 이미 접혀 있으면 null
	upTarget(pos: number): Range | null {
		const { state } = this.view;
		if (pos > state.doc.length) return null;
		const r = parentFold(state, pos) || ownFold(state, pos);
		return r && !foldedOn(state, state.doc.lineAt(r.from).from, r.from) ? r : null;
	}

	foldUp(pos: number) {
		if (pos > this.view.state.doc.length) return;
		this.keepLine(pos, () => {
			const r = this.upTarget(pos);
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
		if (this.frame !== null) (this.view.dom.ownerDocument.defaultView || window).cancelAnimationFrame(this.frame);
		if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
		refreshers.delete(this.refresh);
		if (this.buttons) for (const el of [this.buttons.openAll, this.buttons.foldAll]) el.remove();
		this.view.scrollDOM.removeEventListener("wheel", this.onWheel);
		this.view.scrollDOM.removeEventListener("mousedown", this.onDown, true);
		this.view.scrollDOM.removeEventListener("mousemove", this.onHoverMove);
		this.view.scrollDOM.removeEventListener("mouseleave", this.onHoverLeave);
		this.view.scrollDOM.removeEventListener("scroll", this.hoverSoon);
		if (this.hoverFrame !== null) (this.view.dom.ownerDocument.defaultView || window).cancelAnimationFrame(this.hoverFrame);
		this.setCursor(false);
	}
}, {
	decorations: v => v.decorations,
});

export default class EditorUxfixPlugin extends Plugin {
	async onload() {
		// 없어진 설정 항목이 남아 있어도 읽지 않는다
		const data: unknown = await this.loadData();
		const saved = (typeof data === "object" && data !== null ? data : {}) as Partial<Record<keyof Settings, unknown>>;
		for (const key of BOOL_KEYS) {
			const v = saved[key];
			if (typeof v === "boolean") settings[key] = v;
		}
		if (typeof saved.longPressMs === "number") settings.longPressMs = clampMs(saved.longPressMs);
		this.addSettingTab(new SettingTab(this.app, this));
		this.registerEditorExtension([hoverField, pressFold]);
		// 읽기 모드로 바꾸면 버튼을 감춘다
		this.registerEvent(this.app.workspace.on("layout-change", refreshAll));
	}

	async saveSettings() { await this.saveData(settings); }
}

class SettingTab extends PluginSettingTab {
	constructor(app: App, readonly plugin: EditorUxfixPlugin) { super(app, plugin); }

	// 1.13 이상: 선언형으로 그려서 설정 검색에도 잡힌다. 값은 아래 getControlValue/setControlValue로 settings와 주고받는다
	getSettingDefinitions(): SettingDefinitionItem[] {
		const text = t();
		const toggle = (key: BoolKey): SettingDefinitionItem =>
			({ name: text[key][0], desc: text[key][1], control: { type: "toggle", key } });
		return [
			toggle("longPress"),
			{ name: text.longPressMs[0], desc: text.longPressMs[1], control: { type: "slider", key: "longPressMs", min: 200, max: 1000, step: 50 } },
			toggle("clickToggle"),
			toggle("headerButtons"),
			toggle("leftWheel"),
			toggle("leftClick"),
		];
	}

	getControlValue(key: string): unknown {
		return key in settings ? settings[key as keyof Settings] : undefined;
	}

	async setControlValue(key: string, value: unknown) {
		if (key === "longPressMs" && typeof value === "number") settings.longPressMs = clampMs(value);
		else if ((BOOL_KEYS as string[]).includes(key) && typeof value === "boolean") settings[key as BoolKey] = value;
		else return;
		refreshAll();
		await this.plugin.saveSettings();
	}

	// 1.13 미만에서만 불린다(1.13 이상은 위 정의로 그린다)
	display() {
		const { containerEl } = this;
		containerEl.empty();
		const text = t();
		const toggle = (key: BoolKey) =>
			new Setting(containerEl).setName(text[key][0]).setDesc(text[key][1]).addToggle(c => c
				.setValue(settings[key])
				.onChange(async v => { settings[key] = v; refreshAll(); await this.plugin.saveSettings(); }));
		toggle("longPress");
		// 1.13 미만에는 슬라이더 옆에 값이 안 보여서 설명 끝에 붙인다
		const ms = new Setting(containerEl).setName(text.longPressMs[0]);
		const showMs = (v: number) => ms.setDesc(`${text.longPressMs[1]} (${v} ms)`);
		showMs(settings.longPressMs);
		ms.addSlider(c => c
			.setLimits(200, 1000, 50)
			.setValue(settings.longPressMs)
			.onChange(async v => { settings.longPressMs = v; showMs(v); await this.plugin.saveSettings(); }));
		toggle("clickToggle");
		toggle("headerButtons");
		toggle("leftWheel");
		toggle("leftClick");
	}
}
