import {Component, DestroyRef, effect, inject, input, output, signal} from '@angular/core';
import {takeUntilDestroyed} from '@angular/core/rxjs-interop';
import {DatePipe} from '@angular/common';
import {FormsModule} from '@angular/forms';
import {Button} from 'primeng/button';
import {InputText} from 'primeng/inputtext';
import {Textarea} from 'primeng/textarea';
import {Dialog} from 'primeng/dialog';
import {PrimeTemplate} from 'primeng/api';
import {ChannelDto} from '../../../../dtos/response/guild.dto';
import {GuildService} from '../../../../services/guild.service';
import {GuildWebsocketService} from '../../../../services/guild-websocket.service';
import {NavigationService} from '../../../main-page/navigation.service';
import {ToastService} from '../../../../services/toast.service';

@Component({
    selector: 'app-forum-channel',
    imports: [Button, InputText, Textarea, Dialog, FormsModule, PrimeTemplate, DatePipe],
    templateUrl: './forum-channel.component.html',
})
export class ForumChannelComponent {
    channel = input.required<ChannelDto>();
    back = output();

    posts = signal<ChannelDto[]>([]);
    loading = signal(true);
    showCreateDialog = signal(false);
    createName = signal('');
    createContent = signal('');
    creating = signal(false);

    protected navService = inject(NavigationService);
    private guildService = inject(GuildService);
    private guildWsService = inject(GuildWebsocketService);
    private toastService = inject(ToastService);
    private destroyRef = inject(DestroyRef);

    constructor() {
        effect(() => {
            this.channel().id;
            this.load();
        });

        this.guildWsService.threadCreatedObservable
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe(e => {
                if (e.parentChannelId !== this.channel().id) return;
                this.load();
            });
    }

    load(): void {
        this.loading.set(true);
        this.guildService.getThreads(this.channel().id).subscribe({
            next: posts => {
                this.posts.set(posts);
                this.loading.set(false);
            },
            error: err => {
                this.loading.set(false);
                this.toastService.httpError('Failed to load posts', err);
            },
        });
    }

    openCreateDialog(): void {
        this.createName.set('');
        this.createContent.set('');
        this.showCreateDialog.set(true);
    }

    createPost(): void {
        const name = this.createName().trim();
        if (!name || this.creating()) return;
        this.creating.set(true);
        const content = this.createContent().trim();
        this.guildService.createThread(this.channel().id, {name, content: content || undefined}).subscribe({
            next: post => {
                this.posts.update(list => [post, ...list]);
                this.showCreateDialog.set(false);
                this.creating.set(false);
                this.navService.openChannel(post);
            },
            error: err => {
                this.creating.set(false);
                this.toastService.httpError('Failed to create post', err);
            },
        });
    }

    openPost(post: ChannelDto): void {
        this.navService.openChannel(post);
    }
}
