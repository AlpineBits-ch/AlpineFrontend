import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {provideHttpClientTesting} from '@angular/common/http/testing';
import {provideTranslateService} from '@ngx-translate/core';
import {MessageService} from 'primeng/api';
import {of, throwError} from 'rxjs';
import {describe, expect, it, vi} from 'vitest';

import {CreateThreadDialogComponent} from './create-thread-dialog.component';
import {ThreadRegistryService} from '../../../../../services/thread-registry.service';
import {ToastService} from '../../../../../services/toast.service';
import {MessageDto} from '../../../../../dtos/response/message.dto';
import {MessageType} from '../../../../../enums/message-type.enum';
import {MessageEncryptionState} from '../../../../../enums/message-encryption-state.enum';

function starterFixture(text: string, overrides: Partial<MessageDto> = {}): MessageDto {
    return {
        id: 'mesg_1',
        createdAt: new Date('2026-08-19T00:00:00Z'),
        updatedAt: new Date('2026-08-19T00:00:00Z'),
        content: btoa(text),
        channelId: 'chan_parent',
        conversationId: undefined,
        authorId: 'u1',
        isPending: false,
        isFailed: false,
        attachments: [],
        inReplyTo: undefined,
        mentions: [],
        encryptionState: MessageEncryptionState.Plain,
        mlsEpoch: undefined,
        mlsSequenceNumber: undefined,
        senderDeviceId: undefined,
        type: MessageType.Message,
        ...overrides,
    };
}

async function setup(result: 'ok' | '409' | 'error' = 'ok') {
    TestBed.resetTestingModule();
    const registry = {
        createFromMessage: vi.fn(() => {
            if (result === 'error') return throwError(() => ({status: 500}));
            return of(result === '409' ? 'chan_existing' : 'chan_new');
        }),
    };
    const toastService = {httpError: vi.fn()};

    await TestBed.configureTestingModule({
        imports: [CreateThreadDialogComponent],
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            provideTranslateService({defaultLanguage: 'en'}),
            MessageService,
            {provide: ThreadRegistryService, useValue: registry},
            {provide: ToastService, useValue: toastService},
        ],
    }).compileComponents();

    const fixture: ComponentFixture<CreateThreadDialogComponent> =
        TestBed.createComponent(CreateThreadDialogComponent);
    fixture.componentRef.setInput('channelId', 'chan_parent');
    return {fixture, component: fixture.componentInstance, registry, toastService};
}

function open(fixture: ComponentFixture<CreateThreadDialogComponent>, starter: MessageDto | null): void {
    fixture.componentRef.setInput('starter', starter);
    fixture.componentRef.setInput('visible', true);
    fixture.detectChanges();
}

describe('CreateThreadDialogComponent', () => {
    it('prefills the name from the first few words of the starter', async () => {
        const {fixture, component} = await setup();

        open(fixture, starterFixture('the deployment broke again and nobody knows why'));

        expect(component.name()).toBe('the deployment broke again and');
    });

    it('leaves the name blank when the starter cannot be read', async () => {
        const {fixture, component} = await setup();

        open(fixture, starterFixture('', {undecryptable: true}));

        expect(component.name()).toBe('');
    });

    it('emits the new thread id on success', async () => {
        const {fixture, component, registry} = await setup('ok');
        let emitted: string | null = null;
        component.created.subscribe((id: string) => (emitted = id));

        open(fixture, starterFixture('hello'));
        component.submit();

        expect(registry.createFromMessage).toHaveBeenCalledWith('chan_parent', 'mesg_1', {name: 'hello'});
        expect(emitted).toBe('chan_new');
    });

    it('sends the optional first message when one was typed', async () => {
        const {fixture, component, registry} = await setup('ok');

        open(fixture, starterFixture('hello'));
        component.firstMessage.set('  first reply  ');
        component.submit();

        expect(registry.createFromMessage).toHaveBeenCalledWith('chan_parent', 'mesg_1', {
            name: 'hello',
            content: 'first reply',
        });
    });

    it('emits the existing thread id on a 409 without a toast', async () => {
        const {fixture, component, registry, toastService} = await setup('409');
        let emitted: string | null = null;
        component.created.subscribe((id: string) => (emitted = id));

        open(fixture, starterFixture('hello'));
        component.submit();

        expect(registry.createFromMessage).toHaveBeenCalledOnce();
        expect(emitted).toBe('chan_existing');
        expect(toastService.httpError).not.toHaveBeenCalled();
    });

    it('reports a real failure and stays open', async () => {
        const {fixture, component, toastService} = await setup('error');

        open(fixture, starterFixture('hello'));
        component.submit();

        expect(toastService.httpError).toHaveBeenCalledOnce();
        expect(component.visible()).toBe(true);
    });

    it('refuses to submit an empty name', async () => {
        const {fixture, component, registry} = await setup();

        open(fixture, starterFixture('hello'));
        component.name.set('   ');
        component.submit();

        expect(registry.createFromMessage).not.toHaveBeenCalled();
    });

    it('refuses to submit without a starter', async () => {
        const {fixture, component, registry} = await setup();

        open(fixture, null);
        component.name.set('a name');
        component.submit();

        expect(registry.createFromMessage).not.toHaveBeenCalled();
    });
});
