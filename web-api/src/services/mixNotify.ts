// The per-user Mix notification log (see docs/MIX_API.md section 5).
//
// Every notification gets its user's next sequence number. The client
// applies one only if it is exactly one past the last it saw and rejects
// 0, so a number must never be handed out without its row: callers that
// write several notifications (or a notification plus other rows) do it
// inside inTransaction.
import * as db from "../database.ts";
import { generateId } from "../routes/mix/common.ts";

export type MixNotification = {
    Created: number;
    NotificationId: number;
    SequenceNumber: number;
    [k: string]: unknown;
};

/** Stores a notification for one user and returns it with its sequence number. */
export function notify(swid: string, type: string, fields: object): MixNotification {
    const notification: MixNotification = { Created: Date.now(), NotificationId: generateId(), SequenceNumber: 0, ...fields };
    db.addMixPendingNotification(swid, type, notification);
    return notification;
}

/** One notification per user, all in one transaction. Returns them by swid. */
export function notifyMany(swids: string[], type: string, build: (swid: string) => object): Map<string, MixNotification> {
    return db.inTransaction(() => {
        const out = new Map<string, MixNotification>();
        for (const swid of swids) out.set(swid, notify(swid, type, build(swid)));
        return out;
    });
}
