// A Mix API failure with the Status string the SDK sees. Routes catch it
// and reply res.status(e.http).json({ Status: e.status }); any other error
// is a 500.
export class MixError extends Error {
    constructor(public status: string, public http: 400 | 401 | 404 = 400) {
        super(status);
    }
}

/** Runs a route body and maps MixError to its reply. */
export function mixRoute(res: any, fn: () => object): void {
    try {
        res.json(fn());
    } catch (e) {
        if (e instanceof MixError) {
            res.status(e.http).json({ Status: e.status });
            return;
        }
        throw e;
    }
}
