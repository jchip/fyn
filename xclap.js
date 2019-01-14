"use strict";

const Fs = require("fs");
const Path = require("path");
const mkdirp = require("mkdirp");
const rimraf = require("rimraf");
const xclap = require("xclap");
const _ = require("lodash");

require("electrode-archetype-njs-module-dev")();

const pkgFile = Path.resolve("package.json");
let pkgData;

function readPkg() {
  if (!pkgData) {
    pkgData = Fs.readFileSync(pkgFile);
  }

  return pkgData;
}

xclap.load("fyn", {
  prepack: {
    task: () => {
      const dist = Path.resolve("dist");
      const data = readPkg();
      const pkg = JSON.parse(data);
      delete pkg.scripts;
      pkg.dependencies = _.pick(pkg.dependencies, "node-gyp");
      delete pkg.nyc;
      delete pkg.devDependencies;
      rimraf.sync(dist);
      mkdirp.sync(dist);
      const fmSrc = require.resolve("flat-module/flat-module.js");
      const fmDist = Path.join(dist, "flat-module.js");
      Fs.writeFileSync(fmDist, Fs.readFileSync(fmSrc));

      mkdirp.sync(Path.resolve(".tmp"));
      Fs.writeFileSync(Path.resolve(".tmp/package.json"), data);
      Fs.writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`);
    }
  },

  postpack: {
    task: () => {
      Fs.writeFileSync(pkgFile, readPkg());
    }
  },

  ".prepare": ["fyn/prepack", "fyn/bundle"],

  release: {
    desc: "Release a new version to npm.  package.json must be updated.",
    task: ["fyn/.prepare", "fyn/publish"],
    finally: ["fyn/postpack"]
  },

  bundle: "webpack",

  publish: "npm publish"
});
