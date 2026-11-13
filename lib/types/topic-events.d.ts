import type { ActivityEvent, ProjectIndexV2 } from './store-schema.js';
/** The host Session as far as this module reads it. */
export interface TopicEventSession {
    readonly id: string;
    readonly header?: {
        readonly cwd?: string;
    };
}
/** The host session event as far as this module reads it. */
export interface TopicEventLike {
    readonly type: string;
}
/** The store operations the listener needs; `ProjectStore` satisfies it. */
export interface TopicEventStorePort {
    readIndexDocument(): Promise<ProjectIndexV2>;
    mutateIndexDocument(mutator: (document: ProjectIndexV2) => ProjectIndexV2 | null): Promise<ProjectIndexV2>;
    appendActivity(event: ActivityEvent): Promise<void>;
}
/** Everything the listener touches, injected so it can run host-free. */
export interface TopicEventsPorts {
    onSessionEvent(listener: (session: TopicEventSession, event: TopicEventLike) => void): () => void;
    resolveRepoPath(session: TopicEventSession): Promise<string | null> | string | null;
    storeFor(repoPath: string): TopicEventStorePort;
    clock(): Date;
    log?(message: string): void;
}
/** Listen to the host event stream and maintain topic activity and reopening. */
export declare class TopicEvents {
    private readonly ports;
    private dispose;
    constructor(ports: TopicEventsPorts);
    /**
     * Start listening. Idempotent: while attached, a second call returns the same
     * disposer; the disposer is idempotent too. After disposal the next call
     * attaches a fresh listener.
     */
    attach(): () => void;
    /** One event, fully handled or reported through `log`. */
    private handle;
    /**
     * `turn/end`: an idle topic returns to `active` and the activity time moves.
     * A topic this project does not know, or one already resolved, is left alone.
     */
    private trackActivity;
    /**
     * `user/message`: reopen a resolved topic exactly once. The lock-scoped
     * mutator re-checks `resolved`, so a message racing another reopen (or a
     * deleted topic) writes nothing and records no event. The activity event is
     * written after the index commits; if it fails, the reopen stays and only the
     * log records the lost evidence.
     */
    private reopenResolved;
    private log;
}
