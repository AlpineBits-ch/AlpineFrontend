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
import {RelativeTimePipe} from '../../../../pipes/relative-time.pipe';
import {TurnClockRingComponent} from '../turn-clock-ring/turn-clock-ring.component';
import {SceneDialogComponent} from '../scene-dialog/scene-dialog.component';
import {SceneArchiveComponent} from '../scene-archive/scene-archive.component';
import {SceneFolderPanelComponent} from '../scene-folder-panel.component';
import {countByFolder, FolderNode, folderTree} from '../scene-archive/folder-tree';
import {leavesByFolder, recentScenes} from '../scene-leaf';
import {SceneService} from '../../../../services/scene.service';
import {PersonaService} from '../../../../services/persona.service';
import {GuildService} from '../../../../services/guild.service';
import {ProfileService} from '../../../../services/profile.service';
import {ToastService} from '../../../../services/toast.service';
import {SceneRailStateService} from '../../../../services/scene-rail-state.service';
import {SceneTaxonomyService} from '../../../../services/scene-taxonomy.service';
import {NavigationService, SceneBoardMode} from '../../../main-page/navigation.service';
import {SceneListItemDto, SceneStatus} from '../../../../dtos/response/scene.dto';
import {UNFILED} from '../../../../dtos/request/scene.dto';
import {ChannelType} from '../../../../dtos/response/guild.dto';
import {SelfGuildMemberDto} from '../../../../dtos/response/member.dto';
import {ModulePermissions} from '../../../../enums/module-permissions.enum';
import {guildAbilities} from '../../guild-permissions';
import {PersonaIdentity} from '../../personas/persona-identity';
import {turnClock} from '../scene-clock';
import {compareScenes, isWaitingOnMe, sceneStatusMeta} from '../scene-status';

/** One row, with everything resolved: the board redraws on a clock and must not resolve per cell. */
export interface SceneRow {
    scene: SceneListItemDto;
    identity: PersonaIdentity | null;
    clock: ReturnType<typeof turnClock>;
    mine: boolean;
    /** Named only on a pinned row, which sits outside the folder section it belongs to. */
    folderPath?: string | null;
}

export interface SceneGroup {
    key: string;
    titleKey: string;
    /** `yours` carries the one loud colour in the feature; everything else is quiet. */
    tone: 'yours' | 'attention' | 'normal' | 'quiet';
    rows: SceneRow[];
    /** Set on a folder section: its own name, which no translation key can carry. */
    title?: string;
    accent?: string | null;
}

/**
 * Every scene in the guild, in the order that answers the only question worth asking on opening the
 * app: is a game waiting on me. Correspondence chess has had this list for thirty years; chat has not.
 */
@Component({
    selector: 'app-scene-board',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [
        TranslateModule,
        RelativeTimePipe,
        TurnClockRingComponent,
        SceneDialogComponent,
        SceneArchiveComponent,
        SceneFolderPanelComponent,
    ],
    templateUrl: './scene-board.component.html',
    styleUrl: './scene-board.component.css',
    // `h-full` rather than `flex-1` alone: main-page drops this into a plain block container, so
    // there is no flex parent to stretch against and the board would take its content's height.
    host: {class: 'flex flex-col flex-1 min-w-0 min-h-0 h-full overflow-hidden'},
})
export class SceneBoardComponent {
    readonly guildId = input.required<string>();

    protected readonly scenes = inject(SceneService);
    private readonly personas = inject(PersonaService);
    private readonly guilds = inject(GuildService);
    private readonly profiles = inject(ProfileService);
    private readonly toast = inject(ToastService);
    private readonly translate = inject(TranslateService);
    protected readonly nav = inject(NavigationService);
    private readonly railState = inject(SceneRailStateService);
    private readonly taxonomy = inject(SceneTaxonomyService);

    protected get SceneStatus() {
        return SceneStatus;
    }

    protected readonly creating = signal(false);

    protected readonly folderId = signal<string | null>(null);
    protected readonly seedFolderId = signal<string | null>(null);

