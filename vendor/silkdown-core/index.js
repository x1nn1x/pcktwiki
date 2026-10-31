import { Prec, EditorSelection, EditorState } from "@codemirror/state";
import { Decoration, WidgetType, EditorView, ViewPlugin, keymap } from "@codemirror/view";
import { history, historyKeymap } from "@codemirror/commands";
import { insertNewlineContinueMarkup, markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { syntaxTree } from "@codemirror/language";
function selectionTouchesLineRange(doc, selection, from, to) {
  const safeTo = to > from ? Math.max(from, to - 1) : to;
  const nodeStartLine = doc.lineAt(from).number;
  const nodeEndLine = doc.lineAt(safeTo).number;
  for (const range of selection.ranges) {
    const selStartLine = doc.lineAt(range.from).number;
    const selEndLine = doc.lineAt(range.to).number;
    if (selStartLine <= nodeEndLine && nodeStartLine <= selEndLine) return true;
  }
  return false;
}
function* children(parent) {
  let child = parent.firstChild;
  while (child) {
    yield child;
    child = child.nextSibling;
  }
}
function firstChildNamed(parent, name) {
  for (const child of children(parent)) {
    if (child.name === name) return child;
  }
  return null;
}
function lastChildNamed(parent, name) {
  let last = null;
  for (const child of children(parent)) {
    if (child.name === name) last = child;
  }
  return last;
}
const HIDE = Decoration.replace({});
const MUTED_MARK = Decoration.mark({ class: "sd-mark" });
function pushAtomicRange(ranges, atomicRanges, decoration, from, to) {
  ranges.push(decoration.range(from, to));
  atomicRanges.push(decoration.range(from, to));
}
function pushRevealableMark(ranges, atomicRanges, revealed, from, to) {
  if (revealed) {
    ranges.push(MUTED_MARK.range(from, to));
  } else {
    pushAtomicRange(ranges, atomicRanges, HIDE, from, to);
  }
}
const STRONG_MARK = Decoration.mark({ class: "sd-strong" });
const EM_MARK = Decoration.mark({ class: "sd-em" });
const CODE_MARK = Decoration.mark({ class: "sd-code" });
const STRIKE_MARK = Decoration.mark({ class: "sd-strike" });
const STYLES = {
  StrongEmphasis: STRONG_MARK,
  Emphasis: EM_MARK,
  InlineCode: CODE_MARK,
  Strikethrough: STRIKE_MARK
};
function isInlineNodeName(name) {
  return name in STYLES;
}
const MARKER_NODES = /* @__PURE__ */ new Set(["EmphasisMark", "CodeMark", "StrikethroughMark"]);
function decorateInline(ranges, atomicRanges, node, doc, sel) {
  if (!isInlineNodeName(node.name)) return;
  const styling = STYLES[node.name];
  ranges.push(styling.range(node.from, node.to));
  const revealed = selectionTouchesLineRange(doc, sel, node.from, node.to);
  if (!revealed) {
    atomicRanges.push(styling.range(node.from, node.to));
  }
  for (const child of children(node)) {
    if (!MARKER_NODES.has(child.name)) continue;
    pushRevealableMark(ranges, atomicRanges, revealed, child.from, child.to);
  }
}
const LINE_CLASSES = {
  1: Decoration.line({ class: "sd-h1" }),
  2: Decoration.line({ class: "sd-h2" }),
  3: Decoration.line({ class: "sd-h3" }),
  4: Decoration.line({ class: "sd-h4" }),
  5: Decoration.line({ class: "sd-h5" }),
  6: Decoration.line({ class: "sd-h6" })
};
function decorateHeading(ranges, atomicRanges, node, doc, sel) {
  const level = Number.parseInt(node.name.slice(-1), 10);
  const lineClass = LINE_CLASSES[level];
  const line = doc.lineAt(node.from);
  ranges.push(lineClass.range(line.from));
  const headerMark = node.firstChild;
  if (headerMark?.name !== "HeaderMark") return;
  const markTo = Math.min(headerMark.to + 1, node.to);
  const revealed = selectionTouchesLineRange(doc, sel, node.from, node.to);
  pushRevealableMark(ranges, atomicRanges, revealed, headerMark.from, markTo);
}
const LINE_CLASS = Decoration.line({ class: "sd-blockquote" });
function decorateBlockquote(ranges, atomicRanges, node, doc, sel) {
  let pos = node.from;
  while (pos <= node.to) {
    const line = doc.lineAt(pos);
    ranges.push(LINE_CLASS.range(line.from));
    if (line.to >= node.to) break;
    pos = line.to + 1;
  }
  const revealed = selectionTouchesLineRange(doc, sel, node.from, node.to);
  for (const child of children(node)) {
    if (child.name !== "QuoteMark") continue;
    const next = doc.sliceString(child.to, child.to + 1);
    const markTo = next === " " ? child.to + 1 : child.to;
    pushRevealableMark(ranges, atomicRanges, revealed, child.from, markTo);
  }
}
class TaskCheckboxWidget extends WidgetType {
  constructor(checked, from, to) {
    super();
    this.checked = checked;
    this.from = from;
    this.to = to;
  }
  eq(other) {
    return other.checked === this.checked && other.from === this.from && other.to === this.to;
  }
  toDOM(view) {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.className = "sd-task-checkbox";
    input.checked = this.checked;
    input.setAttribute("aria-label", this.checked ? "Mark task open" : "Mark task done");
    input.addEventListener("mousedown", (e) => {
      e.preventDefault();
    });
    input.addEventListener("change", () => {
      view.dispatch({
        changes: {
          from: this.from,
          to: this.to,
          insert: this.checked ? "[ ]" : "[x]"
        }
      });
    });
    return input;
  }
  ignoreEvent(event) {
    return event.type !== "mousedown" && event.type !== "click";
  }
}
const ITEM_LINE = Decoration.line({ class: "sd-list-item" });
function decorateListItem(ranges, atomicRanges, node, doc, _sel) {
  const startLine = doc.lineAt(node.from);
  ranges.push(ITEM_LINE.range(startLine.from));
  for (const child of children(node)) {
    if (child.name !== "Task") continue;
    for (const inner of children(child)) {
      if (inner.name !== "TaskMarker") continue;
      const text = doc.sliceString(inner.from, inner.to);
      const checked = text.toLowerCase().includes("x");
      pushAtomicRange(
        ranges,
        atomicRanges,
        Decoration.replace({
          widget: new TaskCheckboxWidget(checked, inner.from, inner.to)
        }),
        inner.from,
        inner.to
      );
    }
  }
}
const DATA_IMAGE_RE = /^data:image\/[a-z0-9+-]+(;[a-z0-9-]+=[a-z0-9-]+)*(;base64)?,/i;
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const defaultUrlPolicy = (url) => {
  const trimmed = url.trim();
  if (trimmed.length === 0) return null;
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("http://") || lower.startsWith("https://")) return trimmed;
  if (DATA_IMAGE_RE.test(trimmed)) return trimmed;
  if (trimmed.startsWith("//")) return null;
  if (!SCHEME_RE.test(trimmed)) return trimmed;
  return null;
};
function safeUrl(url, policy = defaultUrlPolicy) {
  return policy(url);
}
class ImageWidget extends WidgetType {
  constructor(src, alt) {
    super();
    this.src = src;
    this.alt = alt;
  }
  eq(other) {
    return other.src === this.src && other.alt === this.alt;
  }
  toDOM() {
    const img = document.createElement("img");
    img.className = "sd-image-widget";
    img.src = this.src;
    img.alt = this.alt;
    img.loading = "lazy";
    img.decoding = "async";
    return img;
  }
  ignoreEvent() {
    return false;
  }
}
const LABEL_WHITESPACE_RE = /\s+/g;
function buildLinkReferences(tree, doc) {
  const refs = /* @__PURE__ */ new Map();
  tree.iterate({
    enter(node) {
      if (node.name !== "LinkReference") return;
      let label = null;
      let url = null;
      for (const child of children(node.node)) {
        if (child.name === "LinkLabel") label = labelKey(doc, child);
        else if (child.name === "URL") url = doc.sliceString(child.from, child.to);
      }
      if (label && url) refs.set(label, url);
    }
  });
  return refs;
}
function labelKey(doc, labelNode) {
  return normalizeReferenceLabel(doc.sliceString(labelNode.from + 1, labelNode.to - 1));
}
function normalizeReferenceLabel(label) {
  return label.trim().replace(LABEL_WHITESPACE_RE, " ").toLowerCase();
}
function parseLink(node, doc, references) {
  const marks = [];
  let urlNode = null;
  let labelNode = null;
  let bangMark = null;
  for (const child of children(node)) {
    if (child.name === "LinkMark") {
      const literal = doc.sliceString(child.from, child.to);
      if (literal === "!") bangMark = child;
      else marks.push(child);
    } else if (child.name === "URL") {
      urlNode = child;
    } else if (child.name === "LinkLabel") {
      labelNode = child;
    }
  }
  const open = marks[0];
  const close = marks[1];
  if (!open || !close) return null;
  const textFrom = open.to;
  const textTo = close.from;
  let url = "";
  if (urlNode) {
    url = doc.sliceString(urlNode.from, urlNode.to);
  } else if (labelNode) {
    url = references.get(labelKey(doc, labelNode)) ?? "";
  } else {
    const key = normalizeReferenceLabel(doc.sliceString(textFrom, textTo));
    url = references.get(key) ?? "";
  }
  const allMarks = bangMark ? [bangMark, ...marks] : marks;
  return { marks: allMarks, urlNode, labelNode, textFrom, textTo, url };
}
function muteLinkSyntax(ranges, parts) {
  for (const m of parts.marks) {
    ranges.push(MUTED_MARK.range(m.from, m.to));
  }
  if (parts.urlNode) {
    ranges.push(MUTED_MARK.range(parts.urlNode.from, parts.urlNode.to));
  }
  if (parts.labelNode) {
    ranges.push(MUTED_MARK.range(parts.labelNode.from, parts.labelNode.to));
  }
}
function decorateLink(ranges, atomicRanges, node, doc, sel, references, urlPolicy = defaultUrlPolicy) {
  const parts = parseLink(node, doc, references);
  if (!parts) return;
  const safe = urlPolicy(parts.url);
  const revealed = selectionTouchesLineRange(doc, sel, node.from, node.to);
  if (revealed) {
    muteLinkSyntax(ranges, parts);
    if (safe && parts.textFrom < parts.textTo) {
      ranges.push(linkMark(safe).range(parts.textFrom, parts.textTo));
    }
    return;
  }
  if (parts.textFrom > node.from) {
    pushAtomicRange(ranges, atomicRanges, HIDE, node.from, parts.textFrom);
  }
  if (safe && parts.textFrom < parts.textTo) {
    ranges.push(linkMark(safe).range(parts.textFrom, parts.textTo));
  }
  if (parts.textTo < node.to) {
    pushAtomicRange(ranges, atomicRanges, HIDE, parts.textTo, node.to);
  }
}
function decorateImage(ranges, atomicRanges, node, doc, sel, references, urlPolicy = defaultUrlPolicy) {
  const parts = parseLink(node, doc, references);
  if (!parts) return;
  const alt = doc.sliceString(parts.textFrom, parts.textTo);
  const safe = urlPolicy(parts.url);
  const revealed = selectionTouchesLineRange(doc, sel, node.from, node.to);
  if (revealed) {
    muteLinkSyntax(ranges, parts);
    return;
  }
  if (!safe) return;
  pushAtomicRange(
    ranges,
    atomicRanges,
    Decoration.replace({ widget: new ImageWidget(safe, alt) }),
    node.from,
    node.to
  );
}
function decorateAutolink(ranges, atomicRanges, node, doc, sel, urlPolicy = defaultUrlPolicy) {
  let urlNode = null;
  const marks = [];
  for (const child of children(node)) {
    if (child.name === "URL") urlNode = child;
    else if (child.name === "LinkMark") marks.push(child);
  }
  if (!urlNode) return;
  const url = doc.sliceString(urlNode.from, urlNode.to);
  const safe = urlPolicy(url);
  if (!safe) return;
  ranges.push(linkMark(safe).range(urlNode.from, urlNode.to));
  const revealed = selectionTouchesLineRange(doc, sel, node.from, node.to);
  for (const m of marks) {
    pushRevealableMark(ranges, atomicRanges, revealed, m.from, m.to);
  }
}
function decorateBareUrl(ranges, node, doc, urlPolicy = defaultUrlPolicy) {
  const url = doc.sliceString(node.from, node.to);
  const safe = urlPolicy(url);
  if (!safe) return;
  ranges.push(linkMark(safe).range(node.from, node.to));
}
function decorateLinkReference(ranges, atomicRanges, node, doc, sel) {
  if (selectionTouchesLineRange(doc, sel, node.from, node.to)) return;
  const startLine = doc.lineAt(node.from);
  const endLine = doc.lineAt(node.to);
  if (startLine.from === endLine.from) {
    pushAtomicRange(ranges, atomicRanges, HIDE, startLine.from, endLine.to);
  } else {
    pushAtomicRange(ranges, atomicRanges, HIDE, node.from, node.to);
  }
}
function linkMark(href) {
  return Decoration.mark({
    class: "sd-link",
    attributes: { "data-href": href }
  });
}
function closestHrefElement(target) {
  return target instanceof Element ? target.closest("[data-href]") : null;
}
const linkClickHandler = EditorView.domEventHandlers({
  click(event) {
    if (!(event.metaKey || event.ctrlKey)) return false;
    const link = closestHrefElement(event.target);
    if (!link) return false;
    const href = link.getAttribute("data-href");
    if (!href) return false;
    window.open(href, "_blank", "noopener,noreferrer");
    event.preventDefault();
    return true;
  }
});
const HR_LINE = Decoration.line({ class: "sd-hr" });
const HR_LINE_RENDERED = Decoration.line({ class: "sd-hr sd-hr-rendered" });
function decorateHorizontalRule(ranges, atomicRanges, node, doc, sel) {
  const line = doc.lineAt(node.from);
  const revealed = selectionTouchesLineRange(doc, sel, node.from, node.to);
  if (revealed) {
    ranges.push(HR_LINE.range(line.from));
    return;
  }
  ranges.push(HR_LINE_RENDERED.range(line.from));
  pushAtomicRange(ranges, atomicRanges, HIDE, node.from, node.to);
}
const BLOCK_LINE = Decoration.line({ class: "sd-code-block" });
const BLOCK_LINE_FIRST = Decoration.line({ class: "sd-code-block sd-code-block-first" });
const BLOCK_LINE_LAST = Decoration.line({ class: "sd-code-block sd-code-block-last" });
const BLOCK_LINE_ONLY = Decoration.line({
  class: "sd-code-block sd-code-block-first sd-code-block-last"
});
function decorateFencedCode(ranges, atomicRanges, node, doc, sel) {
  const startLine = doc.lineAt(node.from);
  const endLine = doc.lineAt(node.to);
  const lineCount = endLine.number - startLine.number + 1;
  for (let n = startLine.number; n <= endLine.number; n++) {
    const line = doc.line(n);
    const deco = lineCount === 1 ? BLOCK_LINE_ONLY : n === startLine.number ? BLOCK_LINE_FIRST : n === endLine.number ? BLOCK_LINE_LAST : BLOCK_LINE;
    ranges.push(deco.range(line.from));
  }
  const revealed = selectionTouchesLineRange(doc, sel, node.from, node.to);
  if (revealed) return;
  const openMark = firstChildNamed(node, "CodeMark");
  if (openMark) {
    const openLine = doc.lineAt(openMark.from);
    pushAtomicRange(ranges, atomicRanges, HIDE, openLine.from, openLine.to);
  }
  const closeMark = lastChildNamed(node, "CodeMark");
  if (closeMark && closeMark !== openMark) {
    const closeLine = doc.lineAt(closeMark.from);
    pushAtomicRange(ranges, atomicRanges, HIDE, closeLine.from, closeLine.to);
  }
}
const INLINE_NODES = /* @__PURE__ */ new Set(["Emphasis", "StrongEmphasis", "InlineCode", "Strikethrough"]);
const HEADING_NODES = /* @__PURE__ */ new Set([
  "ATXHeading1",
  "ATXHeading2",
  "ATXHeading3",
  "ATXHeading4",
  "ATXHeading5",
  "ATXHeading6"
]);
function silkdownPlugin(opts = {}) {
  const disabled = new Set(opts.disable ?? []);
  const urlPolicy = opts.urlPolicy;
  return ViewPlugin.fromClass(
    class {
      constructor(view) {
        const built = this.build(view);
        this.decorations = built.decorations;
        this.atomicDecorations = built.atomicDecorations;
      }
      update(u) {
        if (u.view.composing) return;
        if (u.docChanged || u.viewportChanged || u.selectionSet || syntaxTree(u.startState) !== syntaxTree(u.state)) {
          const built = this.build(u.view);
          this.decorations = built.decorations;
          this.atomicDecorations = built.atomicDecorations;
        }
      }
      build(view) {
        const ranges = [];
        const atomicRanges = [];
        const tree = syntaxTree(view.state);
        const sel = view.state.selection;
        const doc = view.state.doc;
        const references = buildLinkReferences(tree, doc);
        for (const { from, to } of view.visibleRanges) {
          tree.iterate({
            from,
            to,
            enter: (n) => {
              if (disabled.has(n.name)) return false;
              if (HEADING_NODES.has(n.name)) {
                decorateHeading(ranges, atomicRanges, n.node, doc, sel);
                return false;
              }
              if (INLINE_NODES.has(n.name)) {
                decorateInline(ranges, atomicRanges, n.node, doc, sel);
              }
              if (n.name === "Blockquote") {
                decorateBlockquote(ranges, atomicRanges, n.node, doc, sel);
              }
              if (n.name === "ListItem") {
                decorateListItem(ranges, atomicRanges, n.node, doc);
              }
              if (n.name === "Link") {
                decorateLink(ranges, atomicRanges, n.node, doc, sel, references, urlPolicy);
                return false;
              }
              if (n.name === "Image") {
                decorateImage(ranges, atomicRanges, n.node, doc, sel, references, urlPolicy);
                return false;
              }
              if (n.name === "Autolink") {
                decorateAutolink(ranges, atomicRanges, n.node, doc, sel, urlPolicy);
                return false;
              }
              if (n.name === "URL") {
                decorateBareUrl(ranges, n.node, doc, urlPolicy);
                return false;
              }
              if (n.name === "LinkReference") {
                decorateLinkReference(ranges, atomicRanges, n.node, doc, sel);
                return false;
              }
              if (n.name === "HorizontalRule") {
                decorateHorizontalRule(ranges, atomicRanges, n.node, doc, sel);
                return false;
              }
              if (n.name === "FencedCode") {
                decorateFencedCode(ranges, atomicRanges, n.node, doc, sel);
              }
            }
          });
        }
        return {
          decorations: Decoration.set(ranges, true),
          atomicDecorations: Decoration.set(atomicRanges, true)
        };
      }
    },
    {
      decorations: (v) => v.decorations,
      provide: (p) => EditorView.atomicRanges.of((view) => view.plugin(p)?.atomicDecorations ?? Decoration.none)
    }
  );
}
function findAncestor(state, pos, name) {
  let node = syntaxTree(state).resolveInner(pos, 0);
  while (node) {
    if (node.name === name) return node;
    node = node.parent;
  }
  return null;
}
function toggleInline(nodeName, marker) {
  return (view) => {
    const { state } = view;
    if (state.readOnly) return false;
    const len = marker.length;
    const tr = state.changeByRange((range) => {
      const enclosing = findAncestor(state, range.from, nodeName);
      const stillInside = enclosing && range.to >= enclosing.from && range.to <= enclosing.to;
      if (stillInside && enclosing.firstChild && enclosing.lastChild) {
        const open = enclosing.firstChild;
        const close = enclosing.lastChild;
        const openLen = open.to - open.from;
        const closeLen = close.to - close.from;
        const shift = (pos) => {
          let p = pos;
          if (p > open.from) p -= Math.min(openLen, p - open.from);
          if (p > close.from - openLen) p -= Math.min(closeLen, p - (close.from - openLen));
          return p;
        };
        return {
          changes: [
            { from: open.from, to: open.to, insert: "" },
            { from: close.from, to: close.to, insert: "" }
          ],
          range: EditorSelection.range(shift(range.from), shift(range.to))
        };
      }
      let from = range.from;
      let to = range.to;
      if (from === to) {
        const word = state.wordAt(from);
        if (word) {
          from = word.from;
          to = word.to;
        }
      }
      const newSelection = from === to ? EditorSelection.cursor(from + len) : EditorSelection.range(from + len, to + len);
      return {
        changes: [
          { from, insert: marker },
          { from: to, insert: marker }
        ],
        range: newSelection
      };
    });
    view.dispatch(state.update(tr, { scrollIntoView: true, userEvent: "format.silkdown" }));
    return true;
  };
}
const markdownKeymap = Prec.high(
  keymap.of([
    { key: "Enter", run: insertNewlineContinueMarkup },
    { key: "Mod-b", run: toggleInline("StrongEmphasis", "**") },
    { key: "Mod-i", run: toggleInline("Emphasis", "*") },
    { key: "Mod-`", run: toggleInline("InlineCode", "`") }
  ])
);
const baseTheme = EditorView.baseTheme({
  ".sd-strong": { fontWeight: "700" },
  ".sd-em": { fontStyle: "italic" },
  ".sd-strike": { textDecoration: "line-through" },
  ".sd-code": {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace",
    fontSize: "0.95em",
    backgroundColor: "var(--silkdown-code-bg, rgba(135, 131, 120, 0.15))",
    padding: "0.1em 0.3em",
    borderRadius: "3px"
  }
});
function silkdown(opts = {}) {
  const { codeLanguages = languages, ...pluginOpts } = opts;
  return [
    markdown({
      base: markdownLanguage,
      codeLanguages,
      addKeymap: false
    }),
    silkdownPlugin(pluginOpts),
    history(),
    keymap.of(historyKeymap),
    EditorView.lineWrapping,
    EditorState.allowMultipleSelections.of(true),
    linkClickHandler,
    markdownKeymap,
    baseTheme
  ];
}
export {
  baseTheme,
  defaultUrlPolicy,
  markdownKeymap,
  safeUrl,
  silkdown,
  silkdownPlugin
};
//# sourceMappingURL=index.js.map
