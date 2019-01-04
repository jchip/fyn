"use strict";

const _ = require("lodash");
const Path = require("path");
const xenvConfig = require("xenv-config");

const defaultConfig = {
  registry: "http://localhost:4873",
  pkgFile: "package.json",
  targetDir: "xout",
  fynDir: Path.resolve(".fyn"),
  centralStore: false
};

const spec = {
  registry: { env: "FYN_REGISTRY", type: "string" },
  pkgFile: { env: "FYN_PACKAGE_FILE", type: "string" },
  targetDir: { env: "FYN_TARGET_DIR", type: "string" },
  fynDir: {
    env: ["FYN_DIR", "USERPROFILE", "HOME"],
    type: "string",
    post: (v, t) => {
      if ((t.src === "env" && t.name !== "FYN_DIR") || t.src === "default") {
        return Path.join(v, ".fyn");
      }
      return v;
    }
  },
  centralStore: { env: "FYN_CENTRAL_STORE", type: "boolean" }
};

module.exports = function fynConfig(override) {
  const configKeys = Object.keys(spec);
  const userConfig = _.pick(override, configKeys);
  const config = xenvConfig(spec, userConfig, { sources: ["option", "env"] });
  config.fynCacheDir = Path.join(config.fynDir, "_cacache");
  config.lockfile = true;

  const x = Object.assign(config, _.omit(override, configKeys));
  console.log(JSON.stringify(config, null, 2));
  return x;
};
