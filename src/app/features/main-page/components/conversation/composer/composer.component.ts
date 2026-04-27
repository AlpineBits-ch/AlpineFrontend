import { Component, computed, ElementRef, input, OnDestroy, output, signal, viewChild } from '@angular/core';
import { Button } from 'primeng/button';
import { Avatar } from 'primeng/avatar';
import { RelationshipModel, RelationshipStatus } from '../../../../friendship/components/friendship-modal/dto/relationship.model';
import { NgClass } from '@angular/common';

interface CommandDef {
  name: string;
  description: string;
  params: { label: string; required: boolean }[];
  execute: (params: string) => string;
}

const COMMANDS: CommandDef[] = [
  {
    name: 'shrug',
    description: 'Append a shrug to your message',
    params: [{ label: 'message', required: false }],
    execute: (text) => text ? `${text} ¯\\_(ツ)_/¯` : '¯\\_(ツ)_/¯',
  },
];

@Component({
  selector: 'app-composer',
  imports: [Button, Avatar, NgClass],
  templateUrl: './composer.component.html',
  styleUrl: './composer.component.css',
})
export class ComposerComponent implements OnDestroy {

  // ── Inputs / Outputs ─────────────────────────────────────────────────────

  friends = input<RelationshipModel[]>([]);
  message = output<string>();

  // ── View ─────────────────────────────────────────────────────────────────

  editorRef = viewChild.required<ElementRef<HTMLDivElement>>('editor');
  pickerContainerRef = viewChild<ElementRef<HTMLDivElement>>('pickerContainer');

  // ── Overlay state ────────────────────────────────────────────────────────

  overlayType = signal<'mention' | 'command' | null>(null);
  query = signal('');
  selectedIndex = signal(0);
  showEmojiPicker = signal(false);

  // ── Active command (user selected a command, now entering params) ─────────

  activeCommand = signal<CommandDef | null>(null);

  // ── Suggestions ──────────────────────────────────────────────────────────

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

  protected readonly commands = COMMANDS;

  // ── Emoji picker ─────────────────────────────────────────────────────────

  private pickerInstance: HTMLElement | null = null;
  /** Saved cursor range — captured when the emoji button is clicked */
  private savedEmojiRange: Range | null = null;
  private outsideClickListener: ((e: MouseEvent) => void) | null = null;

  async toggleEmojiPicker(): Promise<void> {
    if (this.showEmojiPicker()) {
      this.closeEmojiPicker();
      return;
    }

    // Save cursor before the editor loses focus
    const sel = window.getSelection();
    this.savedEmojiRange = sel && sel.rangeCount > 0 ? sel.getRangeAt(0).cloneRange() : null;

    // Lazy-create and append picker on first open
    if (!this.pickerInstance) {
      const [{ Picker }, data] = await Promise.all([
        import('emoji-mart'),
        import('@emoji-mart/data'),
      ]);

      this.pickerInstance = new Picker({
        data: data.default ?? data,
        theme: 'dark',
        previewPosition: 'none',
        skinTonePosition: 'none',
        onEmojiSelect: (emoji: { native: string }) => this.insertEmoji(emoji.native),
      }) as unknown as HTMLElement;

      const container = this.pickerContainerRef()?.nativeElement;
      if (container) container.appendChild(this.pickerInstance);
    }

    this.showEmojiPicker.set(true);

    // Close on outside click (deferred so this click doesn't immediately close it)
    setTimeout(() => {
      this.outsideClickListener = (e: MouseEvent) => {
        const container = this.pickerContainerRef()?.nativeElement;
        if (container && !container.contains(e.target as Node)) {
          this.closeEmojiPicker();
        }
      };
      document.addEventListener('mousedown', this.outsideClickListener);
    }, 0);
  }

  private insertEmoji(emoji: string): void {
    const editor = this.editorRef().nativeElement;

    // Use saved cursor range or fall back to end of editor
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
    if (sel) {
      sel.removeAllRanges();
      sel.addRange(range);
    }

    editor.focus();
    this.closeEmojiPicker();
  }

  private closeEmojiPicker(): void {
    this.showEmojiPicker.set(false);
    if (this.outsideClickListener) {
      document.removeEventListener('mousedown', this.outsideClickListener);
      this.outsideClickListener = null;
    }
  }

  ngOnDestroy(): void {
    this.closeEmojiPicker();
  }

  // ── Trigger detection ────────────────────────────────────────────────────

