import { Component, computed, ElementRef, inject, input, output, signal, viewChild } from '@angular/core';
import { Button } from 'primeng/button';
import { RelationshipModel, RelationshipStatus } from '../../../../friendship/components/friendship-modal/dto/relationship.model';
import { CommandDef, COMMANDS } from './commands';
import { detectTrigger, EmojiSuggestion, getMessage } from './composer-utils';
import { buildHighlightedFragment, getEditorSegments, getTextCursorOffset, restoreCursorOffset } from './composer-markdown';
import { SuggestionOverlayComponent } from './suggestion-overlay/suggestion-overlay.component';
import { EmojiPickerButtonComponent } from './emoji-picker-button/emoji-picker-button.component';
import { GifPickerButtonComponent } from './gif-picker-button/gif-picker-button.component';
import { GifService } from '../../../../../services/gif.service';
import { EmojiDataService } from '../../../../../services/emoji-data.service';
import { ComposerAttachmentsService } from './composer-attachments.service';
import { AttachmentPreviewsComponent } from './attachment-previews/attachment-previews.component';

@Component({
  selector: 'app-composer',
  imports: [Button, SuggestionOverlayComponent, EmojiPickerButtonComponent, GifPickerButtonComponent, AttachmentPreviewsComponent],
  templateUrl: './composer.component.html',
  styleUrl: './composer.component.css',
  providers: [ComposerAttachmentsService],
})
export class ComposerComponent {
  protected readonly attachments = inject(ComposerAttachmentsService);
  private readonly emojiData = inject(EmojiDataService);
  private readonly gifService = inject(GifService);

  // ── Inputs / Outputs ─────────────────────────────────────────────────────

  friends = input<RelationshipModel[]>([]);
  message = output<{ content: string; attachments: string[] }>();
  commandAction = output<{ name: string; payload?: unknown }>();

  // ── View ─────────────────────────────────────────────────────────────────

  editorRef = viewChild.required<ElementRef<HTMLDivElement>>('editor');
  fileInputRef = viewChild.required<ElementRef<HTMLInputElement>>('fileInput');
  gifPickerRef = viewChild(GifPickerButtonComponent);

  // ── Overlay state ────────────────────────────────────────────────────────

  overlayType = signal<'mention' | 'command' | 'emoji' | null>(null);
  query = signal('');
  selectedIndex = signal(0);

  private commandAtStart = signal(false);

  // ── Active command (global, awaiting params) ──────────────────────────────

  activeCommand = signal<CommandDef | null>(null);

  // ── Filtered suggestions ──────────────────────────────────────────────────

  filteredFriends = computed(() => {
    if (this.overlayType() !== 'mention') return [];
    const q = this.query().toLowerCase();
    return this.friends()
      .filter(f => f.status === RelationshipStatus.Friends)
      .filter(f => f.target.userName.toLowerCase().includes(q))
      .slice(0, 8);
  });

  filteredCommands = computed(() => {
    if (this.overlayType() !== 'command') return [];
    const q = this.query().toLowerCase();
    const atStart = this.commandAtStart();
    return COMMANDS
      .filter(c => atStart || c.scope === 'inline')
      .filter(c => c.name.startsWith(q));
  });

  filteredEmojis = signal<EmojiSuggestion[]>([]);

  overlayItems = computed<unknown[]>(() => {
    if (this.overlayType() === 'mention') return this.filteredFriends();
    if (this.overlayType() === 'command') return this.filteredCommands();
    if (this.overlayType() === 'emoji') return this.filteredEmojis();
    return [];
  });

  placeholder = computed(() => {
    const cmd = this.activeCommand();
    if (!cmd) return 'Message';
    const paramHints = cmd.params.map(p => p.required ? `<${p.label}>` : `[${p.label}]`).join(' ');
    return paramHints ? `/${cmd.name} ${paramHints} — press Enter to send` : `/${cmd.name} — press Enter to send`;
  });

  // ── Trigger range ─────────────────────────────────────────────────────────

  private triggerRange: Range | null = null;
  private savedEmojiRange: Range | null = null;

  // ── File input ────────────────────────────────────────────────────────────

  onAttachClick(): void {
    this.fileInputRef().nativeElement.click();
  }

