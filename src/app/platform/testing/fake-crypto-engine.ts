import {CryptoEngine} from '../ports/crypto-engine.port';
import {EngineHandler, RecordedEngineCall} from './fake-mls-engine';

/**
 * A {@link CryptoEngine} for specs, provided in TestBed in place of an adapter.
 *
 * <p>Same shape as {@link FakeMlsEngine} and no `available` flag, matching the port: there is no useful
 * client without key generation, so an unavailable crypto engine is a boot failure rather than a
 * capability to branch on.</p>
 *
 * <p>It records `(command, args)` because that pairing is what C2 broke: `rewrap_master_key` was invoked
 * with three of its five arguments, every call failed at argument deserialization before any crypto
 * ran, and a user mid-recovery holding a correct recovery code was told it was wrong. The assertions in
 * `master-key.service.spec.ts` are about the argument names for exactly that reason.</p>
 */
export class FakeCryptoEngine extends CryptoEngine {
    readonly calls: RecordedEngineCall[] = [];

    /** Answers every command when set. Takes precedence over {@link result} and {@link rejection}. */
    handler: EngineHandler | undefined;

    result: unknown = undefined;

    rejection: unknown = undefined;

    async call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
        this.calls.push({command, args});

        if (this.handler) return (await this.handler(command, args)) as T;
        if (this.rejection !== undefined) throw this.rejection;
        return this.result as T;
    }

    lastCall(command?: string): RecordedEngineCall | undefined {
        const matching =
            command === undefined ? this.calls : this.calls.filter(call => call.command === command);
        return matching.at(-1);
    }

    reset(): void {
        this.calls.length = 0;
        this.handler = undefined;
        this.result = undefined;
        this.rejection = undefined;
    }
}
