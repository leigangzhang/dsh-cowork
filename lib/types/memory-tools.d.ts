import type { CoworkToolDeps } from './tool-runtime.js';
/** The two memory tools, registered in the documented order. */
export declare function registerMemoryTools(ctx: unknown, deps: CoworkToolDeps): Array<() => void>;
