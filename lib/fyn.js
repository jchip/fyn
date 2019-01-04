"use strict";

const Path = require("path");
const assert = require("assert");
const semver = require("semver");
const _ = require("lodash");
const logger = require("./logger");
const PkgDepResolver = require("./pkg-dep-resolver");
const PkgDistFetcher = require("./pkg-dist-fetcher");
const PkgSrcManager = require("./pkg-src-manager");
const PkgDepLocker = require("./pkg-dep-locker");
const DepData = require("./dep-data");
const semverUtil = require("./util/semver");
const Fs = require("./util/file-ops");
const fyntil = require("./util/fyntil");
const FynCentral = require("./fyn-central");

const { PACKAGE_RAW_INFO } = require("./symbols");
const { FYN_IGNORE_FILE } = require("./constants");

/* eslint-disable no-magic-numbers, max-statements, no-empty */

class Fyn {
  constructor(options) {
    this._options = options || {};
    this._cwd = options.cwd || process.cwd();
    logger.debug(`fyn options`, JSON.stringify(options));
    this.localPkgWithNestedDep = [];
    if (options.lockTime) {
      this._lockTime = new Date(options.lockTime);
      logger.info("dep lock time set to", this._lockTime.toString());
    }
  }

  async _initialize() {
    if (!this._pkg) {
      const options = this._options;

      await this.loadPkg(options);
      this._pkgSrcMgr =
        options.pkgSrcMgr || new PkgSrcManager(Object.assign({ fyn: this }, options));
      this._data = options.data || new DepData();
      this._depLocker = new PkgDepLocker(this.lockOnly, options.lockfile);
      await this._depLocker.read(Path.join(this._cwd, "fyn-lock.yaml"));
      this._central =
        options.centralStore &&
        new FynCentral({ centralDir: Path.join(this.fynDir, "_central-storage") });
    }
  }

  async loadPkg(options) {
    if (options.pkgFile) {
      const pkgFile = Path.resolve(this._cwd, options.pkgFile);
      logger.debug("package.json file", pkgFile);
      this._pkgFile = pkgFile;
      try {
        this._pkg = await this.loadPackageJsonFile(pkgFile);
      } catch (err) {
        logger.error("failed to read package.json file", pkgFile);
        logger.error(err.message);
        fyntil.exit(err);
      }
    } else {
      this._pkg = options.pkgData;
    }
  }

  savePkg() {
    Fs.writeFileSync(this._pkgFile, `${JSON.stringify(this._pkg, null, 2)}\n`);
  }

  get copy() {
    return this._options.copy || [];
  }

  get central() {
    return this._central;
  }

  get flatMeta() {
    return this._options.flatMeta;
  }

  get depLocker() {
    return this._depLocker;
  }

  get cwd() {
    return this._cwd;
  }

  get forceCache() {
    return this._options.forceCache && "force-cache";
  }

  get registry() {
    return this._options.registry;
  }

  // offline will disable all remote retrieving
  get offline() {
    return this._options.offline && "offline";
  }

  get fynlocal() {
    return this._options.fynlocal;
  }

  // lock-only allows skip meta retrieval but still retrieve tgz
  get lockOnly() {
    return this._options.lockOnly && "lock-only";
  }

  get lockTime() {
    return this._lockTime;
  }

  get showDeprecated() {
    return this._options.showDeprecated && "show-deprecated";
  }

  get refreshOptionals() {
    return this._options.refreshOptionals;
  }

  get ignoreDist() {
    return this._options.ignoreDist;
  }

  get production() {
    return this._options.production;
  }

  get concurrency() {
    return this._options.concurrency;
  }

  get deepResolve() {
    return this._options.deepResolve;
  }

  get preferLock() {
    return this._options.preferLock;
  }

  get remoteMetaDisabled() {
    // force-cache only force use cache when it exists but if it's
    // cache miss then we should retrieve from remote
    return this.lockOnly || this.offline || false;
  }

  get remoteTgzDisabled() {
    // force-cache only force use cache when it exists but if it's
    // cache miss then we should retrieve from remote
    return this.offline || false;
  }

