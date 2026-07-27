/* Minimal ambient declarations for the Node built-ins the test suite uses.
 *
 * The extension itself never runs under Node (it targets the GJS runtime), so
 * pulling in the full `@types/node` package would add Node globals to the main
 * build's type graph and clash with the @girs GNOME ambient types. These tests
 * only touch `node:test` and `node:assert/strict`, so declare just those.
 *
 * SPDX-License-Identifier: MIT OR LGPL-2.0-or-later
 */

declare module 'node:test' {
    export function test(name: string, fn: () => void | Promise<void>): void;
}

declare module 'node:assert/strict' {
    interface StrictAssert {
        equal(actual: unknown, expected: unknown, message?: string): void;
        deepEqual(actual: unknown, expected: unknown, message?: string): void;
    }
    const assert: StrictAssert;
    export default assert;
}
