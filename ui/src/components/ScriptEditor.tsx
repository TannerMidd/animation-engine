import { useEffect, useRef } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { StreamLanguage, HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';

/**
 * Script editor.
 *
 * The highlighting is the point: the format's rules are entirely about what a
 * *line* is — a cue, a parenthetical, a beat — so colouring by line kind turns
 * "did that parse as I meant?" into something you can see without running the
 * checker.
 */

const fountain = StreamLanguage.define<{ afterCue: boolean }>({
  startState: () => ({ afterCue: false }),
  token(stream, state) {
    if (stream.sol()) {
      if (stream.match(/^\s*$/)) {
        state.afterCue = false;
        stream.skipToEnd();
        return null;
      }
      if (stream.match(/^\/\/.*/)) return 'comment';
      if (stream.match(/^#+.*/)) return 'heading';
      if (stream.match(/^\[\s*BEAT[^\]]*\]\s*$/i)) return 'meta';
      if (stream.match(/^(INT|EXT|EST|I\/E)[.\s].*/i)) {
        state.afterCue = false;
        return 'heading';
      }
      if (state.afterCue && stream.match(/^\(.*\)\s*$/)) return 'string';

      // A cue: all caps, no lowercase, short, on its own line.
      const line = stream.string.trim();
      if (line.length <= 40 && /[A-Z]/.test(line) && !/[a-z]/.test(line)) {
        state.afterCue = true;
        stream.skipToEnd();
        return 'keyword';
      }
      if (!state.afterCue) {
        stream.skipToEnd();
        return 'literal';
      }
    }
    stream.next();
    return null;
  },
});

const highlight = HighlightStyle.define([
  { tag: tags.comment, color: '#6b737d', fontStyle: 'italic' },
  { tag: tags.heading, color: '#8fa5b8', fontWeight: 'bold' },
  { tag: tags.meta, color: '#c8834a', fontWeight: 'bold' },
  { tag: tags.keyword, color: '#e6c07a', fontWeight: 'bold' },
  { tag: tags.string, color: '#7fa96a', fontStyle: 'italic' },
  // Action lines: present, but visually recessive against dialogue.
  { tag: tags.literal, color: '#8b929c' },
]);

const theme = EditorView.theme(
  {
    '&': { backgroundColor: 'transparent', color: '#e6e3dc' },
    '.cm-content': { caretColor: '#c8834a', padding: '10px 0' },
    '.cm-cursor': { borderLeftColor: '#c8834a' },
    '.cm-gutters': { backgroundColor: 'transparent', color: '#4d545d', border: 'none' },
    '.cm-activeLine': { backgroundColor: 'rgba(255,255,255,0.028)' },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: '#7c848e' },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
      backgroundColor: 'rgba(200,131,74,0.22)',
    },
  },
  { dark: true },
);

export function ScriptEditor({
  value, onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!host.current) return;

    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        history(),
        drawSelection(),
        highlightActiveLine(),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        fountain,
        syntaxHighlighting(highlight),
        theme,
        EditorView.lineWrapping,
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChangeRef.current(u.state.doc.toString());
        }),
      ],
    });

    const editor = new EditorView({ state, parent: host.current });
    view.current = editor;
    return () => {
      editor.destroy();
      view.current = null;
    };
    // Created once. External value changes are reconciled below rather than by
    // rebuilding, which would drop the cursor and undo history on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    const current = editor.state.doc.toString();
    if (current === value) return;
    editor.dispatch({ changes: { from: 0, to: current.length, insert: value } });
  }, [value]);

  return <div ref={host} className="h-full overflow-auto" />;
}
