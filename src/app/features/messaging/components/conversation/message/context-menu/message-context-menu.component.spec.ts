import {describe, expect, it} from 'vitest';
import {buildMessageMenuItems, MessageMenuAbilities} from './message-context-menu.component';

function abilities(overrides: Partial<MessageMenuAbilities> = {}): MessageMenuAbilities {
    return {
        isOwn: false,
        canPin: false,
        isPinned: false,
        canCreateThread: false,
        threadId: null,
        label: (key: string) => key,
        onReply: () => {},
        onThread: () => {},
        onCopyText: () => {},
        onTogglePin: () => {},
        onEdit: () => {},
        onDelete: () => {},
        onReport: () => {},
    } satisfies MessageMenuAbilities;
}

function labelsOf(overrides: Partial<MessageMenuAbilities> = {}): (string | undefined)[] {
    return buildMessageMenuItems({...abilities(), ...overrides}).map(item => item.label);
}

describe('buildMessageMenuItems', () => {
    it('offers Create Thread when the caller may start one', () => {
        expect(labelsOf({canCreateThread: true})).toContain('THREAD.CREATE');
    });

    it('offers Go to Thread instead once the message has one', () => {
        const labels = labelsOf({canCreateThread: true, threadId: 'chan_t'});

        expect(labels).toContain('THREAD.GO_TO');
        expect(labels).not.toContain('THREAD.CREATE');
    });

    it('offers Go to Thread even when the caller may not create one', () => {
        expect(labelsOf({threadId: 'chan_t'})).toContain('THREAD.GO_TO');
    });

    it('offers neither without the permission and without a thread', () => {
        const labels = labelsOf();

        expect(labels).not.toContain('THREAD.CREATE');
        expect(labels).not.toContain('THREAD.GO_TO');
    });

    it('never offers edit or delete on someone elses message', () => {
        const labels = labelsOf({isOwn: false});

        expect(labels).not.toContain('COMMON.EDIT');
        expect(labels).not.toContain('COMMON.DELETE');
    });

    it('never offers report on your own message', () => {
        expect(labelsOf({isOwn: true})).not.toContain('REPORT.TITLE_MESSAGE');
    });

    it('offers unpin on a pinned message and pin on an unpinned one', () => {
        expect(labelsOf({canPin: true, isPinned: true})).toContain('MESSAGE.UNPIN');
        expect(labelsOf({canPin: true, isPinned: false})).toContain('MESSAGE.PIN');
    });

    it('hides pinning without the permission', () => {
        const labels = labelsOf({canPin: false});

        expect(labels).not.toContain('MESSAGE.PIN');
        expect(labels).not.toContain('MESSAGE.UNPIN');
    });

    it('always offers reply and copy', () => {
        const labels = labelsOf();

        expect(labels).toContain('MESSAGE.REPLY');
        expect(labels).toContain('MESSAGE.COPY_TEXT');
    });

    it('runs the handler the item was built with', () => {
        let replied = false;
        const items = buildMessageMenuItems({...abilities(), onReply: () => (replied = true)});

        items.find(item => item.label === 'MESSAGE.REPLY')?.command?.({} as never);

        expect(replied).toBe(true);
    });
});
