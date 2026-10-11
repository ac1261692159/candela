import { useMemo } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { sql } from '@codemirror/lang-sql';
import { EditorView, keymap } from '@codemirror/view';
import { Prec } from '@codemirror/state';

interface SqlReportEditorProps {
  value: string;
  onChange: (v: string) => void;
  readOnly?: boolean;
  onRun?: () => void;
}

/** 编辑器扩展（稳定引用，避免每次渲染重建 editor） */
function useEditorExtensions(onRun?: () => void, readOnly?: boolean) {
  return useMemo(() => {
    const exts = [
      sql(),
      EditorView.lineWrapping,
      EditorView.theme({
        '&': { fontSize: '13px', backgroundColor: '#fff' },
        '.cm-content': { fontFamily: "SFMono-Regular,Consolas,'Liberation Mono',Menlo,Courier,monospace" },
        '.cm-gutters': { backgroundColor: '#fafafa', border: 'none' },
        '.cm-activeLine': { backgroundColor: 'rgba(22,119,255,0.04)' },
        '.cm-activeLineGutter': { backgroundColor: 'rgba(22,119,255,0.06)' },
        '&.cm-focused': { outline: 'none' },
      }),
    ];
    if (onRun) {
      // 高优先级 keymap：Cmd/Ctrl+Enter 执行（阻止 CodeMirror 默认换行）
      exts.push(
        Prec.highest(
          keymap.of([
            {
              key: 'Mod-Enter',
              preventDefault: true,
              run: () => {
                onRun();
                return true;
              },
            },
          ]),
        ),
      );
    }
    return exts;
  }, [onRun, readOnly]);
}

/**
 * SQL 编辑器（CodeMirror 6）：语法高亮、行号、活动行高亮、自动括号匹配。
 * Cmd/Ctrl+Enter 执行查询。
 */
export function SqlReportEditor({ value, onChange, readOnly, onRun }: SqlReportEditorProps) {
  const extensions = useEditorExtensions(onRun, readOnly);

  return (
    <div style={{ height: '100%', minHeight: 200, border: '1px solid #d9d9d9', borderRadius: 6, overflow: 'hidden' }}>
      <CodeMirror
        value={value}
        height="100%"
        style={{ height: '100%' }}
        theme="light"
        extensions={extensions}
        editable={!readOnly}
        basicSetup={{
          lineNumbers: true,
          highlightActiveLine: true,
          foldGutter: false,
          autocompletion: false,
          highlightSelectionMatches: false,
        }}
        onChange={onChange}
      />
    </div>
  );
}
