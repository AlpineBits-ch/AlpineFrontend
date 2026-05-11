import {
  AfterViewInit,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  input,
  OnDestroy,
  output,
  signal,
  ViewChild,
} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {Button} from 'primeng/button';
import {Select} from 'primeng/select';
import {Checkbox} from 'primeng/checkbox';
import {Editor} from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import Underline from '@tiptap/extension-underline';
import {Table} from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableHeader from '@tiptap/extension-table-header';
import TableCell from '@tiptap/extension-table-cell';
import {marked} from 'marked';
import {WikiDto, WikiPageDto} from '../../../../../dtos/response/wiki.dto';
import {WikiService} from '../../../../../services/wiki.service';

function contentToHtml(content: string): string {
  if (!content) return '';
  if (content.trimStart().startsWith('<')) return content;
  return marked.parse(content) as string;
}

@Component({
  selector: 'app-wiki-editor',
  imports: [FormsModule, Button, Select, Checkbox],
  templateUrl: './wiki-editor.component.html',
  styleUrl: './wiki-editor.component.css',
})
export class WikiEditorComponent implements AfterViewInit, OnDestroy {
  readonly page = input<WikiPageDto | null>(null);
  readonly wiki = input<WikiDto | null>(null);
  readonly guildId = input.required<string>();

  readonly saved = output<WikiPageDto>();
  readonly cancelled = output<void>();

  @ViewChild('editorEl') editorEl?: ElementRef<HTMLDivElement>;
  @ViewChild('linkInputEl') linkInputEl?: ElementRef<HTMLInputElement>;

  private readonly wikiService = inject(WikiService);

  // ── Form state ─────────────────────────────────────────────────────────────
  protected editorTitle = signal('');
  protected editorContent = signal('');
  protected editorCategoryId = signal<string | undefined>(undefined);
  protected editorParentPageId = signal<string | undefined>(undefined);
  protected editorTags = signal<string[]>([]);
  protected editorIsPinned = signal(false);
  protected editorTagInput = signal('');
  protected saving = signal(false);

  // ── Toolbar active state ───────────────────────────────────────────────────
  protected isBold = signal(false);
  protected isItalic = signal(false);
  protected isUnderline = signal(false);
  protected isH1 = signal(false);
  protected isH2 = signal(false);
  protected isH3 = signal(false);
  protected isBulletList = signal(false);
  protected isOrderedList = signal(false);
  protected isBlockquote = signal(false);
  protected isCode = signal(false);
  protected isCodeBlock = signal(false);

  // ── Link input ─────────────────────────────────────────────────────────────
  protected linkInputVisible = signal(false);
  protected linkUrl = signal('');

  private tiptapEditor?: Editor;
  private editorReady = false;

  constructor() {
    effect(() => {
      const page = this.page();
      this.editorTitle.set(page?.title ?? '');
      const html = contentToHtml(page?.content ?? '');
      this.editorContent.set(html);
      this.editorCategoryId.set(page?.categoryId);
      this.editorParentPageId.set(page?.parentPageId);
      this.editorTags.set(page ? [...page.tags] : []);
      this.editorIsPinned.set(page?.isPinned ?? false);
      this.editorTagInput.set('');
      this.linkInputVisible.set(false);

      if (this.editorReady && this.tiptapEditor) {
        this.tiptapEditor.commands.setContent(html || '');
      }
    });
  }

  ngAfterViewInit(): void {
    if (!this.editorEl) return;
    this.tiptapEditor = new Editor({
      element: this.editorEl.nativeElement,
      extensions: [
        StarterKit,
        Underline,
        Link.configure({openOnClick: false}),
        Placeholder.configure({placeholder: 'Start writing…'}),
        Table.configure({resizable: false}),
        TableRow,
        TableHeader,
        TableCell,
      ],
      content: this.editorContent() || '',
      onUpdate: ({editor}) => {
        this.editorContent.set(editor.getHTML());
        this.syncToolbar();
      },
      onSelectionUpdate: () => this.syncToolbar(),
    });
    this.editorReady = true;
  }

  ngOnDestroy(): void {
    this.tiptapEditor?.destroy();
  }

  private syncToolbar(): void {
    if (!this.tiptapEditor) return;
    this.isBold.set(this.tiptapEditor.isActive('bold'));
    this.isItalic.set(this.tiptapEditor.isActive('italic'));
    this.isUnderline.set(this.tiptapEditor.isActive('underline'));
    this.isH1.set(this.tiptapEditor.isActive('heading', {level: 1}));
    this.isH2.set(this.tiptapEditor.isActive('heading', {level: 2}));
    this.isH3.set(this.tiptapEditor.isActive('heading', {level: 3}));
    this.isBulletList.set(this.tiptapEditor.isActive('bulletList'));
    this.isOrderedList.set(this.tiptapEditor.isActive('orderedList'));
    this.isBlockquote.set(this.tiptapEditor.isActive('blockquote'));
    this.isCode.set(this.tiptapEditor.isActive('code'));
    this.isCodeBlock.set(this.tiptapEditor.isActive('codeBlock'));
  }

