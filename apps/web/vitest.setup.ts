import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// RTL's own auto-cleanup only registers when it detects global test hooks
// (test.globals in vitest config), which this project doesn't enable — so
// register it explicitly to unmount between tests in the same file.
afterEach(() => {
  cleanup();
});