  onFileInputChange(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (input.files) {
      for (const file of Array.from(input.files)) this.attachments.attach(file);
    }
    input.value = '';
  }

  // ── Input events ─────────────────────────────────────────────────────────

  onInput(): void {
    const editor = this.editorRef().nativeElement;

    // Auto-replace :shortcode: on closing colon
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
      const range = sel.getRangeAt(0);
      const node = range.startContainer;
      if (node.nodeType === Node.TEXT_NODE) {
        const textBefore = (node.textContent ?? '').slice(0, range.startOffset);
        const autoMatch = textBefore.match(/(?:^|[\s ]):(\w+):$/);
        if (autoMatch) {
          const native = this.emojiData.resolveOne(autoMatch[1]);
          if (native) {
            const colonPos = textBefore.lastIndexOf(':', range.startOffset - 2);
            const r = document.createRange();
            r.setStart(node as Text, colonPos);
            r.setEnd(node as Text, range.startOffset);
            r.deleteContents();
            const textNode = document.createTextNode(native);
            r.insertNode(textNode);
            const newRange = document.createRange();
            newRange.setStartAfter(textNode);
            newRange.collapse(true);
            sel.removeAllRanges();
            sel.addRange(newRange);
            this.closeOverlay();
            return;
          }
        }
      }
    }