  // ── Toolbar actions ────────────────────────────────────────────────────────
  protected toggleBold(): void { this.tiptapEditor?.chain().focus().toggleBold().run(); }
  protected toggleItalic(): void { this.tiptapEditor?.chain().focus().toggleItalic().run(); }
  protected toggleUnderline(): void { this.tiptapEditor?.chain().focus().toggleUnderline().run(); }
  protected toggleH1(): void { this.tiptapEditor?.chain().focus().toggleHeading({level: 1}).run(); }
  protected toggleH2(): void { this.tiptapEditor?.chain().focus().toggleHeading({level: 2}).run(); }
  protected toggleH3(): void { this.tiptapEditor?.chain().focus().toggleHeading({level: 3}).run(); }
  protected toggleBulletList(): void { this.tiptapEditor?.chain().focus().toggleBulletList().run(); }
  protected toggleOrderedList(): void { this.tiptapEditor?.chain().focus().toggleOrderedList().run(); }
  protected toggleBlockquote(): void { this.tiptapEditor?.chain().focus().toggleBlockquote().run(); }
  protected toggleCode(): void { this.tiptapEditor?.chain().focus().toggleCode().run(); }
  protected toggleCodeBlock(): void { this.tiptapEditor?.chain().focus().toggleCodeBlock().run(); }
  protected insertHR(): void { this.tiptapEditor?.chain().focus().setHorizontalRule().run(); }
  protected insertTable(): void {
    this.tiptapEditor?.chain().focus().insertTable({rows: 3, cols: 3, withHeaderRow: true}).run();
  }
  protected undo(): void { this.tiptapEditor?.chain().focus().undo().run(); }
  protected redo(): void { this.tiptapEditor?.chain().focus().redo().run(); }

  protected openLinkInput(): void {
    const existing = this.tiptapEditor?.getAttributes('link')?.['href'] ?? '';
    this.linkUrl.set(existing);
    this.linkInputVisible.set(true);
    setTimeout(() => this.linkInputEl?.nativeElement.focus(), 0);
  }

  protected applyLink(): void {
    const url = this.linkUrl().trim();
    if (url) {
      this.tiptapEditor?.chain().focus().setLink({href: url}).run();
    } else {
      this.tiptapEditor?.chain().focus().unsetLink().run();
    }
    this.linkInputVisible.set(false);
  }

  // ── Tags ───────────────────────────────────────────────────────────────────
  protected addTag(): void {
    const tag = this.editorTagInput().trim().replace(/,/g, '');
    if (!tag || this.editorTags().includes(tag)) {
      this.editorTagInput.set('');
      return;
    }
    this.editorTags.update(tags => [...tags, tag]);
    this.editorTagInput.set('');
  }

  protected onTagInputKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      this.addTag();
    } else if (event.key === 'Backspace' && !this.editorTagInput()) {
      this.editorTags.update(tags => tags.slice(0, -1));
    }
  }

  protected removeTag(tag: string): void {
    this.editorTags.update(tags => tags.filter(t => t !== tag));
  }

  // ── Computed ───────────────────────────────────────────────────────────────
  protected categoryOptions = computed(() => [
    {label: 'No Category', value: undefined},
    ...(this.wiki()?.categories ?? []).map(c => ({label: c.name, value: c.id})),
  ]);

  protected parentPageOptions = computed(() => {
    const editingId = this.page()?.id;
    return [
      {label: 'No Parent', value: undefined},
      ...(this.wiki()?.pages ?? [])
        .filter(p => p.id !== editingId && !p.parentPageId)
        .map(p => ({label: p.title, value: p.id})),
    ];
  });

  // ── Save ───────────────────────────────────────────────────────────────────
  protected savePage(): void {
    if (this.saving() || !this.editorTitle().trim()) return;
    this.saving.set(true);
    const base = {
      title: this.editorTitle().trim(),
      content: this.editorContent(),
      tags: this.editorTags(),
      isPinned: this.editorIsPinned(),
    };
    const editingId = this.page()?.id;
    const obs = editingId
      ? this.wikiService.updatePage(this.guildId(), editingId, {
          ...base,
          categoryId: this.editorCategoryId() ?? null,
          parentPageId: this.editorParentPageId() ?? null,
        })
      : this.wikiService.createPage(this.guildId(), {
          ...base,
          categoryId: this.editorCategoryId(),
          parentPageId: this.editorParentPageId(),
        });

    obs.subscribe({
      next: page => {
        this.saving.set(false);
        this.saved.emit(page);
      },
      error: () => this.saving.set(false),
    });
  }
}
