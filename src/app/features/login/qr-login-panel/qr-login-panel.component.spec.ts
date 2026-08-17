import {ComponentFixture, TestBed} from '@angular/core/testing';
import {Subject} from 'rxjs';
import {provideTranslateService} from '@ngx-translate/core';
import {QrLoginPanelComponent} from './qr-login-panel.component';
import {QrLoginService} from '../../../services/qr-login.service';
import {QrLoginStartResponse} from '../../../dtos/response/qr-login.dto';

describe('QrLoginPanelComponent', () => {
    let fixture: ComponentFixture<QrLoginPanelComponent>;
    let starts: Subject<QrLoginStartResponse>[];

    beforeEach(async () => {
        starts = [];

        const qrStub = {
            start: () => {
                const s = new Subject<QrLoginStartResponse>();
                starts.push(s);
                return s.asObservable();
            },
            status: () => new Subject().asObservable(),
            exchange: () => new Subject().asObservable(),
        };

        await TestBed.configureTestingModule({
            imports: [QrLoginPanelComponent],
            providers: [
                provideTranslateService(),
                {provide: QrLoginService, useValue: qrStub},
            ],
        }).compileComponents();

        fixture = TestBed.createComponent(QrLoginPanelComponent);
        fixture.componentRef.setInput('serverUrl', 'https://api.venta.gg');
    });

    afterEach(() => fixture.destroy());

    /**
     * Regression guard. start() reads the `state` signal and writes it on every transition,
     * so if the restart effect tracks that read, each write re-runs the effect and the panel
     * mints pairing codes in a tight loop against /qr-login/start.
     */
    it('requests exactly one pairing code per server', () => {
        fixture.detectChanges();
        expect(starts.length).toBe(1);

        // The transition that used to feed back into the effect.
        starts[0].next({code: 'abc', expiresInSeconds: 180});
        fixture.detectChanges();

        expect(starts.length).toBe(1);
    });

    it('starts a new pairing when the server changes', () => {
        fixture.detectChanges();
        starts[0].next({code: 'abc', expiresInSeconds: 180});
        fixture.detectChanges();

        fixture.componentRef.setInput('serverUrl', 'https://chat.selfhosted.com');
        fixture.detectChanges();

        expect(starts.length).toBe(2);
    });
});
