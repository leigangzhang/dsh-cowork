import type { CoworkToolDeps } from './tool-runtime.js';
/**
 * Register the twenty-two cowork tools and return their disposers. The caller owns
 * the effect scope; this function only composes the domain registrars, in the
 * documented order (the review tools before memory, merge last).
 */
export declare function registerCoworkTools(ctx: unknown, deps: CoworkToolDeps): Array<() => void>;
