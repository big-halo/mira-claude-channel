// Single source of truth for the plugin's version. Keep this in sync with
// `plugins/mira/package.json`'s `version` field until a follow-up generates
// one from the other (see docs/auto-update.md, MIR-231).
export const PLUGIN_VERSION = '0.1.0'

// Canonical name of this plugin as it appears in the marketplace manifest's
// `plugins[]` entries. Used by the auto-update check to locate our entry.
export const PLUGIN_MANIFEST_NAME = 'mira'
