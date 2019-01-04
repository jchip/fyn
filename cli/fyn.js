"use strict";

const Fs = require("fs");
const Path = require("path");
const chalk = require("chalk");
const Promise = require("bluebird");
const FynCli = require("./fyn-cli");
const _ = require("lodash");
const CliLogger = require("../lib/cli-logger");
const logger = require("../lib/logger");
const NixClap = require("nix-clap");
const myPkg = require("./mypkg");
const loadRc = require("./load-rc");
const findFlatModule = require("./find-flat-module");
const defaultRc = require("./default-rc");

const nixClap = new NixClap({
  Promise,
  name: myPkg.name,
  version: myPkg.version,
  usage: "$0 [options] <command>"
});

function setLogLevel(ll) {
  if (ll) {
    const levels = Object.keys(CliLogger.Levels);
    const real = _.find(levels, l => l.startsWith(ll));
    const x = CliLogger.Levels[real];
    if (x !== undefined) {
      logger._logLevel = x;
    } else {
      logger.error(`Invalid log level "${ll}".  Supported levels are: ${levels.join(", ")}`);
      exit(1);
    }
  }
}

const pickOptions = argv => {
  setLogLevel(argv.opts.logLevel);

  chalk.enabled = argv.opts.colors;

  let cwd = argv.opts.cwd || process.cwd();

  if (!Path.isAbsolute(cwd)) {
    cwd = Path.join(process.cwd(), cwd);
  }

  // source of options priority
  // 1. User specified CLI options
  // 2. User specified ENV options
  // 3. User RC files
  // 4. CLI defaults
  // 5. defaults

  const rc = (argv.opts.rcfile && loadRc(cwd)) || defaultRc;

  nixClap.applyConfig(rc, argv);

  argv.opts.cwd = cwd;

  chalk.enabled = argv.opts.colors;

  if (!argv.source.saveLogs.startsWith("cli")) {
    argv.opts.saveLogs = undefined;
  }

  logger.verbose("Final RC", JSON.stringify(argv.opts));

  setLogLevel(argv.opts.logLevel);
  if (argv.opts.progress) logger.setItemType(argv.opts.progress);

  return argv.opts;
};

const makeNodeOptions = () => {
  const file = findFlatModule();
  let splits = [];

  if (process.env.NODE_OPTIONS) {
    splits = process.env.NODE_OPTIONS.split(" ").filter(x => x);
  }

  for (let i = 0; i < splits.length; i++) {
    if (splits[i] === "-r" || splits[i] === "--require") {
      const ex = splits[i + 1] || "";
      if (ex.indexOf("flat-module") >= 0) {
        if (ex === file) {
          throw new Error(`Your NODE_OPTIONS is already setup for fyn's flat-module.`);
        }
        throw new Error(`Your NODE_OPTIONS already has require for flat module at ${ex}`);
      }
    }
  }

  return splits.concat(`-r ${file}`).join(" ");
};

const options = {
  fynlocal: {
    type: "boolean",
    desc: "fynlocal mode",
    default: true
  },
  "central-store": {
    type: "boolean",
    alias: ["central", "cs"],
    desc: "keep single copy of packages in central store",
    default: false
  },
  copy: {
    type: "string array",
    alias: "cp",
    desc: "copy package even in central store mode"
  },
  "log-level": {
    alias: "q",
    type: "string",
    desc: "One of: debug,verbose,info,warn,error,fyi,none",
    default: "info"
  },
  "save-logs": {
    type: "string",
    alias: "sl",
    default: "fyn-debug.log",
    desc: "Save all logs to the specified file"
  },
  colors: {
    type: "boolean",
    default: true,
    desc: "Log with colors (--no-colors turn off)"
  },
  progress: {
    type: "enum",
    alias: "pg",
    requiresArg: true,
    default: "normal",
    enum: /^(normal|simple|none)$/,
    desc: "Log progress type: normal,simple,none"
  },
  cwd: {
    type: "string",
    requireArg: true,
    desc: "Change current working dir"
  },
  "fyn-dir": {
    type: "string",
    desc: "Dir for cache etc, default {HOME}/.fyn"
  },
  "force-cache": {
    alias: "f",
    type: "boolean",
    desc: "Don't check registry if cache exists."
  },
  offline: {
    type: "boolean",
    desc: "Only lockfile or local cache. Fail if miss."
  },
  "lock-only": {
    alias: "k",
    type: "boolean",
    desc: "Only resolve with lockfile. Fail if needs changes."
  },
  "prefer-lock": {
    type: "boolean",
    desc: "Prefer resolving with lockfile."
  },
  lockfile: {
    type: "boolean",
    alias: "lf",
    default: true,
    desc: "Support lockfile"
  },
  "lock-time": {
    type: "string",
    desc: "Lock dependencies by time"
  },
  "refresh-optionals": {
    type: "boolean",
    default: false,
    desc: "refresh all optionalDependencies"
  },
  "ignore-dist": {
    alias: "i",
    type: "boolean",
    desc: "Ignore host in tarball URL from meta dist."
  },
  "show-deprecated": {
    alias: "s",
    type: "boolean",
    desc: "Force show deprecated messages"
  },
  "deep-resolve": {
    alias: "dr",
    type: "boolean",
    desc: "Resolve dependency tree as deep as possible"
  },
  production: {
    type: "boolean",
    alias: "prod",
    default: false,
    desc: "Ignore devDependencies",
    allowCmd: ["add", "remove", "install"]
  },
  rcfile: {
    type: "boolean",
    default: true,
    desc: "Load .fynrc and .npmrc files"
  },
  registry: {
    type: "string",
    alias: "reg",
    requireArg: true,
    desc: "Override registry url"
  },
  "flat-meta": {
    type: "boolean",
    default: false,
    desc: "create flat-module meta files"
  },
  concurrency: {
    type: "number",
    alias: "cc",
    desc: "Max network concurrency",
    default: 15
  }
};

