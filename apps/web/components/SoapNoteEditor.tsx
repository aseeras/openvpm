"use client";

import { useEffect, useRef, useState } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Highlight from "@tiptap/extension-highlight";
import { Bold, Italic, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface SoapNoteEditorProps {
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
  className?: string;
}

export function SoapNoteEditor({
  value,
  onChange,
  placeholder = "Enter text here...",
  className,
}: SoapNoteEditorProps) {
  const [isEmpty, setIsEmpty] = useState(!value);
  // The last HTML this editor reported (or was set to). The parent echoes it
  // back as `value`; treating that echo as an external change would push
  // content into the editor again and can loop with editor normalization.
  const lastHtmlRef = useRef(value || "");
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        bulletList: { HTMLAttributes: { class: "list-disc list-inside" } },
        orderedList: { HTMLAttributes: { class: "list-decimal list-inside" } },
        paragraph: { HTMLAttributes: { class: "mb-2" } },
        code: { HTMLAttributes: { class: "bg-muted px-1 rounded text-xs font-mono" } },
        codeBlock: { HTMLAttributes: { class: "bg-muted p-2 rounded text-xs font-mono overflow-x-auto mb-2" } },
      }),
      Highlight.configure({ multicolor: true }),
    ],
    content: value || "",
    onUpdate: ({ editor }) => {
      const html = editor.isEmpty ? "" : editor.getHTML();
      setIsEmpty(editor.isEmpty);
      if (html === lastHtmlRef.current) return;
      lastHtmlRef.current = html;
      onChangeRef.current(html);
    },
    editorProps: {
      attributes: {
        class: cn(
          "prose prose-sm max-w-none focus:outline-none p-3 min-h-32",
          "text-foreground placeholder-muted-foreground",
          className
        ),
      },
    },
  });

  useEffect(() => {
    if (!editor) return;
    const nextValue = value || "";
    // Our own latest output coming back from the parent: nothing to do.
    if (nextValue === lastHtmlRef.current) return;
    const currentValue = editor.isEmpty ? "" : editor.getHTML();
    if (currentValue !== nextValue) {
      editor.commands.setContent(nextValue, { emitUpdate: false });
    }
    // Remember the editor's normalized form so a follow-up update with the
    // same content is not reported back as a new edit.
    lastHtmlRef.current = editor.isEmpty ? "" : editor.getHTML();
    setIsEmpty(editor.isEmpty);
  }, [editor, value]);

  if (!editor) return null;

  const toggleBold = () => editor.chain().focus().toggleBold().run();
  const toggleItalic = () => editor.chain().focus().toggleItalic().run();
  const toggleUnderline = () => editor.chain().focus().toggleUnderline().run();
  const clearFormatting = () => editor.chain().focus().clearNodes().run();

  return (
    <div className="rounded-lg border border-border bg-background overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center gap-1 p-2 border-b border-border bg-muted/50 flex-wrap">
        <div className="flex gap-1">
          <Button
            type="button"
            size="sm"
            variant={editor.isActive("bold") ? "default" : "outline"}
            onClick={toggleBold}
            title="Bold (Ctrl+B)"
            className="h-8 w-8 p-0"
          >
            <Bold className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            size="sm"
            variant={editor.isActive("italic") ? "default" : "outline"}
            onClick={toggleItalic}
            title="Italic (Ctrl+I)"
            className="h-8 w-8 p-0"
          >
            <Italic className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            size="sm"
            variant={editor.isActive("underline") ? "default" : "outline"}
            onClick={toggleUnderline}
            title="Underline (Ctrl+U)"
            className="h-8 w-8 p-0"
          >
            <u className="text-sm font-bold">U</u>
          </Button>
        </div>

        <div className="w-px h-6 bg-border mx-1" />

        <div className="flex gap-1">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => editor.chain().focus().toggleBulletList().run()}
            title="Bullet List"
            className="h-8 px-2 text-xs"
          >
            • List
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => editor.chain().focus().toggleOrderedList().run()}
            title="Ordered List"
            className="h-8 px-2 text-xs"
          >
            1. List
          </Button>
        </div>

        <div className="w-px h-6 bg-border mx-1" />

        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={clearFormatting}
          title="Clear Formatting"
          className="h-8 w-8 p-0"
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>

      {/* Editor */}
      <div className="relative">
        <EditorContent editor={editor} />
        {isEmpty && (
          <div className="pointer-events-none absolute left-3 top-3 text-sm text-muted-foreground">
            {placeholder}
          </div>
        )}
      </div>
    </div>
  );
}
