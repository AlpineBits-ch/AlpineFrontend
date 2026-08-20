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
import {countByFolder, folderTree} from '../../../../scenes/scene-archive/folder-tree';
import {leavesByFolder, recentScenes} from '../../../../scenes/scene-leaf';
import {SceneService} from '../../../../../../services/scene.service';
import {SceneTaxonomyService} from '../../../../../../services/scene-taxonomy.service';
import {SceneRailStateService} from '../../../../../../services/scene-rail-state.service';
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
/** Recent rows. Shorter than the rail's: this column also has to fit the channels. */
const RECENT_CAP = 3;

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

    /** A concluded scene belongs to the archive, not to a count or a leaf here. */
    private readonly liveScenes = computed(() =>
        this.scenes.scenes(this.guildId()).filter(scene => scene.status !== SceneStatus.Concluded),
    );

    protected readonly tree = computed(() =>
        folderTree(this.taxonomy.folders(this.guildId()), countByFolder(this.liveScenes())),
    );

    protected readonly scenesByFolder = computed(() =>
        leavesByFolder(this.liveScenes(), this.scenes.speakableIds(this.guildId())),
    );

    protected readonly recent = computed(() =>
        recentScenes(this.liveScenes(), this.scenes.speakableIds(this.guildId()), RECENT_CAP),
    );

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
        this.scenes.update(this.guildId(), channelId, {folderId}).subscribe({
            error: err => this.toast.httpError(this.translate.instant('SCENE.ARCHIVE.FILE_ERROR'), err),
        });
    }
}
