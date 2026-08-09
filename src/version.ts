/**
 * Part of the report's identity: the report is a pure function of (source
 * content, config, thicket version), and the version is printed in the header
 * and folded into the config hash so a tool upgrade invalidates the cache.
 * Kept in source rather than read from package.json so `dist/` needs no
 * runtime file lookup relative to itself.
 */
export const VERSION = "0.1.0";
