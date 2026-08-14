import {
    ChangeDetectionStrategy,
    Component,
    computed,
    effect,
    inject,
    input,
    output,
    signal,
    untracked,
} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {TranslateModule} from '@ngx-translate/core';
import {Button} from 'primeng/button';
import {InputText} from 'primeng/inputtext';
import {Checkbox} from 'primeng/checkbox';
import {Tooltip} from 'primeng/tooltip';
import {ChannelDto} from '../../../../dtos/response/guild.dto';
import {SelfGuildMemberDto} from '../../../../dtos/response/member.dto';
import {LIST_LIMITS, ListItem} from '../../../../dtos/response/list.dto';
import {GuildService} from '../../../../services/guild.service';
import {ListService} from '../../../../services/list.service';
import {ProfileService} from '../../../../services/profile.service';
import {NavigationService} from '../../../main-page/navigation.service';
import {guildAbilities} from '../../guild-permissions';
import {ModulePermissions} from '../../../../enums/module-permissions.enum';
import {GuildFeature, guildHasFeature} from '../../guild-features';
import {channelIcon} from '../../channel-types';

/** One rendered group of rows under a `section` heading, or under no heading at all. */
interface ListSection {
    /** The free-text section name, or `null` for the ungrouped rows that always sort first. */
    name: string | null;
    items: ListItem[];
}

/**
 * The full-width `List` channel view: the shopping list, the todo list.
 *
 * <p>No composer and no message history - a List channel has neither. Every row is a
 * {@link ListItem}, and every interaction with one goes through {@link ListService}, which applies
 * it locally before the request so the other phone in the shop sees a strike-through inside the
 * second.</p>
 *
 * <p>Two gates decide whether anything renders at all, and they are not the same gate. The `Lists`
 * **module** being off means the guild does not do shopping lists: nothing is drawn, because a
 * "you're not allowed" panel would be a lie - nobody in that guild is, including its owner. Only
 * once the module is known to be on does a `403` mean what it looks like.</p>
 */
@Component({
    selector: 'app-list-channel',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [Button, InputText, Checkbox, Tooltip, FormsModule, TranslateModule],
    templateUrl: './list-channel.component.html',
})
export class ListChannelComponent {
    channel = input.required<ChannelDto>();
    /** Emitted by the mobile back affordance; the shell decides what "back" means. */
    back = output();

    protected readonly maxTextLength = LIST_LIMITS.textMaxLength;
    protected readonly maxItems = LIST_LIMITS.maxItems;

    protected navService = inject(NavigationService);
    private listService = inject(ListService);
    private guildService = inject(GuildService);
    private profileService = inject(ProfileService);

    private ownMember = signal<SelfGuildMemberDto | null>(null);

    // ── Composer ─────────────────────────────────────────────────────────────
    protected draftText = signal('');
    protected draftQuantity = signal('');
    protected adding = signal(false);

    // ── Inline edit ──────────────────────────────────────────────────────────
    protected editingId = signal<string | null>(null);
    protected editText = signal('');
    protected editQuantity = signal('');

    /** Local view filter, not a fetch parameter - the list is always fetched whole. */
    protected hideChecked = signal(false);

    /** Index of the row being dragged, or `null`. Native HTML5 drag; the app pulls in no CDK. */
    protected dragIndex = signal<number | null>(null);
    protected dragOverIndex = signal<number | null>(null);

    protected icon = computed(() => channelIcon(this.channel().type));

    private state = computed(() => this.listService.stateFor(this.channel().id));
    protected items = computed(() => this.state().items);
    protected loading = computed(() => this.state().loading);
    protected hasLoaded = computed(() => this.state().hasLoaded);
    protected loadFailed = computed(() => this.state().loadFailed);

    protected checkedCount = computed(() => this.items().filter(item => item.isChecked).length);
    protected remainingCount = computed(() => this.items().length - this.checkedCount());
    protected atCapacity = computed(() => this.items().length >= LIST_LIMITS.maxItems);

    /** The rows actually drawn, after the local hide-done filter. */
    protected visibleItems = computed(() =>
        this.hideChecked() ? this.items().filter(item => !item.isChecked) : this.items());

    /**
     * Rows grouped by their free-text `section`, ungrouped first, then sections in the order they
     * first appear - which is list order, so grouping never contradicts the order people dragged
     * things into. Grouping is presentation only; every index handed to a reorder is an index into
     * the flat list.
     */
    protected sections = computed<ListSection[]>(() => {
        const groups: ListSection[] = [];
        const byName = new Map<string | null, ListSection>();

        for (const item of this.visibleItems()) {
            const name = item.section?.trim() || null;
            let group = byName.get(name);
            if (!group) {
                group = {name, items: []};
                byName.set(name, group);
                groups.push(group);
            }
            group.items.push(item);
        }

        return groups.sort((a, b) => (a.name === null ? 0 : 1) - (b.name === null ? 0 : 1));
    });

    private guild = computed(() => {
        const workspace = this.navService.workspace();
        return workspace.type === 'server' && workspace.guild.id === this.channel().guildId
            ? workspace.guild
            : null;
    });

    /**
     * Whether this guild does lists at all.
     *
     * <p>`features` is read before anything is drawn, per §13.2: a guild without the module answers
     * every list route with `403` regardless of roles, so treating that `403` as a permission
     * problem would tell a household "you're not allowed to see the shopping list" when the truth
     * is that their house has no shopping list. Absent guild context (the channel opened from
     * somewhere other than its own server) is treated as enabled - the loader's own `403` handling
     * is the backstop.</p>
     */
    protected moduleEnabled = computed(() => {
        const guild = this.guild();
        return guild === null || guildHasFeature(guild, GuildFeature.Lists);
    });