  /** Saved range covering the trigger text (@query or /query) to replace on selection */
  private triggerRange: Range | null = null;

  onInput(): void {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;

    const range = sel.getRangeAt(0);
    const node = range.startContainer;

    if (node.nodeType !== Node.TEXT_NODE) {
      this.closeOverlay();
      return;
    }

    const textBefore = (node.textContent ?? '').slice(0, range.startOffset);

    // Mention: @ preceded by whitespace/start, followed by word chars
    const mentionMatch = textBefore.match(/(?:^|[\s\u00a0])@(\w*)$/);
    if (mentionMatch) {
      this.overlayType.set('mention');
      this.query.set(mentionMatch[1]);
      this.selectedIndex.set(0);
      const atPos = textBefore.lastIndexOf('@');
      this.saveTriggerRange(node as Text, atPos, range.startOffset);
      return;
    }

    // Command: / only when the entire editor content is /word (nothing else)
    const editorText = this.getEditorPlainText();
    const commandMatch = editorText.match(/^\/(\w*)$/);
    if (commandMatch) {
      this.overlayType.set('command');
      this.query.set(commandMatch[1]);
      this.selectedIndex.set(0);
      this.saveTriggerRange(node as Text, 0, range.startOffset);
      return;
    }

    this.closeOverlay();
  }

  private saveTriggerRange(node: Text, start: number, end: number): void {
    const r = document.createRange();
    r.setStart(node, start);
    r.setEnd(node, end);
    this.triggerRange = r;
  }

  // ── Keyboard handling ────────────────────────────────────────────────────

  onKeydown(event: KeyboardEvent): void {
    const isOpen = this.overlayType() !== null && this.overlayItems().length > 0;

    if (isOpen) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        this.selectedIndex.update(i => Math.min(i + 1, this.overlayItems().length - 1));
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        this.selectedIndex.update(i => Math.max(i - 1, 0));
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        this.confirmSelection();
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        this.closeOverlay();
        return;
      }
    }

    if (event.key === 'Escape' && this.showEmojiPicker()) {
      this.closeEmojiPicker();
      return;
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.send();
    }
  }

  private confirmSelection(): void {
    const idx = this.selectedIndex();
    if (this.overlayType() === 'mention') {
      const friend = this.filteredFriends()[idx];
      if (friend) this.selectMention(friend);
    } else if (this.overlayType() === 'command') {
      const cmd = this.filteredCommands()[idx];
      if (cmd) this.selectCommand(cmd);
    }
  }

  // ── Mention selection ────────────────────────────────────────────────────

  selectMention(friend: RelationshipModel): void {
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

  // ── Command selection ────────────────────────────────────────────────────

  selectCommand(cmd: CommandDef): void {
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

  // ── Message extraction ───────────────────────────────────────────────────

  private getMessage(): string {
    const editor = this.editorRef().nativeElement;
    let text = '';

    const walk = (nodes: NodeList) => {
      nodes.forEach(node => {
        if (node.nodeType === Node.TEXT_NODE) {
          text += node.textContent ?? '';
        } else if (node instanceof HTMLElement) {
          if (node.classList.contains('mention-chip')) {
            text += node.dataset['display'] ?? node.textContent ?? '';
          } else if (node.tagName === 'BR') {
            text += '\n';
          } else if (node.tagName === 'DIV') {
            text += '\n';
            walk(node.childNodes);
          } else {
            walk(node.childNodes);
          }
        }
      });
    };

    walk(editor.childNodes);
    return text.replace(/\u00a0/g, ' ').trim();
  }

  private getEditorPlainText(): string {
    return this.editorRef().nativeElement.textContent ?? '';
  }

  // ── Send ─────────────────────────────────────────────────────────────────

  send(): void {
    let text = this.getMessage();
    if (!text) return;

    const cmd = this.activeCommand();
    if (cmd) {
      text = cmd.execute(text);
      this.activeCommand.set(null);
    }

    this.message.emit(text);
    this.editorRef().nativeElement.innerHTML = '';
    this.closeOverlay();
    this.editorRef().nativeElement.focus();
  }

  // ── Paste ────────────────────────────────────────────────────────────────

  onPaste(event: ClipboardEvent): void {
    event.preventDefault();
    const text = event.clipboardData?.getData('text/plain') ?? '';
    document.execCommand('insertText', false, text);
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private closeOverlay(): void {
    this.overlayType.set(null);
    this.query.set('');
    this.triggerRange = null;
  }

  protected readonly RelationshipStatus = RelationshipStatus;
}
