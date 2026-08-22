import {
    afterRenderEffect,
    ChangeDetectionStrategy,
    Component,
    computed,
    DestroyRef,
    effect,
    ElementRef,
    inject,
    signal,
    viewChild,
} from '@angular/core';
import {TranslateModule} from '@ngx-translate/core';
import {ProfileDto} from '../../dtos/response/profile.dto';
import {ConversationDto} from '../../dtos/response/conversation.dto';
import {newMessage} from '../../dtos/request/new-message';
import {ProfileService} from '../../services/profile.service';
import {ProfilePopoutService} from '../../services/profile-popout.service';
import {DirectMessageService} from '../../services/direct-message.service';
import {MessagingService} from '../../services/messaging.service';
import {NavigationService} from '../../features/main-page/navigation.service';
import {ProfileHeaderComponent} from '../profile-header/profile-header.component';
import {ProfileActionsComponent} from '../profile-actions/profile-actions.component';
import {ProfileMutualLineComponent} from '../profile-mutual-line/profile-mutual-line.component';
import {ProfileCanvasComponent} from '../profile-canvas/profile-canvas.component';
import {ProfileCanvasStore} from '../../stores/profile-canvas.store';
import {Placement, placePopout} from './place-popout';

/** Card width in pixels. Matches the `w-[21.25rem]` on the shell. */
const CARD_WIDTH = 340;

/**
 * Somebody's profile, anchored to the row that was clicked.
 *
 * Hand rolled rather than a PrimeNG popover: `Popover.align` only places above or below its target,
 * and this belongs beside it.
 */
@Component({
    selector: 'app-profile-popout',
    imports: [
        TranslateModule,
        ProfileHeaderComponent,
        ProfileActionsComponent,
        ProfileMutualLineComponent,
        ProfileCanvasComponent,
    ],
    templateUrl: './profile-popout.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProfilePopoutComponent {
    protected readonly popoutSvc = inject(ProfilePopoutService);
    protected readonly profile = signal<ProfileDto | undefined>(undefined);
    protected readonly draft = signal('');
    protected readonly sending = signal(false);

    private readonly card = viewChild<ElementRef<HTMLElement>>('card');
    private canvasStore = inject(ProfileCanvasStore);
    private profileService = inject(ProfileService);
    private directMessages = inject(DirectMessageService);
    private messagingService = inject(MessagingService);
    private navService = inject(NavigationService);
    private destroyRef = inject(DestroyRef);

    /** Null while the card has not been measured, and for the centered fallback. */
    protected readonly placement = signal<Placement | null>(null, {
        equal: (a, b) => a?.left === b?.left && a?.top === b?.top,
    });

    protected readonly anchored = computed(() => !!this.popoutSvc.popout()?.anchor);

    protected readonly placeholderName = computed(() => this.profile()?.userName ?? '');

    /**
     * Cache read only. A popout opens on hover in a member list, so a fetch here is a fan-out;
     * the modal is what warms this.
     */
    protected readonly cardCanvas = computed(() => {
        // profile() can stay the same cached object across two different popout opens, so this
        // also reads the popout target: without it, a reopen after the store warms would not recompute.
        const target = this.popoutSvc.popout();
        const profile = this.profile();
        if (!target || !profile) return undefined;

        const canvas = this.canvasStore.canvasFor(profile.id);
        return canvas?.widgets.some(widget => widget.card) ? canvas : undefined;
    });

    constructor() {
        effect(() => {
            const target = this.popoutSvc.popout();
            this.draft.set('');
            this.sending.set(false);
            this.placement.set(null);

            if (!target) {
                this.profile.set(undefined);
                return;
            }

            const cached = this.profileService.getCachedByUserId(target.userId);
            this.profile.set(cached);
            if (!cached) {
                this.profileService.getByUserId(target.userId).subscribe(p => {
                    if (this.popoutSvc.popout()?.userId === target.userId) this.profile.set(p);
                });
            }
        });

        // The card's height depends on the bio, the mutual line and the card widgets, so it is
        // measured rather than assumed. Placement compares by value, which is what stops this
        // re-running forever.
        afterRenderEffect(() => {
            this.profile();
            this.popoutSvc.popout();
            this.cardCanvas();
            this.reposition();
        });

        // Capture phase: a scroll inside the member list does not bubble to the document.
        const onScroll = (event: Event) => {
            if (this.card()?.nativeElement.contains(event.target as Node)) return;
            this.reposition();
        };
        const onResize = () => this.reposition();
        const onPointerDown = (event: PointerEvent) => this.dismissIfOutside(event);

        document.addEventListener('scroll', onScroll, true);
        window.addEventListener('resize', onResize);
        document.addEventListener('pointerdown', onPointerDown, true);

        this.destroyRef.onDestroy(() => {
            document.removeEventListener('scroll', onScroll, true);
            window.removeEventListener('resize', onResize);
            document.removeEventListener('pointerdown', onPointerDown, true);
        });
    }

    protected close(): void {
        this.popoutSvc.close();
    }

    protected onKeydown(event: KeyboardEvent): void {
        if (event.key === 'Escape') this.close();
    }

    protected openMutuals(tab: 'friends' | 'servers'): void {
        const userId = this.popoutSvc.popout()?.userId;
        if (userId) this.popoutSvc.openModal(userId, tab);
    }

    /** Resolves or creates the DM, sends, then goes there. The draft survives a failure. */
    protected send(): void {
        const userId = this.popoutSvc.popout()?.userId;
        const content = this.draft().trim();
        if (!userId || !content || this.sending()) return;

        this.sending.set(true);
        this.directMessages.openOrCreate(userId).subscribe({
            next: conversation => {
                this.messagingService.createMessage(newMessage(conversation.id, content)).subscribe({
                    // The conversation exists either way, so a failed send still goes there rather
                    // than leaving it stranded behind a closed popout.
                    next: () => this.leaveFor(conversation),
                    error: (err: unknown) => {
                        this.directMessages.reportFailure(err);
                        this.leaveFor(conversation);
                    },
                });
            },
            error: (err: unknown) => {
                this.sending.set(false);
                this.directMessages.reportFailure(err);
            },
        });
    }

    private leaveFor(conversation: ConversationDto): void {
        this.sending.set(false);
        this.draft.set('');
        this.navService.openConversation(conversation);
        this.close();
    }

    private reposition(): void {
        const target = this.popoutSvc.popout();
        const element = this.card()?.nativeElement;
        if (!target?.anchor || !element) return;

        const rect = target.anchor.getBoundingClientRect();
        // A row that scrolled out of a virtualised list, or was removed while the card was open.
        if (rect.width === 0 && rect.height === 0) {
            this.popoutSvc.close();
            return;
        }

        this.placement.set(
            placePopout(
                {left: rect.left, right: rect.right, top: rect.top},
                {width: CARD_WIDTH, height: element.offsetHeight},
                {width: window.innerWidth, height: window.innerHeight},
            ),
        );
    }

    private dismissIfOutside(event: PointerEvent): void {
        const target = this.popoutSvc.popout();
        if (!target) return;

        const node = event.target as Node;
        if (this.card()?.nativeElement.contains(node)) return;
        if (target.anchor?.contains(node)) return;

        this.close();
    }
}
