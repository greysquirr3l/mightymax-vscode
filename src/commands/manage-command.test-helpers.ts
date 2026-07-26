/**
 * Test helpers shared between manage-command.test.ts and
 * flight-deck-view.test.ts. Lives in `src/commands/` (rather than
 * `src/test-helpers/`) because both consumers live here.
 */

import type { SecretStore } from '../ports/secret-store.js';

/**
 * In-memory SecretStore. Mirrors `vscode.SecretStorage` semantics
 * (Promise-returning methods, undefined for missing keys) — but
 * with the `mightyMax.` namespace already baked into the key paths
 * to match the production `SecretStoreAdapter`.
 */
export function createInMemorySecretStore(): SecretStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    // The SecretStore port is async at the type level even though the
    // test double has no real I/O — Promise.resolve keeps the linter
    // happy without forcing the test to await an extra tick.
    getSecret: (name) => Promise.resolve(data.get(`mightyMax.${name}`)),
    storeSecret: (name, value) => {
      data.set(`mightyMax.${name}`, value);
      return Promise.resolve();
    },
    deleteSecret: (name) => {
      data.delete(`mightyMax.${name}`);
      return Promise.resolve();
    },
    hasSecret: (name) => Promise.resolve(data.has(`mightyMax.${name}`)),
  };
}
