import {Component, DestroyRef, effect, inject, input, output, OnInit, signal} from '@angular/core';
import {takeUntilDestroyed} from '@angular/core/rxjs-interop';
import {FormsModule} from '@angular/forms';
import {Button} from 'primeng/button';
import {InputText} from 'primeng/inputtext';
import {Dialog} from 'primeng/dialog';
import {ChannelDto} from '../../../../../dtos/response/guild.dto';
import {GuildService} from '../../../../../services/guild.service';
import {GuildWebsocketService} from '../../../../../services/guild-websocket.service';
import {ToastService} from '../../../../../services/toast.service';
import {PrimeTemplate} from "primeng/api";

@Component({
    selector: 'app-thread-panel',
    imports: [Button, InputText, Dialog, FormsModule, PrimeTemplate],
    templateUrl: './thread-panel.component.html',
})
export class ThreadPanelComponent implements OnInit {
    readonly parentChannelId = input.required<string>();
    threadSelected = output<ChannelDto>();
    readonly threads = signal<ChannelDto[]>([]);
    readonly loading = signal(true);
    readonly showCreateDialog = signal(false);
    readonly createName = signal('');
    readonly creating = signal(false);
    readonly archivingId = signal<string | null>(null);
    private guildService = inject(GuildService);
    private guildWsService = inject(GuildWebsocketService);
    private toastService = inject(ToastService);
    private destroyRef = inject(DestroyRef);

    constructor() {
        effect(() => {
            this.parentChannelId();
            this.load();
        });
    }

    ngOnInit(): void {
        this.guildWsService.threadCreatedObservable
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe(e => {
                if (e.parentChannelId !== this.parentChannelId()) return;
                this.load();
            });
    }

    load(): void {
        this.loading.set(true);
        this.guildService.getThreads(this.parentChannelId()).subscribe({
            next: threads => {
                this.threads.set(threads);
                this.loading.set(false);
            },
            error: err => {
                this.loading.set(false);
                this.toastService.httpError('Failed to load threads', err);
            },
        });
    }

    createThread(): void {
        const name = this.createName().trim();
        if (!name || this.creating()) return;
        this.creating.set(true);
        this.guildService.createThread(this.parentChannelId(), {name}).subscribe({
            next: thread => {
                this.threads.update(list => [thread, ...list]);
                this.showCreateDialog.set(false);
                this.createName.set('');
                this.creating.set(false);
                this.threadSelected.emit(thread);
            },
            error: err => {
                this.creating.set(false);
                this.toastService.httpError('Failed to create thread', err);
            },
        });
    }

    archive(thread: ChannelDto): void {
        if (this.archivingId()) return;
        this.archivingId.set(thread.id);
        this.guildService.archiveThread(thread.id).subscribe({
            next: () => {
                this.threads.update(list => list.filter(t => t.id !== thread.id));
                this.archivingId.set(null);
            },
            error: err => {
                this.archivingId.set(null);
                this.toastService.httpError('Failed to archive thread', err);
            },
        });
    }
}