const commands = {
  install: {
    alias: "i",
    desc: "Install modules",
    exec: argv => {
      const cli = new FynCli(pickOptions(argv));
      return cli.install();
    },
    default: true
  },
  add: {
    alias: "a",
    args: "[packages..]",
    usage: "$0 $1 [packages..]",
    desc: "add packages to package.json",
    exec: argv => {
      const options = pickOptions(argv);
      const lockFile = options.lockfile;
      options.lockfile = false;
      const cli = new FynCli(options);
      const opts = Object.assign({}, argv.opts, argv.args);
      return cli.add(opts).then(added => {
        if (!added || !argv.opts.install) return;
        options.lockfile = lockFile;
        options.noStartupInfo = true;
        logger.info("installing...");
        return new FynCli(options).install();
      });
    },
    options: {
      dev: {
        alias: ["d"],
        type: "array",
        desc: "List of packages to add to devDependencies"
      },
      opt: {
        type: "array",
        desc: "List of packages to add to optionalDependencies"
      },
      peer: {
        alias: ["p"],
        type: "array",
        desc: "List of packages to add to peerDependencies"
      },
      install: {
        type: "boolean",
        default: true,
        desc: "Run install after added"
      }
    }
  },
  remove: {
    alias: "rm",
    args: "<packages..>",
    desc: "Remove packages from package.json and install",
    exec: async argv => {
      const options = pickOptions(argv);
      const lockFile = options.lockfile;
      options.lockfile = false;
      const cli = new FynCli(options);
      const opts = Object.assign({}, argv.opts, argv.args);
      const removed = await cli.remove(opts);
      if (removed) {
        if (!argv.opts.install) return;
        options.lockfile = lockFile;
        options.noStartupInfo = true;
        logger.info("installing...");
        return await new FynCli(options).install();
      }
    },
    options: {
      install: {
        type: "boolean",
        default: true,
        desc: "Run install after removed"
      }
    }
  },
  fm: {
    desc: "Show the full path to flat-module",
    exec: () => {
      console.log(findFlatModule());
    }
  },
  bash: {
    desc: "Setup flat-module env for bash",
    exec: () => {
      try {
        console.log(`export NODE_OPTIONS="${makeNodeOptions()}"`);
      } catch (e) {
        console.log(`echo "${e.message}"`);
      }
    }
  },
  json: {
    desc: "output flat-module env as JSON",
    exec: () => {
      try {
        console.log(
          JSON.stringify({
            NODE_OPTIONS: makeNodeOptions()
          })
        );
      } catch (e) {
        console.log(JSON.stringify({ error: e.message }));
      }
    }
  },
  stat: {
    desc: "Show stats of installed packages",
    usage: "$0 $1 <package-name>[@semver] [...]",
    args: "<string packages..>",
    exec: argv => {
      return new FynCli(pickOptions(argv)).stat(argv);
    },
    options: {
      follow: {
        desc: "automatically stat first [n] dependents up to top",
        type: "number",
        default: 0
      }
    }
  }
};

if (process.platform === "win32") {
  commands.win = {
    desc: `Generate setup file "fynwin.cmd" at your CWD.`,
    exec: argv => {
      let cmd;
      try {
        cmd = `set NODE_OPTIONS=${makeNodeOptions()}`;
      } catch (e) {
        cmd = `@echo ${e.message}`;
      }

      const keep = argv.opts.keep;
      const del = keep ? "" : `@(goto) 2>nul & del "%~f0"\r\n`;
      Fs.writeFileSync(Path.resolve("fynwin.cmd"), `${cmd}\r\n${del}`);
      if (!argv.opts.quiet) {
        logger.fyi(
          `${chalk.green("fynwin.cmd")} generated at ${chalk.magenta(process.cwd())} for you.`
        );
        logger.fyi(
          `You can run it by typing ${chalk.magenta("fynwin")}.`,
          keep ? "" : `It will delete itself.`
        );
      }
    },
    options: {
      keep: {
        desc: "fynwin.cmd does not delete itself",
        type: "boolean",
        default: false
      },
      quiet: {
        desc: "don't show any message",
        type: "boolean",
        default: false
      }
    }
  };
}

const run = args => {
  const start = args !== undefined ? 0 : undefined;
  return nixClap.init(options, commands).parseAsync(args, start);
};

module.exports = run;

if (require.main === module) {
  run();
}
