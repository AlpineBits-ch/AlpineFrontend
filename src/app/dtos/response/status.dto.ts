/**
 * The platform status surface (`/api/v1/status/*`).
 *
 * <p>Every enum here is <b>open</b>. The server is free to add values and this client must never
 * crash on one, and never guess upward: an unrecognised value renders as the least alarming thing
 * the surface has, never as an outage. That is why each is typed as its known union plus
 * `(string & {})` rather than a closed union or a TypeScript `enum` - the known members still
 * autocomplete and still narrow in a `switch`, but an unknown string is assignable, so parsing a
 * live response can never produce a value the type says is impossible.</p>
 */

/** Overall platform state. Anything other than `operational` means a banner. */
export type StatusIndicator =
    | 'operational' | 'degraded' | 'partial_outage' | 'major_outage' | 'maintenance'
    | (string & {});

/** How loud the banner is allowed to be. */
export type StatusSeverity = 'info' | 'warning' | 'critical' | (string & {});

/** Per-component state, shown only on the platform status settings page. */
export type ComponentStatus =
    | 'operational' | 'degraded_performance' | 'partial_outage' | 'major_outage'
    | 'under_maintenance'
    | (string & {});

export type IncidentKind = 'incident' | 'maintenance' | (string & {});

export type IncidentImpact = 'none' | 'minor' | 'major' | 'critical' | (string & {});

/** `investigating | identified | monitoring | resolved` for incidents, the scheduled set for maintenance. */
export type IncidentStatus =
    | 'investigating' | 'identified' | 'monitoring' | 'resolved'
    | 'scheduled' | 'in_progress' | 'completed' | 'cancelled'
    | (string & {});

/** Non-null when the incident came from the generated table; see `StatusBannerComponent`. */
export type IncidentTemplate =
    | 'elevated_errors' | 'unavailable' | 'recovered'
    | (string & {});

/**
 * The copy to render, composed server-side.
 *
 * <p>The client never writes any of it. The server owns how technical a status message is allowed
 * to be, and a client that assembles its own sentence out of a component name and a status enum
 * puts that rule in three codebases at once.</p>
 */
export interface StatusBannerDto {
    title: string;
    body: string;
    severity: StatusSeverity;
    incidentReference: string;
    url: string;
    /** `null` for staff-written incidents, which are free text and are never translated. */
    template: IncidentTemplate | null;
    /** `null` when more than one component is affected. */
    componentKey: string | null;
}

export interface StatusComponentDto {
    /** Stable. Switch on this, never on `name`. */
    key: string;
    name: string;
    description: string;
    status: ComponentStatus;
    statusSince: string;
    /** Fraction, not a percentage: `0.9987` is 99.87 %. */
    uptime90d: number;
}

export interface IncidentUpdateDto {
    status: IncidentStatus;
    body: string;
    template: IncidentTemplate | null;
    postedAt: string;
}

export interface IncidentDto {
    reference: string;
    kind: IncidentKind;
    title: string;
    impact: IncidentImpact;
    status: IncidentStatus;
    components: string[];
    /** Incidents carry these two. */
    startedAt?: string;
    resolvedAt?: string | null;
    /** Maintenance windows carry these two instead. */
    scheduledFor?: string;
    scheduledUntil?: string;
    template: IncidentTemplate | null;
    url: string;
    /** Newest first. Omitted on `recent` entries. */
    updates?: IncidentUpdateDto[];
}

/** The one response the whole feature is built on. */
export interface StatusSummaryDto {
    indicator: StatusIndicator;
    updatedAt: string;
    /** Present only when `indicator !== 'operational'`. */
    banner: StatusBannerDto | null;
    components: StatusComponentDto[];
    incidents: IncidentDto[];
    /** Active and upcoming windows, `kind === 'maintenance'`. */
    maintenance: IncidentDto[];
    /** Last seven resolved, without `updates`. */
    recent: IncidentDto[];
}

/** Payload of the `status.IncidentUpdated` hub event. */
export interface IncidentUpdatedDto {
    incident: IncidentDto;
}
