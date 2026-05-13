import { Component, computed, ElementRef, inject, input, output, signal, viewChild } from '@angular/core';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import { catchError, debounceTime, map, of, switchMap } from 'rxjs';
import { Button } from 'primeng/button';
import { MessageDto } from '../../../../../dtos/response/message.dto';
import { CommandDef, COMMANDS } from './commands';
import { detectTrigger, EmojiSuggestion, getMessage, MentionCandidate } from './composer-utils';
import { buildHighlightedFragment, getEditorSegments, getTextCursorOffset, restoreCursorOffset } from './composer-markdown';
import { SuggestionOverlayComponent } from './suggestion-overlay/suggestion-overlay.component';
import { EmojiPickerButtonComponent } from './emoji-picker-button/emoji-picker-button.component';
import { GifPickerButtonComponent } from './gif-picker-button/gif-picker-button.component';
import { GifService } from '../../../../../services/gif.service';
import { EmojiDataService } from '../../../../../services/emoji-data.service';
import { ComposerAttachmentsService } from './composer-attachments.service';
import { AttachmentPreviewsComponent } from './attachment-previews/attachment-previews.component';
import { GuildService } from '../../../../../services/guild.service';
import {ProfileService} from "../../../../../services/profile.service";

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
  private readonly  profileService = inject(ProfileService);
  private readonly guildService = inject(GuildService);

  // ── Inputs / Outputs ─────────────────────────────────────────────────────

  /** Set when composing in a guild channel — drives async member search. */
  guildId = input<string | null>(null);
  /** Set when composing in a DM/group conversation — filtered synchronously. */
  conversationMembers = input<MentionCandidate[]>([]);
  replyTo = input<MessageDto | null>(null);
  message = output<{ content: string; attachments: string[]; inReplyTo?: string; mentions: string[] }>();
  cancelReply = output<void>();
  commandAction = output<{ name: string; payload?: unknown }>();
  typing = output<void>();

  replyAuthorName = computed(() => {
    const msg = this.replyTo();
    if (!msg) return '';
    if (msg.authorId === this.profileService.ownProfile()?.userId) return 'yourself';
    return this.profileService.getCachedByUserId(msg.authorId)?.userName ?? 'Unknown';
  });

  replySnippet = computed(() => {
    const msg = this.replyTo();
    if (!msg) return '';
    try {
      const bytes = Uint8Array.from(atob(msg.content), c => c.charCodeAt(0));
      return new TextDecoder().decode(bytes).slice(0, 60);
    } catch { return ''; }
  });

  // ── View ─────────────────────────────────────────────────────────────────

  editorRef = viewChild.required<ElementRef<HTMLDivElement>>('editor');
  fileInputRef = viewChild.required<ElementRef<HTMLInputElement>>('fileInput');
  gifPickerRef = viewChild(GifPickerButtonComponent);

  // ── Overlay state ────────────────────────────────────────────────────────

  isEmpty = signal(true);

  overlayType = signal<'mention' | 'command' | 'emoji' | null>(null);
  query = signal('');
  selectedIndex = signal(0);

  private commandAtStart = signal(false);

  // ── Active command (global, awaiting params) ──────────────────────────────

  activeCommand = signal<CommandDef | null>(null);

  // ── Guild member search (async, debounced) ────────────────────────────────

  private readonly _queryStream = toObservable(this.query);

  private readonly guildSearchResults = toSignal(
    this._queryStream.pipe(
      debounceTime(200),
      switchMap(q => {
        const gid = this.guildId();
        if (!gid || this.overlayType() !== 'mention') return of<MentionCandidate[]>([]);
        return this.guildService.searchMembers(gid, q).pipe(
          map(members => members
            .filter(m => m.profile)
            .map(m => ({
              userId: m.userId,
              userName: m.profile!.userName,
              hash: m.profile!.hash,
              avatarUrl: m.profile?.avatarUrl,
            }))
          ),
          catchError(() => of<MentionCandidate[]>([]))
        );
      }),
    ),
    { initialValue: [] as MentionCandidate[] }
  );

  // ── Filtered suggestions ──────────────────────────────────────────────────

  filteredMentions = computed<MentionCandidate[]>(() => {
    if (this.overlayType() !== 'mention') return [];
    const q = this.query().toLowerCase();
    if (this.guildId()) {
      return this.guildSearchResults();
    }
    return this.conversationMembers()
      .filter(m => m.userName.toLowerCase().includes(q))
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
    if (this.overlayType() === 'mention') return this.filteredMentions();
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

  // ── Typing throttle ───────────────────────────────────────────────────────

  private typingThrottle: ReturnType<typeof setTimeout> | null = null;

  // ── Trigger range ─────────────────────────────────────────────────────────

  private triggerRange: Range | null = null;
  private savedEmojiOffset = 0;

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
    this.savedEmojiOffset = getTextCursorOffset(editor);
    this.isEmpty.set((editor.textContent ?? '').trim() === '' && !editor.querySelector('.mention-chip'));

    // Auto-replace :shortcode: on closing colon
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
      const range = sel.getRangeAt(0);
      const node = range.startContainer;
      if (node.nodeType === Node.TEXT_NODE) {
        const textBefore = (node.textContent ?? '').slice(0, range.startOffset);
        const autoMatch = textBefore.match(/(?:^|[^\w]):([\w-]+):$/);
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

    this.emitTypingIfNeeded(editor);

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

  private emitTypingIfNeeded(editor: HTMLElement): void {
    const hasContent = getMessage(editor).trim().length > 0;
    if (!hasContent || this.typingThrottle !== null) return;
    this.typing.emit();
    this.typingThrottle = setTimeout(() => { this.typingThrottle = null; }, 2000);
  }

  focus(): void {
    this.editorRef().nativeElement.focus();
  }

  private insertNewline(): void {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    range.deleteContents();
    const br = document.createElement('br');
    range.insertNode(br);
    range.setStartAfter(br);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
    this.onInput();
  }

  private applyMarkdownHighlighting(editor: HTMLElement): void {
    const offset = getTextCursorOffset(editor);
    const segments = getEditorSegments(editor);
    const frag = buildHighlightedFragment(segments);
    editor.innerHTML = '';
    editor.appendChild(frag);
    // Browsers don't render a trailing <br> as a visible new line unless there
    // is content after it. Add a sentinel so the cursor can visually land on
    // the new line after Shift+Enter.
    const last = editor.lastChild;
    if (last instanceof HTMLElement && last.tagName === 'BR' && (editor.textContent ?? '').length > 0) {
      const sentinel = document.createElement('br');
      sentinel.dataset['sentinel'] = '1';
      editor.appendChild(sentinel);
    }
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

    if (event.key === 'Escape' && this.activeCommand()) {
      event.preventDefault();
      this.activeCommand.set(null);
      const editor = this.editorRef().nativeElement;
      editor.innerHTML = '';
      this.isEmpty.set(true);
      return;
    }

    if (event.key === 'Enter' && event.shiftKey) { event.preventDefault(); this.insertNewline(); return; }
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
    this.savedEmojiOffset = getTextCursorOffset(this.editorRef().nativeElement);
  }

  onEditorClick(): void {
    this.savedEmojiOffset = getTextCursorOffset(this.editorRef().nativeElement);
  }

  // ── Mention handling ──────────────────────────────────────────────────────

  onMentionSelected(candidate: MentionCandidate): void {
    if (!this.triggerRange) return;

    this.triggerRange.deleteContents();

    const chip = document.createElement('span');
    chip.className = 'mention-chip';
    chip.contentEditable = 'false';
    chip.dataset['userId'] = candidate.userId;
    chip.dataset['display'] = `@${candidate.userName}#${candidate.hash}`;
    chip.textContent = `@${candidate.userName}`;

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
        if (result.text) this.message.emit({ content: result.text, attachments: [], mentions: [] });
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
    this.message.emit({ content: url, attachments: [], mentions: [] });
  }

  // ── Emoji picker handling ─────────────────────────────────────────────────

  onEmojiSelected(emoji: string): void {
    const editor = this.editorRef().nativeElement;
    editor.focus();
    restoreCursorOffset(editor, this.savedEmojiOffset);

    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    range.deleteContents();
    const node = document.createTextNode(emoji);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
    this.savedEmojiOffset += [...emoji].length;
  }

  // ── Send ─────────────────────────────────────────────────────────────────

  send(): void {
    if (this.typingThrottle !== null) { clearTimeout(this.typingThrottle); this.typingThrottle = null; }
    const editor = this.editorRef().nativeElement;
    let text = this.emojiData.resolveShortcodes(getMessage(editor));

    const cmd = this.activeCommand();
    if (cmd) {
      const result = cmd.execute(text);
      this.activeCommand.set(null);
      if (result.action) this.dispatchAction(result.action);
      text = result.text ?? '';
    }

    const attachments = this.attachments.flushAndClear();
    const mentions = Array.from(editor.querySelectorAll<HTMLElement>('.mention-chip'))
      .map(c => c.dataset['userId'] ?? '')
      .filter(Boolean);

    if (text || attachments.length > 0) {
      this.message.emit({ content: text, attachments, inReplyTo: this.replyTo()?.id, mentions });
    }

    editor.innerHTML = '';
    this.isEmpty.set(true);
    this.closeOverlay();
    editor.focus();
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private confirmSelection(): void {
    const idx = this.selectedIndex();
    if (this.overlayType() === 'mention') {
      const f = this.filteredMentions()[idx];
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
    if (action.name === 'open-gif-picker-with-search') {
      const query = (action.payload as { query: string }).query;
      this.gifPickerRef()?.openWithSearch(query);
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
