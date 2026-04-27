import { Component, computed, ElementRef, input, output, signal, viewChild } from '@angular/core';
import { Button } from 'primeng/button';
import { RelationshipModel, RelationshipStatus } from '../../../../friendship/components/friendship-modal/dto/relationship.model';
import { CommandDef, COMMANDS } from './commands';
import { detectTrigger, getMessage } from './composer-utils';
import { SuggestionOverlayComponent } from './suggestion-overlay/suggestion-overlay.component';
import { EmojiPickerButtonComponent } from './emoji-picker-button/emoji-picker-button.component';
import { GifPickerButtonComponent } from './gif-picker-button/gif-picker-button.component';

@Component({
  selector: 'app-composer',
  imports: [Button, SuggestionOverlayComponent, EmojiPickerButtonComponent, GifPickerButtonComponent],
  templateUrl: './composer.component.html',
  styleUrl: './composer.component.css',
})
export class ComposerComponent {

  // ── Inputs / Outputs ─────────────────────────────────────────────────────

  friends = input<RelationshipModel[]>([]);
  message = output<string>();

  // ── View ─────────────────────────────────────────────────────────────────

  editorRef = viewChild.required<ElementRef<HTMLDivElement>>('editor');

  // ── Overlay state ────────────────────────────────────────────────────────

  overlayType = signal<'mention' | 'command' | null>(null);
  query = signal('');
  selectedIndex = signal(0);

  // ── Active command ────────────────────────────────────────────────────────

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
    return COMMANDS.filter(c => c.name.startsWith(q));
  });

  overlayItems = computed<unknown[]>(() =>
    this.overlayType() === 'mention' ? this.filteredFriends() : this.filteredCommands()
  );

  placeholder = computed(() => {
    const cmd = this.activeCommand();
    if (!cmd) return 'Message';
    const paramHints = cmd.params.map(p => p.required ? `<${p.label}>` : `[${p.label}]`).join(' ');
    return `/${cmd.name} ${paramHints} — press Enter to send`;
  });

  // ── Trigger range (saved for replacement on selection) ────────────────────

  private triggerRange: Range | null = null;

  // ── Saved cursor for emoji insertion ─────────────────────────────────────

  private savedEmojiRange: Range | null = null;

  // ── Input events ─────────────────────────────────────────────────────────

  onInput(): void {
    const editor = this.editorRef().nativeElement;
    const result = detectTrigger(editor);
    if (result) {
      this.overlayType.set(result.type);
      this.query.set(result.query);
      this.selectedIndex.set(0);
      this.triggerRange = result.range;
    } else {
      this.closeOverlay();
    }
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
    const space = document.createTextNode('\u00a0');
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
    editor.innerHTML = '';

    if (cmd.params.length === 0) {
      this.message.emit(cmd.execute(''));
    } else {
      this.activeCommand.set(cmd);
    }

    this.closeOverlay();
    editor.focus();
  }

  // ── GIF handling ──────────────────────────────────────────────────────────

  onGifSelected(url: string): void {
    this.message.emit(url);
  }

  // ── Emoji handling ────────────────────────────────────────────────────────

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
    if (!text) return;

    const cmd = this.activeCommand();
    if (cmd) { text = cmd.execute(text); this.activeCommand.set(null); }

    this.message.emit(text);
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
    } else {
      const c = this.filteredCommands()[idx];
      if (c) this.onCommandSelected(c);
    }
  }

  private closeOverlay(): void {
    this.overlayType.set(null);
    this.query.set('');
    this.triggerRange = null;
  }
}