    /** A refusal that survives the module check - so it really is about this member's roles. */
    protected forbidden = computed(() => this.moduleEnabled() && this.state().forbidden);

    private ownUserId = computed(() => this.profileService.ownProfile()?.userId ?? null);

    private abilities = computed(() => guildAbilities(this.ownMember(), this.guild(), this.ownUserId()));

    private can = (permission: bigint): boolean => this.abilities().canModule(permission);

    /** `AddListItems` - and the same bit is what lets someone edit or delete their own row. */
    protected canAdd = computed(() => this.can(ModulePermissions.AddListItems));
    /** `ManageLists` - clear the list, and edit or delete anyone's row. */
    protected canManage = computed(() => this.can(ModulePermissions.ManageLists));
    /**
     * `CheckOffListItems`. Separate from adding on purpose: ticking is the collaborative part, and
     * a household can hand it to people it would not hand the list itself to.
     */
    protected canCheck = computed(() => this.can(ModulePermissions.CheckOffListItems));

    constructor() {
        effect(() => {
            const channelId = this.channel().id;
            untracked(() => this.listService.ensureLoaded(channelId));
        });

        effect(() => {
            const guildId = this.channel().guildId;
            untracked(() => this.guildService.getOwnMember(guildId)
                .subscribe({next: m => this.ownMember.set(m), error: () => this.ownMember.set(null)}));
        });
    }

    /** Yours needs `AddListItems`; anyone else's needs `ManageLists`. A pantry row has no author. */
    protected canEdit(item: ListItem): boolean {
        if (this.canManage()) return true;
        const ownUserId = this.ownUserId();
        return this.canAdd() && !!ownUserId && item.addedByUserId === ownUserId;
    }

    protected async add(): Promise<void> {
        const text = this.draftText().trim();
        if (!text || this.adding()) return;

        this.adding.set(true);
        const quantity = this.draftQuantity().trim();
        // Sent verbatim, never parsed: "2 packs" and "a bunch" are the normal inputs, and a number
        // is only one of the things people type here.
        const ok = await this.listService.addItem(this.channel().id, {
            text,
            quantity: quantity || null,
        });
        this.adding.set(false);

        // The draft is kept on failure so a rejected line is not also a retyped one.
        if (ok) {
            this.draftText.set('');
            this.draftQuantity.set('');
        }
    }

    /**
     * Absolute, never a flip: the checkbox reports the state it now has, and that value is what is
     * sent. A repeat is a no-op the store swallows, so a double-tap cannot bounce the row.
     */
    protected setChecked(item: ListItem, checked: boolean): void {
        if (!this.canCheck()) return;
        void this.listService.setChecked(this.channel().id, item.id, checked);
    }

    protected startEdit(item: ListItem): void {
        this.editingId.set(item.id);
        this.editText.set(item.text);
        this.editQuantity.set(item.quantity ?? '');
    }

    protected cancelEdit(): void {
        this.editingId.set(null);
    }

    protected async saveEdit(item: ListItem): Promise<void> {
        const text = this.editText().trim();
        if (!text) return;
        const quantity = this.editQuantity().trim();
        this.editingId.set(null);
        await this.listService.updateItem(this.channel().id, item.id, {
            text,
            // `''` and not `|| null`: on a PATCH the server reads a null `quantity` as "leave it
            // alone", so emptying the field would silently keep the old "2 packs". See
            // UpdateListItemDto.
            quantity,
        });
    }

    protected remove(item: ListItem): void {
        void this.listService.deleteItem(this.channel().id, item.id);
    }

    protected clearChecked(): void {
        if (!this.canManage() || this.checkedCount() === 0) return;
        void this.listService.clearChecked(this.channel().id);
    }

    protected retry(): void {
        this.listService.reload(this.channel().id);
    }

    // ── Drag reorder ─────────────────────────────────────────────────────────
    //
    // Indices are into the *flat* list, never into a section: sections are a rendering of the one
    // order, and reordering within a section is still reordering the list.

    protected onDragStart(item: ListItem): void {
        if (!this.canReorder()) return;
        this.dragIndex.set(this.items().indexOf(item));
    }

    protected onDragOver(event: DragEvent, item: ListItem): void {
        if (this.dragIndex() === null) return;
        // Without this the browser refuses the drop outright - it is what marks the row a target.
        event.preventDefault();
        this.dragOverIndex.set(this.items().indexOf(item));
    }

    protected onDrop(item: ListItem): void {
        const from = this.dragIndex();
        this.dragIndex.set(null);
        this.dragOverIndex.set(null);
        if (from === null) return;

        const to = this.items().indexOf(item);
        if (to < 0 || to === from) return;
        void this.listService.moveItem(this.channel().id, from, to);
    }

    protected onDragEnd(): void {
        this.dragIndex.set(null);
        this.dragOverIndex.set(null);
    }

    /**
     * Reordering is an edit of the list's shape rather than of one row, so it takes the same bits
     * as adding - and the hide-done filter suppresses it, because dragging within a filtered view
     * describes an order the flat list does not have.
     */
    protected canReorder(): boolean {
        return (this.canAdd() || this.canManage()) && !this.hideChecked();
    }
}
