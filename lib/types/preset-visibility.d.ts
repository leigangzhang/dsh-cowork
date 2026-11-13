/** Presets registered for plugin-created sessions but not offered to the user. */
export declare const HIDDEN_PRESET_IDS: readonly ["cowork-topic", "cowork-reviewer"];
/** The roster row fields this module needs. */
export interface PresetRosterRow {
    readonly id: string;
    readonly isDefault: boolean;
}
/** The host's remote preset roster. */
export interface PresetRoster {
    readonly presets: readonly PresetRosterRow[];
}
/** The host service slice this module wraps. */
export interface PresetRosterService {
    remoteExportList(): Promise<PresetRoster>;
}
/**
 * Filter `hiddenIds` out of the remote preset roster.
 *
 * @returns An idempotent restore function. It only restores the method if this
 * wrapper is still the one installed, so a later owner is never overwritten.
 */
export declare function hidePresetsFromRoster(service: PresetRosterService, hiddenIds?: readonly string[]): () => void;
