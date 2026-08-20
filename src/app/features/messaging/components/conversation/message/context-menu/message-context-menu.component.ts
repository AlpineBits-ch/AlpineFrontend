import {ChangeDetectionStrategy, Component, viewChild} from '@angular/core';
import {ContextMenuComponent} from '../../../../../../shared/context-menu/context-menu.component';
import {MenuItem} from '../../../../../../shared/context-menu/context-menu.model';

export interface MessageMenuAbilities {
    isOwn: boolean;
    canPin: boolean;
    isPinned: boolean;
    canCreateThread: boolean;
    threadId: string | null;
    label: (key: string) => string;
    onReply: () => void;
    onThread: () => void;
    onCopyText: () => void;
    onTogglePin: () => void;
    onEdit: () => void;
    onDelete: () => void;
    onReport: () => void;
}

/** A message already carrying a thread offers the way in even to someone who could not have started it. */
export function buildMessageMenuItems(a: MessageMenuAbilities): MenuItem[] {
    const items: MenuItem[] = [{label: a.label('MESSAGE.REPLY'), icon: 'pi pi-reply', command: a.onReply}];

    if (a.threadId) {
        items.push({label: a.label('THREAD.GO_TO'), icon: 'pi pi-comments', command: a.onThread});
    } else if (a.canCreateThread) {
        items.push({label: a.label('THREAD.CREATE'), icon: 'pi pi-comments', command: a.onThread});
    }

    items.push({label: a.label('MESSAGE.COPY_TEXT'), icon: 'pi pi-copy', command: a.onCopyText});

    if (a.canPin) {
        items.push({
            label: a.label(a.isPinned ? 'MESSAGE.UNPIN' : 'MESSAGE.PIN'),
            icon: 'pi pi-thumbtack',
            command: a.onTogglePin,
        });
    }

    items.push({separator: true});

    if (a.isOwn) {
        items.push({label: a.label('COMMON.EDIT'), icon: 'pi pi-pencil', command: a.onEdit});
        items.push({
            label: a.label('COMMON.DELETE'),
            icon: 'pi pi-trash',
            danger: true,
            command: a.onDelete,
        });
    } else {
        items.push({label: a.label('REPORT.TITLE_MESSAGE'), icon: 'pi pi-flag', command: a.onReport});
    }

    return items;
}

@Component({
    selector: 'app-message-context-menu',
    imports: [ContextMenuComponent],
    template: '<app-context-menu #menu />',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MessageContextMenuComponent {
    private readonly menu = viewChild.required<ContextMenuComponent>('menu');

    open(event: MouseEvent, items: MenuItem[]): void {
        this.menu().show(event, items);
    }
}
