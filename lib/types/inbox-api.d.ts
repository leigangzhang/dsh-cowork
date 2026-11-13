import type { CoworkApiPorts, CoworkStorePort, PanelFetchRoute } from './api.js';
/** Placeholder topic title for a topic the index no longer lists. */
export declare const INBOX_ARCHIVED_TOPIC_TITLE = "\u5DF2\u5F52\u6863\u4E3B\u9898";
/**
 * The route plumbing `src/api.ts` already owns: project discovery from a
 * session id, the bounded JSON body reader, the one JSON response, and the
 * same-origin + error-envelope wrapper. Injected as a value (not imported) so
 * this module never imports `src/api.ts` at runtime and the two stay acyclic.
 */
export interface InboxApiKit {
    openProject(sessionId: string): Promise<{
        store: CoworkStorePort;
        repoPath: string;
    }>;
    readJsonBody(request: Request): Promise<Record<string, unknown>>;
    jsonResponse(status: number, payload: unknown): Response;
    serve(handler: (request: Request) => Promise<Response>): (request: Request) => Promise<Response>;
}
/** The three inbox routes, in contract order: read, resolve, open. */
export declare function inboxPanelRoutes(ports: CoworkApiPorts, kit: InboxApiKit): PanelFetchRoute[];
