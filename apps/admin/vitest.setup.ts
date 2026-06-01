// Adds jest-dom matchers (toBeInTheDocument, toBeDisabled, ...) to Vitest's
// expect for the jsdom-based admin component tests.
import '@testing-library/jest-dom/vitest';

// jsdom does not implement Element.scrollIntoView. The policies page scrolls a
// newly-added row into view (commit 51974fc); without this stub that call throws
// an UNHANDLED REJECTION inside the async addRow handler, which Vitest surfaces as
// a run-level error → `pnpm test` exits non-zero even though every test passes.
// Stub it as a no-op so component tests exercise the handler without the jsdom gap.
if (typeof Element !== 'undefined' && typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = () => {};
}
