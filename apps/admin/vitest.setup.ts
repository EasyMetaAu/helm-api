// Adds jest-dom matchers (toBeInTheDocument, toBeDisabled, ...) to Vitest's
// expect for the jsdom-based admin component tests.
import '@testing-library/jest-dom/vitest';

function createMemoryStorage(): Storage {
  const backing = new Map<string, string>();
  return {
    get length() {
      return backing.size;
    },
    clear() {
      backing.clear();
    },
    getItem(key: string) {
      return backing.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(backing.keys())[index] ?? null;
    },
    removeItem(key: string) {
      backing.delete(key);
    },
    setItem(key: string, value: string) {
      backing.set(key, String(value));
    },
  };
}

function hasUsableLocalStorage(): boolean {
  try {
    return (
      typeof localStorage !== 'undefined' &&
      typeof localStorage.clear === 'function' &&
      typeof localStorage.getItem === 'function' &&
      typeof localStorage.setItem === 'function'
    );
  } catch {
    return false;
  }
}

if (!hasUsableLocalStorage()) {
  const storage = createMemoryStorage();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: storage,
  });
  if (typeof window !== 'undefined') {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: storage,
    });
  }
}

// jsdom does not implement Element.scrollIntoView. The policies page scrolls a
// newly-added row into view (commit 51974fc); without this stub that call throws
// an UNHANDLED REJECTION inside the async addRow handler, which Vitest surfaces as
// a run-level error → `pnpm test` exits non-zero even though every test passes.
// Stub it as a no-op so component tests exercise the handler without the jsdom gap.
if (typeof Element !== 'undefined' && typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = () => {};
}
