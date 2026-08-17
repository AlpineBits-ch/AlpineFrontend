import {ChangeDetectionStrategy, Component, computed, effect, inject, input} from '@angular/core';
import {AppAvatarComponent} from '../../../../components/avatar/avatar.component';
import {ConversationDto, ConversationMemberDto} from '../../../../dtos/response/conversation.dto';
import {ConversationUtilsService} from '../../../../services/conversation-utils.service';
import {ProfileService} from '../../../../services/profile.service';
import {BrokenImageService} from '../../../../services/broken-image.service';
import {cacheBustedUrl} from '../../../../models/profile-image.model';

/** How far down the member list to look for a face. Bounds the profile fetches a long group costs. */
const CANDIDATE_LIMIT = 4;

/** One half of the composite: a picture, or the letter to draw when there is none. */
export interface AvatarTile {
    imageUrl?: string;
    label: string;
}

@Component({
    selector: 'app-conversation-avatar',
    imports: [AppAvatarComponent],
    templateUrl: './conversation-avatar.component.html',
    styleUrl: './conversation-avatar.component.css',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ConversationAvatarComponent {
    readonly conversation = input.required<ConversationDto>();
    readonly size = input<'normal' | 'large'>('normal');

    private readonly convUtils = inject(ConversationUtilsService);
    private readonly profiles = inject(ProfileService);
    private readonly brokenImages = inject(BrokenImageService);

    protected readonly iconUrl = computed(() => this.convUtils.getChatIconUrl(this.conversation()));
    protected readonly label = computed(() => this.convUtils.getChatAvatarLabel(this.conversation()));
    protected readonly partnerId = computed(
        () => this.convUtils.getPartnerMember(this.conversation())?.userId,
    );
    protected readonly isGroup = computed(() => this.convUtils.isGroup(this.conversation()));

    /** Must stay an inline style: Tailwind purges class names assembled at runtime. */
    protected readonly boxStyle = computed(() => {
        const dim = this.size() === 'large' ? '4rem' : '2rem';
        return {width: dim, height: dim};
    });

    /** The oldest members first, capped, since that is the order the faces are picked in. */
    private readonly candidates = computed((): ConversationMemberDto[] =>
        [...this.convUtils.getOtherMembers(this.conversation())]
            .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
            .slice(0, CANDIDATE_LIMIT),
    );

    /**
     * Two faces for a group with no icon of its own, oldest member first, skipping anyone without a
     * picture. Own picture fills a gap rather than leaving one, and initials fill what is left.
     */
    protected readonly tiles = computed((): AvatarTile[] => {
        if (!this.isGroup() || this.iconUrl()) return [];

        const withPictures = this.candidates()
            .map(member => ({member, imageUrl: this.avatarOf(member.userId)}))
            .filter(entry => entry.imageUrl !== undefined);

        const own = this.profiles.ownProfile();
        const ownUrl = this.usableUrl(own?.avatarUrl, own?.updatedAt);
        if (withPictures.length < 2 && ownUrl && own) {
            withPictures.push({
                member: {userId: own.userId, cachedUserName: own.userName} as ConversationMemberDto,
                imageUrl: ownUrl,
            });
        }

        // Nobody in reach has a picture, so a pair of blank initials would say less than one.
        if (withPictures.length === 0) return [];

        const tiles: AvatarTile[] = withPictures
            .slice(0, 2)
            .map(entry => ({imageUrl: entry.imageUrl, label: initialOf(entry.member)}));

        for (const member of this.candidates()) {
            if (tiles.length === 2) break;
            if (withPictures.some(entry => entry.member.userId === member.userId)) continue;
            tiles.push({label: initialOf(member)});
        }

        return tiles.length === 2 ? tiles : [];
    });

    constructor() {
        effect(() => {
            if (!this.isGroup() || this.iconUrl()) return;
            for (const member of this.candidates()) this.profiles.resolveByUserId(member.userId);
        });
    }

    /** Drops the tile that failed and re-picks, rather than leaving a broken glyph in the stack. */
    protected onTileError(url: string): void {
        this.brokenImages.markBroken(url);
    }

    private avatarOf(userId: string): string | undefined {
        const profile = this.profiles.getCachedByUserId(userId);
        return this.usableUrl(profile?.avatarUrl, profile?.updatedAt);
    }

    /**
     * The API mints an avatar URL from the profile id whether or not a picture was ever uploaded, so
     * a populated `avatarUrl` is not a picture. Only a failed request settles it.
     */
    private usableUrl(url: string | undefined, updatedAt: Date | undefined): string | undefined {
        const busted = cacheBustedUrl(url, updatedAt);
        return this.brokenImages.isBroken(busted) ? undefined : busted;
    }
}

function initialOf(member: ConversationMemberDto): string {
    return (member.cachedUserName?.[0] ?? '?').toUpperCase();
}