  get pkgSrcMgr() {
    return this._pkgSrcMgr;
  }

  get fynDir() {
    return this._options.fynDir;
  }

  get fynTmp() {
    return Path.join(this.fynDir, "tmp");
  }

  get needFlatModule() {
    return this._needFlatModule;
  }

  set needFlatModule(x) {
    this._needFlatModule = x;
  }

  addLocalPkgWithNestedDep(depInfo) {
    this.localPkgWithNestedDep.push(depInfo);
  }

  async resolveDependencies() {
    await this._initialize();
    this._depResolver = new PkgDepResolver(this._pkg, { fyn: this, data: this._data });
    this._depResolver.start();
    return await this._depResolver.wait();
  }

  async fetchPackages(data) {
    await this._initialize();
    this._distFetcher = new PkgDistFetcher({
      data: data || this._data || this._depResolver._data,
      pkgSrcMgr: this._pkgSrcMgr,
      fyn: this
    });
    this._distFetcher.start();
    return await this._distFetcher.wait();
  }

  getInstalledPkgDir(name, version, pkg) {
    return pkg.promoted
      ? Path.join(this.getOutputDir(), name)
      : Path.join(this.getOutputDir(), `__fv_`, version, name);
  }

  getFvDir(x) {
    return Path.join(this._cwd, this._options.targetDir, "__fv_", x || "");
  }

  getOutputDir(x) {
    return Path.join(this._cwd, this._options.targetDir, x || "");
  }

  getExtraDir(x) {
    return Path.join(this._cwd, this._options.targetDir, ".extra", x || "");
  }

  clearPkgOutDir(dir) {
    return Fs.readdir(dir).each(f => Fs.$.rimraf(Path.join(dir, f)));
  }

  async loadFvVersions() {
    const fvVersions = {};
    const fvDir = this.getOutputDir("__fv_");
    try {
      for (const version of await Fs.readdir(fvDir)) {
        const verDir = Path.join(fvDir, version);

        const pkgNamesOfVersion = await Fs.readdir(verDir);

        for (let pkgName of pkgNamesOfVersion) {
          if (pkgName.startsWith("@")) {
            const scopeDir = Path.join(verDir, pkgName);
            const scope2 = await Fs.readdir(scopeDir);
            pkgName = Path.join(pkgName, scope2[0]);
          }

          if (!fvVersions[pkgName]) {
            fvVersions[pkgName] = [];
          }

          fvVersions[pkgName].push(version);
        }
      }
    } catch (err) {}

    return fvVersions;
  }

  async createPkgOutDir(dir, keep) {
    try {
      const r = await Fs.$.mkdirp(dir);
      // mkdirp returns null if directory already exist
      // clear directory to prepare it for installing package
      if (r === null && !keep && dir !== this.getOutputDir()) {
        await this.clearPkgOutDir(dir);
      }
    } catch (err) {
      // mkdirp fails with EEXIST if file exist and is not a directory
      if (err.code === "EEXIST") {
        // remove it and create as a directory
        await Fs.$.rimraf(dir);
        await Fs.$.mkdirp(dir);
      } else {
        throw err;
      }
    }
  }

  async createDir(dir) {
    try {
      await Fs.$.mkdirp(dir);
    } catch (err) {
      // mkdirp fails with EEXIST if file exist and is not a directory
      if (err.code === "EEXIST") {
        // remove it and create as a directory
        await Fs.$.rimraf(dir);
        await Fs.$.mkdirp(dir);
      } else {
        throw err;
      }
    }
  }

  // fyn's directory to store all local package linking file
  get linkDir() {
    return Path.join(this._options.fynDir, "links");
  }

  async readJson(file, fallback) {
    try {
      return JSON.parse(await Fs.readFile(file));
    } catch (e) {
      return fallback !== undefined ? fallback : {};
    }
  }

  async moveToBackup(dir, reason) {
    // TODO: create backup dir and move
    logger.warn("Removing", dir, "due to", reason);
    return await Fs.$.rimraf(dir);
  }

