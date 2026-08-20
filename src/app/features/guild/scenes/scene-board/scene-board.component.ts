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
import {TranslateModule} from '@ngx-translate/core';
import {RelativeTimePipe} from '../../../../pipes/relative-time.pipe';
import {TurnClockRingComponent} from '../turn-clock-ring/turn-clock-ring.component';
import {SceneDialogComponent} from '../scene-dialog/scene-dialog.component';
import {SceneArchiveComponent} from '../scene-archive/scene-archive.component';
import {SceneService} from '../../../../services/scene.service';
import {PersonaService} from '../../../../services/persona.service';
import {GuildService} from '../../../../services/guild.service';
import {ProfileService} from '../../../../services/profile.service';
import {NavigationService} from '../../../main-page/navigation.service';
import {SceneListItemDto, SceneStatus} from '../../../../dtos/response/scene.dto';
import {ChannelType} from '../../../../dtos/response/guild.dto';
import {SelfGuildMemberDto} from '../../../../dtos/response/member.dto';
import {ModulePermissions} from '../../../../enums/module-permissions.enum';
import {guildAbilities} from '../../guild-permissions';
import {PersonaIdentity} from '../../personas/persona-identity';
import {turnClock} from '../scene-clock';
import {compareScenes, isWaitingOnMe, sceneStatusMeta} from '../scene-status';
import {sceneTally} from '../scene-tally';

/** One row, with everything resolved: the board redraws on a clock and must not resolve per cell. */
export interface SceneRow {
    scene: SceneListItemDto;
    identity: PersonaIdentity | null;
    clock: ReturnType<typeof turnClock>;
    mine: boolean;
    tally: ReturnType<typeof sceneTally>;
}

export interface SceneGroup {
    key: string;
    titleKey: string;
    /** `yours` carries the one loud colour in the feature; everything else is quiet. */
    tone: 'yours' | 'attention' | 'normal' | 'quiet';
    rows: SceneRow[];
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
    protected readonly nav = inject(NavigationService);

    protected readonly SceneStatus = SceneStatus;
    protected readonly creating = signal(false);
    protected readonly mode = signal<'playing' | 'archive'>('playing');

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

    constructor() {
        effect(() => {
            const guildId = this.guildId();
            untracked(() => {
                this.scenes.ensureGuild(guildId);
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
        return [...this.scenes.scenes(guildId)]
            .filter(scene => scene.status !== SceneStatus.Concluded)
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
                tally: sceneTally(scene),
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

        const of = (status: SceneStatus) =>
            rows.filter(row => !taken.has(row.scene.channelId) && row.scene.status === status);

        return [
            {key: 'yours', titleKey: 'SCENE.BOARD.YOUR_MOVE', tone: 'yours', rows: yours},
            {key: 'stalled', titleKey: 'SCENE.BOARD.STALLED', tone: 'attention', rows: stalled},
            {
                key: 'running',
                titleKey: 'SCENE.BOARD.RUNNING',
                tone: 'normal',
                rows: of(SceneStatus.Active),
            },
            {key: 'open', titleKey: 'SCENE.BOARD.OPENING', tone: 'normal', rows: of(SceneStatus.Open)},
            {key: 'paused', titleKey: 'SCENE.BOARD.PAUSED', tone: 'quiet', rows: of(SceneStatus.Paused)},
            // No concluded group: a finished scene belongs to the archive, which is where it can be
            // filed, tagged and read back.
        ].filter(group => group.rows.length > 0) as SceneGroup[];
    });

    protected readonly isEmpty = computed(() => !this.loading() && this.rows().length === 0);

    protected statusOf(scene: SceneListItemDto) {
        return sceneStatusMeta(scene.status);
    }

    protected open(row: SceneRow): void {
        const channel = this.guild()?.channels.find(c => c.id === row.scene.channelId);
        if (channel) this.nav.openChannel(channel);
    }
}
