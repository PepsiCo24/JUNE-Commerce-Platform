'use client';

import { Color } from '@tiptap/extension-color';
import Highlight from '@tiptap/extension-highlight';
import { Table } from '@tiptap/extension-table';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import TableRow from '@tiptap/extension-table-row';
import TaskItem from '@tiptap/extension-task-item';
import TaskList from '@tiptap/extension-task-list';
import TextAlign from '@tiptap/extension-text-align';
import { TextStyle } from '@tiptap/extension-text-style';
import Underline from '@tiptap/extension-underline';
import { Image } from '@tiptap/extension-image';
import { Link } from '@tiptap/extension-link';
import { Placeholder } from '@tiptap/extension-placeholder';
import type { Editor, Extensions } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  ChevronDown,
  Code,
  Eraser,
  Heading1,
  Heading2,
  Heading3,
  Highlighter,
  ImagePlus,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  ListTodo,
  Minus,
  Palette,
  Quote,
  Redo2,
  Strikethrough,
  Table as TableIcon,
  Underline as UnderlineIcon,
  Undo2,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** 编辑器扩展集合,供 useEditor 复用 */
export function buildEditorExtensions(): Extensions {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      link: false,
      codeBlock: {},
    }),
    Underline,
    TextStyle,
    Color,
    Highlight.configure({ multicolor: true }),
    TextAlign.configure({ types: ['heading', 'paragraph'] }),
    Link.configure({
      openOnClick: false,
      autolink: true,
      defaultProtocol: 'https',
      HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: '_blank' },
    }),
    Image.configure({ inline: false, allowBase64: false }),
    Placeholder.configure({ placeholder: '写下你想分享的内容…' }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Table.configure({ resizable: false }),
    TableRow,
    TableHeader,
    TableCell,
  ];
}

export function countEditorStats(html: string): { chars: number; readingMinutes: number } {
  const text = html.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
  const chars = text.length;
  const readingMinutes = Math.max(1, Math.ceil(chars / 400));
  return { chars, readingMinutes };
}

interface EditorToolbarProps {
  editor: Editor | null;
  onAddImage: () => void;
  onAddLink: () => void;
  className?: string;
}

