"use strict";

/* eslint-disable no-magic-numbers, max-params, max-statements, no-empty */

const Path = require("path");
const Fs = require("./util/file-ops");
const ssri = require("ssri");
const Tar = require("tar");
const Promise = require("bluebird");
const { linkFile } = require("./util/hard-link-dir");
const uniqId = require("./util/uniq-id");

const isWin32 = process.platform === "win32";

const RENAME_RETRIES = isWin32 ? 10 : 0;

function flattenTree(tree, output, baseDir) {
  const dirs = Object.keys(tree);

  for (const dir of dirs) {
    if (dir === "/") continue;
    const fdir = Path.join(baseDir, dir);
    output.dirs.push(fdir);
    flattenTree(tree[dir], output, fdir);
  }

  const files = Object.keys(tree["/"]);
  for (const file of files) {
    output.files.push(Path.join(baseDir, file));
  }

  return output;
}

function retry(func, checks, tries, wait) {
  return Promise.try(func).catch(err => {
    if (tries <= 0) throw err;
    tries--;
    return Promise.try(
      () => (Array.isArray(checks) ? checks.indexOf(err.code) >= 0 : checks(err))
    ).then(canRetry => {
      if (!canRetry) throw err;
      return Promise.delay(wait).then(() => retry(func, tries, wait));
    });
  });
}

class FynCentral {
  constructor({ centralDir = ".fyn/_central-storage" }) {
    this._centralDir = Path.resolve(centralDir);
    this._map = new Map();
  }

  _analyze(integrity) {
    const sri = ssri.parse(integrity, { single: true });

    const algorithm = sri.algorithm;
    const hex = sri.hexDigest();

    const segLen = 2;
    const contentPath = Path.join(
      ...[this._centralDir, algorithm].concat(
        hex.substr(0, segLen),
        hex.substr(segLen, segLen),
        hex.substr(segLen * 2)
      )
    );

    return { algorithm, contentPath, hex };
  }

  async _loadTree(integrity, info) {
    info = info || this._analyze(integrity);
    info.tree = false;
    try {
      const stat = await Fs.stat(info.contentPath);
      if (stat.isDirectory()) {
        const tree = await Fs.readFile(Path.join(info.contentPath, "tree.json")).then(JSON.parse);
        info.tree = tree;
        this._map.set(integrity, info);
      }
      return info;
    } catch (err) {
      return info;
    }
  }

  async has(integrity) {
    if (this._map.has(integrity)) return true;
    const info = this._loadTree(integrity);
    return Boolean(info.tree);
  }

  async get(integrity) {
    return await this.getInfo(integrity).contentPath;
  }

  async getInfo(integrity) {
    if (this._map.has(integrity)) return this._map.get(integrity);
    const info = await this._loadTree(integrity);
    if (!info.tree) {
      throw new Error("fyn-central can't get package for integrity", integrity);
    }
    return info;
  }

  async replicate(integrity, destDir) {
    const info = await this.getInfo(integrity);

    const list = flattenTree(info.tree, { dirs: [], files: [] }, "");

    await Promise.map(list.dirs, dir => Fs.$.mkdirp(Path.join(destDir, dir)), { concurrency: 10 });

    await Promise.map(
      list.files,
      file => linkFile(Path.join(info.contentPath, "package", file), Path.join(destDir, file)),
      { concurrency: 10 }
    );
  }

  _untarStream(tarStream, targetDir) {
    const dirTree = { "/": {} };
    const strip = 1;
    return new Promise((resolve, reject) => {
      const stream = tarStream.pipe(
        Tar.x({
          strip,
          strict: true,
          C: targetDir,
          onentry: entry => {
            const parts = entry.path.split(/\/|\\/);
            const isDir = entry.type === "Directory";
            const dirs = parts.slice(strip, isDir ? parts.length : parts.length - 1);

            const wtree = dirs.reduce((wt, dir) => {
              return wt[dir] || (wt[dir] = { "/": {} });
            }, dirTree);

            if (isDir) return;

            const fname = parts[parts.length - 1];
            if (fname) {
              const m = Math.round((entry.mtime ? entry.mtime.getTime() : Date.now()) / 1000);
              wtree["/"][fname] = {
                z: entry.size,
                m,
                $: entry.header.cksumValid && entry.header.cksum
              };
            }
          }
        })
      );
      stream.on("error", reject);
      stream.on("close", () => resolve(dirTree));
    });
  }

  async storeTarStream(integrity, stream) {
    const info = await this._loadTree(integrity);
    const has = Boolean(info.tree);

    const tmp = `${info.contentPath}.tmp-${uniqId()}`;
    let removeExist;

    // why is request storing tar stream again?
    // but whatever, just move it out of place and untar.
    // will remove it when new store is ready to be dropped in.
    if (has !== false) {
      removeExist = `${info.contentPath}.remove-${uniqId()}`;
      await retry(
        () => Fs.rename(info.contentPath, removeExist),
        ["EACCESS", "EPERM"],
        RENAME_RETRIES,
        100
      );
    }

    const targetDir = Path.join(tmp, "package");
    await Fs.$.mkdirp(targetDir);
    const tree = await this._untarStream(stream, targetDir, info);

    await Fs.writeFile(Path.join(tmp, "tree.json"), JSON.stringify(tree));

    info.tree = tree;

    let exist;

    try {
      await retry(
        () => Fs.rename(tmp, info.contentPath),
        err => {
          if (err.code === "EACCESS") return true;
          // don't bother if another concurrent fyn install got to it first
          // so only retry if target does not exist
          // and remember it in order to delete the tmp work
          if (err.code === "EPERM") return Fs.exists(info.contentPath).then(x => !(exist = x));

          return false;
        },
        RENAME_RETRIES,
        100
      );
    } catch (err) {
      // rename could fail with ENOTEMPTY if another fyn process got to it first
      if (!exist && err.code !== "ENOTEMPTY") throw err;
      // all that hardwork down the drain, oh well, but someone else did it first.
      await Fs.$.rimraf(tmp);
    }

    this._map.set(integrity, info);

    if (removeExist) {
      try {
        await Fs.$.rimraf(removeExist);
      } catch (err) {}
    }
  }
}

module.exports = FynCentral;