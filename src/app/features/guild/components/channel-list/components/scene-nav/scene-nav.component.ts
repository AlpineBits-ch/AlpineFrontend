import {
    ChangeDetectionStrategy,
    Component,
    computed,
    effect,
    inject,
    input,
    signal,
    untracked,
} from '@angular/core';
import {TranslateModule, TranslateService} from '@ngx-translate/core';

import {SceneFolderPanelComponent} from '../../../../scenes/scene-folder-panel.component';
import {SceneDialogComponent} from '../../../../scenes/scene-dialog/scene-dialog.component';
import {FolderNode, folderTree} from '../../../../scenes/scene-archive/folder-tree';
import {leavesByFolder, recentScenes, SceneLeaf} from '../../../../scenes/scene-leaf';
import {SceneService} from '../../../../../../services/scene.service';
import {SceneTaxonomyService} from '../../../../../../services/scene-taxonomy.service';
import {SceneRailStateService} from '../../../../../../services/scene-rail-state.service';
import {ArchiveStatus, SceneArchiveService} from '../../../../../../services/scene-archive.service';
import {GuildService} from '../../../../../../services/guild.service';
import {ProfileService} from '../../../../../../services/profile.service';
import {ToastService} from '../../../../../../services/toast.service';
import {NavigationService} from '../../../../../main-page/navigation.service';
import {SceneStatus} from '../../../../../../dtos/response/scene.dto';
import {ChannelType} from '../../../../../../dtos/response/guild.dto';
import {SelfGuildMemberDto} from '../../../../../../dtos/response/member.dto';
import {ModulePermissions} from '../../../../../../enums/module-permissions.enum';
import {guildAbilities} from '../../../../guild-permissions';
import {GuildFeature, guildFeatures} from '../../../../guild-features';

/** Root shelves the sidebar draws before the rest go behind one row. */
const ROOT_CAP = 5;
/** Recent rows. Short: this column also has to fit the channels. */
const RECENT_CAP = 3;
/** Running and finished alike. The sidebar is the structural navigation, so it reaches everything. */
const SHELF_STATUS: ArchiveStatus = 'all';

/**
 * The scene folder tree, in the guild sidebar under the module rows. Closed until the reader opens
 * it, because a guild with a dozen arcs would otherwise push every channel below the fold.
 */
@Component({
    selector: 'app-scene-nav',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [TranslateModule, SceneFolderPanelComponent, SceneDialogComponent],
    templateUrl: './scene-nav.component.html',
    styleUrl: './scene-nav.component.css',
})
export class SceneNavComponent {
    readonly guildId = input.required<string>();

    private readonly scenes = inject(SceneService);
    private readonly taxonomy = inject(SceneTaxonomyService);
    private readonly archive = inject(SceneArchiveService);
    private readonly railState = inject(SceneRailStateService);
    private readonly guilds = inject(GuildService);
    private readonly profiles = inject(ProfileService);
    private readonly toast = inject(ToastService);
    private readonly translate = inject(TranslateService);
    private readonly nav = inject(NavigationService);

    private readonly ownMember = signal<SelfGuildMemberDto | null>(null);

    protected get ROOT_CAP() {
        return ROOT_CAP;
    }

    protected readonly creating = signal(false);
    protected readonly seedFolderId = signal<string | null>(null);

    protected readonly guild = computed(() => this.guilds.guilds().find(g => g.id === this.guildId()));

    protected readonly hasScenes = computed(() => guildFeatures(this.guild()).has(GuildFeature.Scenes));

    protected readonly open = computed(() => this.railState.navOpen(this.guildId()));

    protected readonly canManage = computed(() =>
        guildAbilities(this.ownMember(), this.guild(), this.profiles.ownProfile()?.userId).canModule(
            ModulePermissions.ManageScenes,
        ),
    );

    protected readonly textChannels = computed(() =>
        (this.guild()?.channels ?? []).filter(c => c.type === ChannelType.Text),
    );

    /** The scenes view, or null while the reader is somewhere else in this guild. */
    private readonly view = computed(() => {
        const view = this.nav.mainView();
        return view.type === 'scenes' && view.guildId === this.guildId() ? view : null;
    });

    protected readonly folderId = computed(() => this.view()?.folderId ?? null);

    /** The scene itself stays marked while its out-of-character side is the one on screen. */
    protected readonly activeChannelId = computed(() => {
        const channelId = this.view()?.sceneChannelId;
        if (!channelId) return null;
        return this.scenes.sceneForOoc(this.guildId(), channelId)?.channelId ?? channelId;
    });

