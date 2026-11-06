import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { pluginDir, PLUGIN_ID } from "./data-dir";

const previousHome = process.env.PASEO_HOME;

afterEach(() => {
  if (previousHome === undefined) delete process.env.PASEO_HOME;
  else process.env.PASEO_HOME = previousHome;
});

describe("the data directory", () => {
  it("is under plugin-data, not under Paseo's install root", () => {
    process.env.PASEO_HOME = "/tmp/paseo-home";
    expect(pluginDir()).toBe(join("/tmp/paseo-home", "plugin-data", PLUGIN_ID));
  });
});