    const result = detectTrigger(editor);
    if (result) {
      this.overlayType.set(result.type);
      this.query.set(result.query);
      this.selectedIndex.set(0);
      this.triggerRange = result.range;

      if (result.type === 'command') this.commandAtStart.set(result.atStart);
      if (result.type === 'emoji') this.filteredEmojis.set(this.emojiData.search(result.query));
    } else {
      this.closeOverlay();
      this.applyMarkdownHighlighting(editor);
    }
  }

  private applyMarkdownHighlighting(editor: HTMLElement): void {
    const offset = getTextCursorOffset(editor);
    const segments = getEditorSegments(editor);
    const frag = buildHighlightedFragment(segments);
    editor.innerHTML = '';
    editor.appendChild(frag);
    restoreCursorOffset(editor, offset);
  }

  onKeydown(event: KeyboardEvent): void {
    const isOpen = this.overlayType() !== null && this.overlayItems().length > 0;

    if (isOpen) {
      if (event.key === 'ArrowDown') { event.preventDefault(); this.selectedIndex.update(i => Math.min(i + 1, this.overlayItems().length - 1)); return; }
      if (event.key === 'ArrowUp')   { event.preventDefault(); this.selectedIndex.update(i => Math.max(i - 1, 0)); return; }
      if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); this.confirmSelection(); return; }
      if (event.key === 'Escape') { event.preventDefault(); this.closeOverlay(); return; }
    }

    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); this.send(); }
  }

  onPaste(event: ClipboardEvent): void {
    const items = event.clipboardData?.items;
    if (items) {
      for (const item of Array.from(items)) {
        if (item.type.startsWith('image/')) {
          event.preventDefault();
          const file = item.getAsFile();
          if (file) this.attachments.attach(file);
          return;
        }
      }
    }
    event.preventDefault();
    const text = event.clipboardData?.getData('text/plain') ?? '';
    document.execCommand('insertText', false, text);
  }

  onEditorFocus(): void {
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
      this.savedEmojiRange = sel.getRangeAt(0).cloneRange();
    }
  }

  onEditorClick(): void {
    this.onEditorFocus();
  }

  // ── Mention handling ──────────────────────────────────────────────────────

  onMentionSelected(friend: RelationshipModel): void {
    if (!this.triggerRange) return;

    this.triggerRange.deleteContents();

    const chip = document.createElement('span');
    chip.className = 'mention-chip';
    chip.contentEditable = 'false';
    chip.dataset['userId'] = friend.targetId;
    chip.dataset['display'] = `@${friend.target.userName}#${friend.target.hash}`;
    chip.textContent = `@${friend.target.userName}`;

    this.triggerRange.insertNode(chip);
    const space = document.createTextNode(' ');
    chip.after(space);

    const sel = window.getSelection();
    if (sel) {
      const r = document.createRange();
      r.setStartAfter(space);
      r.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r);
    }

    this.closeOverlay();
    this.editorRef().nativeElement.focus();
  }

  // ── Command handling ──────────────────────────────────────────────────────

  onCommandSelected(cmd: CommandDef): void {
    const editor = this.editorRef().nativeElement;
    const isInline = !this.commandAtStart() || cmd.scope === 'inline';

    if (isInline) {
      if (this.triggerRange) {
        const result = cmd.execute('');
        this.triggerRange.deleteContents();
        if (result.text) {
          const textNode = document.createTextNode(result.text);
          this.triggerRange.insertNode(textNode);
          const sel = window.getSelection();
          if (sel) {
            const r = document.createRange();
            r.setStartAfter(textNode);
            r.collapse(true);
            sel.removeAllRanges();
            sel.addRange(r);
          }
        }
        if (result.action) this.dispatchAction(result.action);
      }
      this.closeOverlay();
      editor.focus();
    } else {
      editor.innerHTML = '';
      if (cmd.params.length === 0) {
        const result = cmd.execute('');
        if (result.text) this.message.emit({ content: result.text, attachments: [] });
        if (result.action) this.dispatchAction(result.action);
      } else {
        this.activeCommand.set(cmd);
      }
      this.closeOverlay();
      editor.focus();
    }
  }

  // ── Emoji shortcode overlay selection ─────────────────────────────────────

  onEmojiShortcodeSelected(emoji: EmojiSuggestion): void {
    if (!this.triggerRange) return;

    this.triggerRange.deleteContents();
    const textNode = document.createTextNode(emoji.native);
    this.triggerRange.insertNode(textNode);

    const sel = window.getSelection();
    if (sel) {
      const r = document.createRange();
      r.setStartAfter(textNode);
      r.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r);
    }

    this.closeOverlay();
    this.editorRef().nativeElement.focus();
  }

  // ── GIF handling ──────────────────────────────────────────────────────────

  onGifSelected(url: string): void {
    this.message.emit({ content: url, attachments: [] });
  }

  // ── Emoji picker handling ─────────────────────────────────────────────────

  onEmojiSelected(emoji: string): void {
    const editor = this.editorRef().nativeElement;

    const range = this.savedEmojiRange ?? (() => {
      const r = document.createRange();
      r.selectNodeContents(editor);
      r.collapse(false);
      return r;
    })();

    range.deleteContents();
    const node = document.createTextNode(emoji);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);

    const sel = window.getSelection();
    if (sel) { sel.removeAllRanges(); sel.addRange(range); }

    editor.focus();
  }

  // ── Send ─────────────────────────────────────────────────────────────────

  send(): void {
    let text = getMessage(this.editorRef().nativeElement);

    const cmd = this.activeCommand();
    if (cmd) {
      const result = cmd.execute(text);
      this.activeCommand.set(null);
      if (result.action) this.dispatchAction(result.action);
      text = result.text ?? '';
    }

    const attachments = this.attachments.flushAndClear();

    if (text || attachments.length > 0) {
      this.message.emit({ content: text, attachments });
    }

    this.editorRef().nativeElement.innerHTML = '';
    this.closeOverlay();
    this.editorRef().nativeElement.focus();
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private confirmSelection(): void {
    const idx = this.selectedIndex();
    if (this.overlayType() === 'mention') {
      const f = this.filteredFriends()[idx];
      if (f) this.onMentionSelected(f);
    } else if (this.overlayType() === 'command') {
      const c = this.filteredCommands()[idx];
      if (c) this.onCommandSelected(c);
    } else if (this.overlayType() === 'emoji') {
      const e = this.filteredEmojis()[idx];
      if (e) this.onEmojiShortcodeSelected(e);
    }
  }

  private dispatchAction(action: { name: string; payload?: unknown }): void {
    if (action.name === 'open-gif-picker') {
      this.gifPickerRef()?.open();
      return;
    }
    if (action.name === 'send-gif-search') {
      const query = (action.payload as { query: string }).query;
      this.gifService.search(query).subscribe(results => {
        if (results.length > 0) this.message.emit({ content: results[0].url, attachments: [] });
      });
      return;
    }
    this.commandAction.emit(action);
  }

  private closeOverlay(): void {
    this.overlayType.set(null);
    this.query.set('');
    this.filteredEmojis.set([]);
    this.triggerRange = null;
  }
}