export function EditorToolbar({
  editor,
  onAddImage,
  onAddLink,
  className,
}: EditorToolbarProps): React.JSX.Element {
  const [moreOpen, setMoreOpen] = useState(false);
  const composingRef = useRef(false);

  useEffect(() => {
    const onStart = (): void => {
      composingRef.current = true;
    };
    const onEnd = (): void => {
      composingRef.current = false;
    };
    document.addEventListener('compositionstart', onStart);
    document.addEventListener('compositionend', onEnd);
    return () => {
      document.removeEventListener('compositionstart', onStart);
      document.removeEventListener('compositionend', onEnd);
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (composingRef.current) return;
      const mod = event.metaKey || event.ctrlKey;
      if (!mod) return;
      if (event.key === 's') {
        event.preventDefault();
        window.dispatchEvent(new CustomEvent('june:editor-save-draft'));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const run = useCallback(
    (fn: () => void) => {
      if (!editor) return;
      fn();
    },
    [editor],
  );

  const disabled = !editor;

  return (
    <div
      className={cn(
        'sticky top-14 z-40 flex flex-wrap items-center gap-0.5 rounded-lg border border-border-default bg-bg-elevated/95 p-1.5 shadow-sm backdrop-blur',
        className,
      )}
      role="toolbar"
      aria-label="编辑工具栏"
    >
      <Group label="历史">
        <TBtn label="撤销 ⌘Z" disabled={disabled || !editor?.can().undo()} onClick={() => run(() => editor!.chain().focus().undo().run())} icon={<Undo2 size={16} />} />
        <TBtn label="重做 ⌘⇧Z" disabled={disabled || !editor?.can().redo()} onClick={() => run(() => editor!.chain().focus().redo().run())} icon={<Redo2 size={16} />} />
      </Group>
      <Sep />
      <Group label="标题">
        <TBtn label="正文" active={editor?.isActive('paragraph') ?? false} disabled={disabled} onClick={() => run(() => editor!.chain().focus().setParagraph().run())} text="正文" />
        <TBtn label="一级标题" active={editor?.isActive('heading', { level: 1 }) ?? false} disabled={disabled} onClick={() => run(() => editor!.chain().focus().toggleHeading({ level: 1 }).run())} icon={<Heading1 size={16} />} />
        <TBtn label="二级标题" active={editor?.isActive('heading', { level: 2 }) ?? false} disabled={disabled} onClick={() => run(() => editor!.chain().focus().toggleHeading({ level: 2 }).run())} icon={<Heading2 size={16} />} />
        <TBtn label="三级标题" active={editor?.isActive('heading', { level: 3 }) ?? false} disabled={disabled} onClick={() => run(() => editor!.chain().focus().toggleHeading({ level: 3 }).run())} icon={<Heading3 size={16} />} />
      </Group>
      <Sep />
      <Group label="格式">
        <TBtn label="加粗 ⌘B" active={editor?.isActive('bold') ?? false} disabled={disabled} onClick={() => run(() => editor!.chain().focus().toggleBold().run())} icon={<Bold size={16} />} />
        <TBtn label="斜体 ⌘I" active={editor?.isActive('italic') ?? false} disabled={disabled} onClick={() => run(() => editor!.chain().focus().toggleItalic().run())} icon={<Italic size={16} />} />
        <TBtn label="下划线 ⌘U" active={editor?.isActive('underline') ?? false} disabled={disabled} onClick={() => run(() => editor!.chain().focus().toggleUnderline().run())} icon={<UnderlineIcon size={16} />} />
        <TBtn label="删除线" active={editor?.isActive('strike') ?? false} disabled={disabled} onClick={() => run(() => editor!.chain().focus().toggleStrike().run())} icon={<Strikethrough size={16} />} />
      </Group>
      <Sep />
      <Group label="列表">
        <TBtn label="无序列表" active={editor?.isActive('bulletList') ?? false} disabled={disabled} onClick={() => run(() => editor!.chain().focus().toggleBulletList().run())} icon={<List size={16} />} />
        <TBtn label="有序列表" active={editor?.isActive('orderedList') ?? false} disabled={disabled} onClick={() => run(() => editor!.chain().focus().toggleOrderedList().run())} icon={<ListOrdered size={16} />} />
        <TBtn label="任务列表" active={editor?.isActive('taskList') ?? false} disabled={disabled} onClick={() => run(() => editor!.chain().focus().toggleTaskList().run())} icon={<ListTodo size={16} />} />
      </Group>
      <Sep />
      <Group label="插入">
        <TBtn label="引用" active={editor?.isActive('blockquote') ?? false} disabled={disabled} onClick={() => run(() => editor!.chain().focus().toggleBlockquote().run())} icon={<Quote size={16} />} />
        <TBtn label="分割线" disabled={disabled} onClick={() => run(() => editor!.chain().focus().setHorizontalRule().run())} icon={<Minus size={16} />} />
        <TBtn label="链接" active={editor?.isActive('link') ?? false} disabled={disabled} onClick={onAddLink} icon={<LinkIcon size={16} />} />
        <TBtn label="代码块" active={editor?.isActive('codeBlock') ?? false} disabled={disabled} onClick={() => run(() => editor!.chain().focus().toggleCodeBlock().run())} icon={<Code size={16} />} />
        <TBtn label="插入图片" disabled={disabled} onClick={onAddImage} icon={<ImagePlus size={16} />} />
      </Group>
      <Sep />
      <Group label="对齐">
        <TBtn label="左对齐" active={editor?.isActive({ textAlign: 'left' }) ?? false} disabled={disabled} onClick={() => run(() => editor!.chain().focus().setTextAlign('left').run())} icon={<AlignLeft size={16} />} />
        <TBtn label="居中" active={editor?.isActive({ textAlign: 'center' }) ?? false} disabled={disabled} onClick={() => run(() => editor!.chain().focus().setTextAlign('center').run())} icon={<AlignCenter size={16} />} />
        <TBtn label="右对齐" active={editor?.isActive({ textAlign: 'right' }) ?? false} disabled={disabled} onClick={() => run(() => editor!.chain().focus().setTextAlign('right').run())} icon={<AlignRight size={16} />} />
      </Group>
      <Sep />
      <div className="relative">
        <Button variant="ghost" size="sm" onClick={() => setMoreOpen((v) => !v)} iconRight={<ChevronDown size={14} />}>
          更多
        </Button>
        {moreOpen ? (
          <div className="absolute right-0 top-full z-50 mt-1 flex min-w-[180px] flex-col gap-0.5 rounded-md border border-border-default bg-bg-elevated p-1 shadow-lg">
            <MoreBtn label="文字颜色" icon={<Palette size={14} />} disabled={disabled} onClick={() => { run(() => editor!.chain().focus().setColor('#0c7e72').run()); setMoreOpen(false); }} />
            <MoreBtn label="背景高亮" icon={<Highlighter size={14} />} disabled={disabled} onClick={() => { run(() => editor!.chain().focus().toggleHighlight({ color: '#cff6f0' }).run()); setMoreOpen(false); }} />
            <MoreBtn label="清除格式" icon={<Eraser size={14} />} disabled={disabled} onClick={() => { run(() => editor!.chain().focus().unsetAllMarks().clearNodes().run()); setMoreOpen(false); }} />
            <MoreBtn label="插入表格 3×3" icon={<TableIcon size={14} />} disabled={disabled} onClick={() => { run(() => editor!.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()); setMoreOpen(false); }} />
            <MoreBtn label="删除表格" icon={<TableIcon size={14} />} disabled={disabled} onClick={() => { run(() => editor!.chain().focus().deleteTable().run()); setMoreOpen(false); }} />
            <MoreBtn label="添加行" icon={<TableIcon size={14} />} disabled={disabled} onClick={() => { run(() => editor!.chain().focus().addRowAfter().run()); setMoreOpen(false); }} />
            <MoreBtn label="添加列" icon={<TableIcon size={14} />} disabled={disabled} onClick={() => { run(() => editor!.chain().focus().addColumnAfter().run()); setMoreOpen(false); }} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Group({ children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return <div className="flex items-center gap-0.5">{children}</div>;
}

function Sep(): React.JSX.Element {
  return <div className="mx-0.5 hidden h-6 w-px bg-border-default sm:block" aria-hidden />;
}

function TBtn({
  label,
  icon,
  text,
  active,
  disabled,
  onClick,
}: {
  label: string;
  icon?: React.ReactNode;
  text?: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active ?? false}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'inline-flex h-8 min-w-8 items-center justify-center rounded-sm px-1.5 text-xs text-fg-muted transition-colors',
        'hover:bg-surface-hover hover:text-fg disabled:pointer-events-none disabled:opacity-40',
        active && 'bg-accent-surface text-accent',
      )}
    >
      {text ?? icon}
    </button>
  );
}

function MoreBtn({
  label,
  icon,
  disabled,
  onClick,
}: {
  label: string;
  icon: React.ReactNode;
  disabled?: boolean;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-fg hover:bg-surface-hover disabled:opacity-40"
    >
      {icon}
      {label}
    </button>
  );
}
