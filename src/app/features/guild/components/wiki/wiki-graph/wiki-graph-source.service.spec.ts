import {TestBed} from '@angular/core/testing';
import {HttpErrorResponse} from '@angular/common/http';
import {of, Subject, throwError} from 'rxjs';
import {WikiGraphSourceService} from './wiki-graph-source.service';
import {WikiService} from '../../../../../services/wiki.service';

const graph = {nodes: [{id: 'p1', title: 'One'}], edges: []};

describe('WikiGraphSourceService', () => {
    let service: WikiGraphSourceService;
    let getGraph: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        getGraph = vi.fn(() => of(graph));
        TestBed.configureTestingModule({providers: [{provide: WikiService, useValue: {getGraph}}]});
        service = TestBed.inject(WikiGraphSourceService);
    });

    it('holds the graph per guild', () => {
        service.load('g1');
        expect(getGraph).toHaveBeenCalledWith('g1');
        expect(service.graphs().get('g1')).toBe(graph);
        expect(service.loading()).toBe(false);
    });

    it('loads once per guild and refreshes on demand', () => {
        service.load('g1');
        service.load('g1');
        expect(getGraph).toHaveBeenCalledTimes(1);
        service.refresh('g1');
        expect(getGraph).toHaveBeenCalledTimes(2);
    });

    it('ignores a second fetch while one is in flight', () => {
        getGraph.mockReturnValue(new Subject<never>());
        service.refresh('g1');
        service.refresh('g1');
        expect(getGraph).toHaveBeenCalledTimes(1);
        expect(service.loading()).toBe(true);
    });

    // The client and the server deploy separately, so a 404 is a server that has not caught up.
    it('reads a 404 as the endpoint being absent, not as a failure', () => {
        getGraph.mockReturnValue(throwError(() => new HttpErrorResponse({status: 404})));
        service.refresh('g1');
        expect(service.absent()).toBe(true);
        expect(service.failed()).toBe(false);
    });

    it('reads any other error as a failure, so nothing falls back on it', () => {
        getGraph.mockReturnValue(throwError(() => new HttpErrorResponse({status: 500})));
        service.refresh('g1');
        expect(service.failed()).toBe(true);
        expect(service.absent()).toBe(false);
    });

    it('clears absent once the endpoint answers', () => {
        getGraph.mockReturnValueOnce(throwError(() => new HttpErrorResponse({status: 404})));
        service.refresh('g1');
        service.refresh('g1');
        expect(service.absent()).toBe(false);
        expect(service.graphs().get('g1')).toBe(graph);
    });
});
