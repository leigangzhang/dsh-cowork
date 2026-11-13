import type { CoworkToolDeps } from './tool-runtime.js';
/** Most topics one status response lists. */
export declare const STATUS_TOPIC_LIMIT = 50;
/** Most undelivered inbox items one status response lists. */
export declare const STATUS_INBOX_LIMIT = 10;
/** Most activity events one status response returns (the stream tail). */
export declare const STATUS_ACTIVITY_LIMIT = 20;
/** Most characters of one topic digest a status response returns. */
export declare const STATUS_DIGEST_MAX_CHARS = 200;
/** Most lifecycle changes one status response reports. */
export declare const STATUS_LIFECYCLE_CHANGES_LIMIT = 10;
/** The two project tools, registered in the documented order. */
export declare function registerProjectTools(ctx: unknown, deps: CoworkToolDeps): Array<() => void>;