    /** Held by the navigation service so it survives leaving the board and restoring the app. */
    protected readonly mode = computed((): SceneBoardMode => {
        const view = this.nav.mainView();
        return view.type === 'scenes' && view.guildId === this.guildId() ? view.mode : 'playing';
    });

    private readonly ownMember = signal<SelfGuildMemberDto | null>(null);

    protected readonly guild = computed(() => this.guilds.guilds().find(g => g.id === this.guildId()));

    protected readonly canManage = computed(() =>
        guildAbilities(this.ownMember(), this.guild(), this.profiles.ownProfile()?.userId).canModule(
            ModulePermissions.ManageScenes,
        ),
    );

    protected readonly textChannels = computed(() =>
        (this.guild()?.channels ?? []).filter(c => c.type === ChannelType.Text),
    );

    protected readonly loading = computed(() => this.scenes.isLoading(this.guildId()));

    protected readonly railVisible = computed(() => this.railState.railVisible(this.guildId()));

    /** The board is the live board: a concluded scene belongs to the archive, not to a count or a
     *  leaf here. Shared so the tree, the rail and the rows never disagree with each other. */
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
        recentScenes(this.liveScenes(), this.scenes.speakableIds(this.guildId())),
    );

    constructor() {
        effect(() => {
            const guildId = this.guildId();
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

    private readonly rows = computed((): SceneRow[] => {
        const guildId = this.guildId();
        const speakable = this.scenes.speakableIds(guildId);
        const now = this.scenes.now();
        return [...this.liveScenes()]
            .sort((a, b) => compareScenes(a, b, speakable, now))
            .map(scene => ({
                scene,
                // The row already names the character on the clock, so this costs no cast lookup.
                identity: this.personas.identity(guildId, scene.currentTurnPersonaId, {
                    name: scene.currentTurnName,
                    avatarUrl: scene.currentTurnAvatarUrl,
                    color: scene.currentTurnColor,
                }),
                clock: turnClock(scene, now),
                mine: isWaitingOnMe(scene, speakable),
            }));
    });

    protected readonly waitingCount = computed(() => this.rows().filter(row => row.mine).length);

    protected readonly groups = computed((): SceneGroup[] => {
        const rows = this.rows();
        const yours = rows.filter(row => row.mine);
        const taken = new Set(yours.map(row => row.scene.channelId));

        const stalled = this.canManage()
            ? rows.filter(
                  row =>
                      !taken.has(row.scene.channelId) &&
                      row.scene.status === SceneStatus.Active &&
                      (row.scene.nudgeCount ?? 0) >= 2,
              )
            : [];
        stalled.forEach(row => taken.add(row.scene.channelId));

        return this.railVisible() && this.tree().length
            ? this.folderGroups(rows, yours, stalled, taken)
            : this.statusGroups(rows, yours, stalled, taken);
    });

    private statusGroups(
        rows: SceneRow[],
        yours: SceneRow[],
        stalled: SceneRow[],
        taken: Set<string>,
    ): SceneGroup[] {
        const of = (status: SceneStatus) =>
            rows.filter(row => !taken.has(row.scene.channelId) && row.scene.status === status);

        return [
            {key: 'yours', titleKey: 'SCENE.BOARD.YOUR_MOVE', tone: 'yours', rows: yours},
            {key: 'stalled', titleKey: 'SCENE.BOARD.STALLED', tone: 'attention', rows: stalled},
            {key: 'running', titleKey: 'SCENE.BOARD.RUNNING', tone: 'normal', rows: of(SceneStatus.Active)},
            {key: 'open', titleKey: 'SCENE.BOARD.OPENING', tone: 'normal', rows: of(SceneStatus.Open)},
            {key: 'paused', titleKey: 'SCENE.BOARD.PAUSED', tone: 'quiet', rows: of(SceneStatus.Paused)},
            // No concluded group: a finished scene belongs to the archive.
        ].filter(group => group.rows.length > 0) as SceneGroup[];
    }

    /**
     * Your move and stalled keep the top, unless a folder is chosen: then nothing is pinned above
     * the sections, and every in-scope row, taken or not, has to show up inside its section.
     */
    private folderGroups(
        rows: SceneRow[],
        yours: SceneRow[],
        stalled: SceneRow[],
        taken: Set<string>,
    ): SceneGroup[] {
        const chosen = this.folderId();
        const unfiledOnly = chosen === UNFILED;
        const wanted = chosen && !unfiledOnly ? this.subtreeOf(chosen) : null;
        const paths = this.folderPaths();
        const path = (row: SceneRow) => (row.scene.folderId ? (paths.get(row.scene.folderId) ?? null) : null);
        // A chosen folder pins nothing above the sections, so its rows must not be filtered by
        // `taken`: that set only excludes what a pinned row already carries.
        const excluded = chosen ? new Set<string>() : taken;

        const pinned: SceneGroup[] = chosen
            ? []
            : [
                  {
                      key: 'yours',
                      titleKey: 'SCENE.BOARD.YOUR_MOVE',
                      tone: 'yours',
                      rows: yours.map(row => ({...row, folderPath: path(row)})),
                  },
                  {
                      key: 'stalled',
                      titleKey: 'SCENE.BOARD.STALLED',
                      tone: 'attention',
                      rows: stalled.map(row => ({...row, folderPath: path(row)})),
                  },
              ];

        const sections: SceneGroup[] = [];
        if (!unfiledOnly) {
            for (const node of flattenTree(this.tree())) {
                if (wanted && !wanted.has(node.folder.id)) continue;
                sections.push({
                    key: `folder:${node.folder.id}`,
                    titleKey: '',
                    title: node.folder.name,
                    accent: node.folder.color,
                    tone: 'normal',
                    rows: rows.filter(
                        row => !excluded.has(row.scene.channelId) && row.scene.folderId === node.folder.id,
                    ),
                });
            }
        }

        const unfiled: SceneGroup = {
            key: 'unfiled',
            titleKey: 'SCENE.BOARD.FOLDER_UNFILED',
            tone: 'quiet',
            rows:
                !chosen || unfiledOnly
                    ? rows.filter(row => !excluded.has(row.scene.channelId) && !row.scene.folderId)
                    : [],
        };

        return [...pinned, ...sections, unfiled].filter(group => group.rows.length > 0);
    }

    /** A folder and everything under it, which is what picking a shelf filters on. */
    private subtreeOf(folderId: string): Set<string> {
        const ids = new Set<string>();
        const walk = (nodes: FolderNode[]): boolean =>
            nodes.some(node => {
                if (node.folder.id === folderId) {
                    collect(node, ids);
                    return true;
                }
                return walk(node.children);
            });
        walk(this.tree());
        return ids;
    }

    /** "Act I / Greyford" style, matching the rail's move-to-folder targets. */
    private readonly folderPaths = computed(() => {
        const paths = new Map<string, string>();
        const walk = (nodes: FolderNode[], parentPath: string | null) => {
            for (const node of nodes) {
                const path = parentPath ? `${parentPath} / ${node.folder.name}` : node.folder.name;
                paths.set(node.folder.id, path);
                walk(node.children, path);
            }
        };
        walk(this.tree(), null);
        return paths;
    });

    protected readonly isEmpty = computed(() => !this.loading() && this.rows().length === 0);

    protected statusOf(scene: SceneListItemDto) {
        return sceneStatusMeta(scene.status);
    }

    protected setMode(mode: SceneBoardMode): void {
        this.nav.openScenes(this.guildId(), mode);
    }

    protected open(row: SceneRow): void {
        const channel = this.guild()?.channels.find(c => c.id === row.scene.channelId);
        if (!channel) {
            this.toast.error(this.translate.instant('SCENE.BOARD.OPEN_FAILED'));
            return;
        }
        this.nav.openChannel(channel);
    }

    protected toggleRail(): void {
        this.railState.setRailVisible(this.guildId(), !this.railVisible());
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

/** Every node depth first, parents before their children. */
function flattenTree(nodes: FolderNode[]): FolderNode[] {
    return nodes.flatMap(node => [node, ...flattenTree(node.children)]);
}

function collect(node: FolderNode, into: Set<string>): void {
    into.add(node.folder.id);
    for (const child of node.children) collect(child, into);
}