  async unlinkLocalPackage(pkg, dir) {
    // TODO: look for __fyn_link_<name>.json file and
    // update accordingly
    logger.warn("Removing symlink", dir);
    return await Fs.$.rimraf(dir);
  }

  //
  // A pkg that's to be extracted must:
  //
  // - not have its target dir exist
  // - if exist then must be a dir and have a package.json
  //   with the right name and version
  //
  // If dir exist with proper package.json, then returns it,
  // else returns undefined.
  //
  async ensureProperPkgDir(pkg, dir) {
    const fullOutDir = dir || this.getInstalledPkgDir(pkg.name, pkg.version, pkg);

    let ostat;

    try {
      ostat = await Fs.lstat(fullOutDir);
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
      return undefined;
    }

    if (ostat.isSymbolicLink()) {
      await this.unlinkLocalPackage(pkg, fullOutDir);
    } else if (!ostat.isDirectory()) {
      await this.moveToBackup(fullOutDir, "not a directory");
    } else {
      let pkgJson;
      try {
        pkgJson = await this.readPkgJson(pkg, fullOutDir);
        // if _id exist then it should match
        if (!pkgJson._id || pkgJson._id === `${pkg.name}@${pkg.version}`) {
          return pkgJson;
        }
      } catch (err) {}
      // no valid package.json found
      const id = pkgJson && pkgJson._id ? ` (id ${pkgJson._id})` : "";
      await this.moveToBackup(fullOutDir, `invalid existing package${id}`);
    }

    return undefined;
  }

  parsePackageJsonData(filename, buf) {
    const str = buf.toString().trim();
    const json = JSON.parse(str);
    json[PACKAGE_RAW_INFO] = {
      dir: Path.dirname(filename),
      str
    };
    return json;
  }

  async loadPackageJsonFile(filename) {
    try {
      const buf = await Fs.readFile(filename);
      return await this.parsePackageJsonData(filename, buf);
    } catch (err) {
      throw new Error(`reading ${filename} - ${err.message}`);
    }
  }

  async readPkgJson(pkg, dir) {
    const fullOutDir = dir || this.getInstalledPkgDir(pkg.name, pkg.version, pkg);
    const json = await this.loadPackageJsonFile(Path.join(fullOutDir, "package.json"));

    pkg.dir = json[PACKAGE_RAW_INFO].dir;
    pkg.str = json[PACKAGE_RAW_INFO].str;

    const id = `${json.name}@${json.version}`;
    if (json.version !== pkg.version) {
      json.version = semver.valid(json.version) || semverUtil.clean(json.version);
      assert(
        semver.valid(json.version),
        `Pkg ${id} version is not valid semver and fyn was unable to fix it.`
      );
    }

    assert(
      json && json.name === pkg.name && semverUtil.equal(json.version, pkg.version),
      `Pkg in ${fullOutDir} ${id} doesn't match ${pkg.name}@${pkg.version}`
    );

    try {
      const gypFile = Path.join(fullOutDir, "binding.gyp");
      await Fs.lstat(gypFile);

      json.gypfile = true;
      const scr = json.scripts;
      if (_.isEmpty(scr) || (!scr.install && !scr.postinstall && !scr.postInstall)) {
        _.set(json, "scripts.install", "node-gyp rebuild");
      }
    } catch (err) {}

    pkg.json = json;

    return json;
  }

  async createSubNodeModulesDir(dir) {
    const nmDir = Path.join(dir, "node_modules");
    const fynIgnoreFile = Path.join(nmDir, FYN_IGNORE_FILE);

    let ignoreExist = false;

    if (!(await Fs.exists(nmDir))) {
      await Fs.$.mkdirp(nmDir);
    } else {
      ignoreExist = await Fs.exists(fynIgnoreFile);
    }

    if (ignoreExist && !this.flatMeta) {
      await Fs.unlink(fynIgnoreFile);
    } else if (!ignoreExist && this.flatMeta) {
      await Fs.writeFile(fynIgnoreFile, "");
    }

    return nmDir;
  }
}

module.exports = Fyn;
