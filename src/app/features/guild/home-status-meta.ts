import {HomeStatusKind} from '../../dtos/response/home-status.dto';

/**
 * How each home-status kind reads.
 *
 * <p>Icon plus a <i>word</i>, never a coloured dot on the avatar: the avatar dot is connection
 * presence and means something else entirely. Someone can be online and out, or offline and asleep
 * in the next room, and both have to stay readable.</p>
 */
export interface HomeStatusMeta {
    kind: HomeStatusKind;
    icon: string;
    labelKey: string;
    /** Tailwind text colour. Distinct from the online/idle/dnd ramp on purpose. */
    tone: string;
}

/**
 * One table, shared by the board and the home digest.
 *
 * <p>Both surfaces draw the same five kinds, and a second copy is exactly how "Out" ends up sky
 * blue in one place and amber in the other.</p>
 */
export const HOME_STATUS_META: readonly HomeStatusMeta[] = [
    {kind: HomeStatusKind.Home, icon: 'pi pi-home', labelKey: 'HOME_STATUS.KIND.HOME', tone: 'text-emerald-300'},
    {kind: HomeStatusKind.Out, icon: 'pi pi-sign-out', labelKey: 'HOME_STATUS.KIND.OUT', tone: 'text-sky-300'},
    {kind: HomeStatusKind.Asleep, icon: 'pi pi-moon', labelKey: 'HOME_STATUS.KIND.ASLEEP', tone: 'text-indigo-300'},
    {
        kind: HomeStatusKind.DoNotDisturb,
        icon: 'pi pi-ban',
        labelKey: 'HOME_STATUS.KIND.DO_NOT_DISTURB',
        tone: 'text-rose-300',
    },
    {kind: HomeStatusKind.OnMyWay, icon: 'pi pi-send', labelKey: 'HOME_STATUS.KIND.ON_MY_WAY', tone: 'text-amber-300'},
];

/** Falls back to Home rather than to nothing, so an unknown kind still draws a row. */
export function homeStatusMeta(kind: HomeStatusKind): HomeStatusMeta {
    return HOME_STATUS_META.find(m => m.kind === kind) ?? HOME_STATUS_META[0];
}
