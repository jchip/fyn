"use strict";

const Path = require("path");
const webpack = require("webpack");
const BundleAnalyzerPlugin = require("webpack-bundle-analyzer").BundleAnalyzerPlugin;

module.exports = {
  mode: "development",
  //devtool: "source-map",
  entry: {
    "node-gyp.js": Path.resolve("node_modules/node-gyp")
  },
  plugins: [process.env.ANALYZE_BUNDLE && new BundleAnalyzerPlugin()].filter(x => x),
  resolve: {
    symlinks: false // don't resolve symlinks to their real path
  },
  output: {
    filename: `[name]`,
    path: Path.resolve("dist"),
    libraryTarget: "commonjs2"
  },
  target: "node",
  node: {
    __filename: false,
    __dirname: false
  },
  output: {
    filename: `index.js`,
    path: Path.resolve("node-gyp"),
    libraryTarget: "commonjs2"
  },
  module: { rules: [{ test: /\.cs$/, loader: "ignore-loader" }] }
};
