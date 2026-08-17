import {computed, inject, Injectable} from '@angular/core';
import {ApiConfigService} from './api-config.service';
import {ExternalLinkService} from './external-link.service';
import {appealUrl, supportUrl} from '../core/support-url';

/**
 * The way out of the app and onto the support site.
 *
 * <p>Every link is derived from whichever server the active slot is pointed at, so a self-hosted
 * account reaches its own instance's support rather than ours. See {@link supportUrl} for why the
 * derivation replaces the first label instead of prefixing one.</p>
 *
 * <p>The signed-out call sites pass an explicit API base: on the login screen the server comes from
 * the `user@server` identity being typed, and {@link ApiConfigService.baseUrl} has not been pointed
 * at it yet when a sign-in is refused.</p>
 */
@Injectable({providedIn: 'root'})
export class SupportService {
    private apiConfig = inject(ApiConfigService);
    private links = inject(ExternalLinkService);

    /** The support site for the account that is currently signed in. */
    readonly url = computed(() => supportUrl(this.apiConfig.baseUrl()));

    supportUrlFor(apiBase?: string): string {
        return supportUrl(apiBase ?? this.apiConfig.baseUrl());
    }

    appealUrlFor(apiBase?: string): string {
        return appealUrl(apiBase ?? this.apiConfig.baseUrl());
    }

    openSupport(apiBase?: string): void {
        void this.links.openExternalLink(this.supportUrlFor(apiBase));
    }

    openAppeal(apiBase?: string): void {
        void this.links.openExternalLink(this.appealUrlFor(apiBase));
    }
}