    protected readonly expandedIds = computed(() => this.railState.expanded(this.guildId()));

    /** Every folder the guild has, whatever is in it. An arc that finished still has a shelf. */
    protected readonly tree = computed(() =>
        folderTree(this.taxonomy.folders(this.guildId()), this.folderCounts()),
    );

    /** Only shelves that have been read. An unopened one contributes nothing rather than a guess. */
    private readonly folderCounts = computed(() => {
        const guildId = this.guildId();
        const counts: Record<string, number> = {};
        for (const folderId of this.expandedIds()) {
            counts[folderId] = this.archive.peeked(guildId, folderId, SHELF_STATUS).length;
        }
        return counts;
    });

    /** A shelf's total is a floor while its own page is capped, or while anything below it is unread. */
    protected readonly partialFolderIds = computed(() => {
        const guildId = this.guildId();
        const open = new Set(this.expandedIds());
        const read = (id: string) => open.has(id) && this.archive.peekExhausted(guildId, id, SHELF_STATUS);

        const partial = new Set<string>();
        const walk = (node: FolderNode): boolean => {
            let unknown = !read(node.folder.id);
            for (const child of node.children) unknown = walk(child) || unknown;
            if (unknown) partial.add(node.folder.id);
            return unknown;
        };
        for (const root of this.tree()) walk(root);

        return [...partial];
    });

    protected readonly loadingFolderIds = computed(() =>
        this.expandedIds().filter(id => this.archive.peekLoading(this.guildId(), id, SHELF_STATUS)),
    );

    protected readonly scenesByFolder = computed((): Record<string, SceneLeaf[]> => {
        const guildId = this.guildId();
        const speakable = this.scenes.speakableIds(guildId);
        const grouped: Record<string, SceneLeaf[]> = {};
        for (const folderId of this.expandedIds()) {
            grouped[folderId] =
                leavesByFolder(this.archive.peeked(guildId, folderId, SHELF_STATUS), speakable)[folderId] ??
                [];
        }
        return grouped;
    });

    /** What you are in the middle of, which is a different question from what exists: live only. */
    protected readonly recent = computed(() => {
        const guildId = this.guildId();
        const live = this.scenes.scenes(guildId).filter(scene => scene.status !== SceneStatus.Concluded);
        return recentScenes(live, this.scenes.speakableIds(guildId), RECENT_CAP);
    });

    constructor() {
        effect(() => {
            const guildId = this.guildId();
            if (!this.hasScenes()) return;
            untracked(() => {
                this.scenes.ensureGuild(guildId);
                this.taxonomy.ensureGuild(guildId);
                this.guilds.getOwnMember(guildId).subscribe({
                    next: member => this.ownMember.set(member),
                    error: () => this.ownMember.set(null),
                });
            });
        });

        // One request per shelf the reader has opened, and nothing at all while the section is shut.
        effect(() => {
            const guildId = this.guildId();
            if (!this.hasScenes() || !this.open()) return;
            const open = this.expandedIds();
            untracked(() => {
                for (const folderId of open) this.archive.peek(guildId, folderId, SHELF_STATUS);
            });
        });
    }

    protected toggle(): void {
        this.railState.setNavOpen(this.guildId(), !this.open());
    }

    protected pick(folderId: string | null): void {
        this.nav.openSceneFolder(this.guildId(), folderId);
    }

    protected createIn(folderId: string | null): void {
        this.seedFolderId.set(folderId);
        this.creating.set(true);
    }

    protected file(channelId: string, folderId: string | null): void {
        const guildId = this.guildId();
        this.archive
            .fileScene(guildId, channelId, folderId, this.scenes.update(guildId, channelId, {folderId}))
            .subscribe({
                next: from => this.repeek(from, folderId),
                error: err => this.toast.httpError(this.translate.instant('SCENE.ARCHIVE.FILE_ERROR'), err),
            });
    }

    /** Invalidation empties both shelves' cached pages; refill only the ones the reader has open, so
     *  filing into a closed shelf does not fetch it. */
    private repeek(...folderIds: (string | null)[]): void {
        const guildId = this.guildId();
        const open = this.expandedIds();
        for (const folderId of folderIds) {
            if (folderId !== null && open.includes(folderId))
                this.archive.peek(guildId, folderId, SHELF_STATUS);
        }
    }
}
