/**
 * Hide internal agent presets from the remote roster without unregistering them.
 *
 * DSH 0.2.1-rc.2 has no `hidden` field on `PresetDefinition`: every registered
 * preset is listed by the new-session picker. `cowork-topic` and
 * `cowork-reviewer` must stay registered because `sessionController.create` and
 * resume resolve them by id, so the only supported boundary is the remote
 * roster. The `agentPresets/list` endpoint is implemented by
 * `remoteExportList`, which calls the registry's public `list()`; wrapping the
 * remote method filters the picker while `list()`, `resolve()` and `mount()`
 * keep seeing every definition.
 *
 * This is deliberately version-coupled: if a host stops exposing the method,
 * the caller must fail open and log rather than take the plugin down.
 */
import { REVIEWER_PRESET_ID, TOPIC_PRESET_ID } from './presets.js';
/** Presets registered for plugin-created sessions but not offered to the user. */
export const HIDDEN_PRESET_IDS = [TOPIC_PRESET_ID, REVIEWER_PRESET_ID];
/**
 * Filter `hiddenIds` out of the remote preset roster.
 *
 * @returns An idempotent restore function. It only restores the method if this
 * wrapper is still the one installed, so a later owner is never overwritten.
 */
export function hidePresetsFromRoster(service, hiddenIds = HIDDEN_PRESET_IDS) {
    const original = service.remoteExportList;
    if (typeof original !== 'function') {
        throw new Error('agentPresets.remoteExportList is unavailable; internal presets stay visible');
    }
    const hidden = new Set(hiddenIds);
    const ownDescriptor = Object.getOwnPropertyDescriptor(service, 'remoteExportList');
    const filtered = async () => {
        const roster = await original.call(service);
        return {
            ...roster,
            presets: roster.presets.filter((row) => !hidden.has(row.id)),
        };
    };
    Object.defineProperty(service, 'remoteExportList', {
        configurable: true,
        writable: true,
        value: filtered,
    });
    let restored = false;
    return () => {
        if (restored)
            return;
        restored = true;
        if (service.remoteExportList !== filtered)
            return;
        if (ownDescriptor === undefined) {
            Reflect.deleteProperty(service, 'remoteExportList');
        }
        else {
            Object.defineProperty(service, 'remoteExportList', ownDescriptor);
        }
    };
}
//# sourceMappingURL=preset-visibility.js.map