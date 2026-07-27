import {TestBed} from '@angular/core/testing';
import {Router} from '@angular/router';
import {BotInstallDialogService} from './bot-install-dialog.service';
import {AuthService} from '../../services/auth.service';

const PARAMS = {clientId: 'client_1', permissions: 513n, guildId: undefined, redirectUri: undefined, state: undefined};

function setup(isLoggedIn: boolean) {
    const authService = {isLoggedIn: vi.fn(() => Promise.resolve(isLoggedIn))};
    const router = {navigate: vi.fn()};

    TestBed.configureTestingModule({
        providers: [
            {provide: AuthService, useValue: authService},
            {provide: Router, useValue: router},
        ],
    });

    return {
        service: TestBed.inject(BotInstallDialogService),
        authService,
        router,
    };
}

describe('BotInstallDialogService.requestOpen', () => {
    it('sets request() directly when the user is logged in', async () => {
        const {service} = setup(true);
        await service.requestOpen(PARAMS);
        expect(service.request()).toEqual(PARAMS);
    });

    it('does not navigate when the user is logged in', async () => {
        const {service, router} = setup(true);
        await service.requestOpen(PARAMS);
        expect(router.navigate).not.toHaveBeenCalled();
    });

    it('navigates to /authentication and does not set request() when logged out', async () => {
        const {service, router} = setup(false);
        await service.requestOpen(PARAMS);
        expect(router.navigate).toHaveBeenCalledWith(['/authentication']);
        expect(service.request()).toBeNull();
    });
});

describe('BotInstallDialogService.resumeIfPending', () => {
    it('opens the stashed link after a logged-out requestOpen', async () => {
        const {service} = setup(false);
        await service.requestOpen(PARAMS);
        expect(service.request()).toBeNull();

        service.resumeIfPending();
        expect(service.request()).toEqual(PARAMS);
    });

    it('is a no-op the second time (stash drained)', async () => {
        const {service} = setup(false);
        await service.requestOpen(PARAMS);
        service.resumeIfPending();
        service.close();

        service.resumeIfPending();
        expect(service.request()).toBeNull();
    });

    it('is a no-op when nothing was ever stashed', () => {
        const {service} = setup(true);
        service.resumeIfPending();
        expect(service.request()).toBeNull();
    });
});

describe('BotInstallDialogService.close', () => {
    it('clears request()', async () => {
        const {service} = setup(true);
        await service.requestOpen(PARAMS);
        service.close();
        expect(service.request()).toBeNull();
    });
});
