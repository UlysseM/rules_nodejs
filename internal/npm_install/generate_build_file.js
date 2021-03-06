/**
 * @license
 * Copyright 2017 The Bazel Authors. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 *
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
/**
 * @fileoverview This script generates a BUILD.bazel file by analyzing
 * the node_modules folder layed out by yarn or npm. It generates
 * fine grained Bazel filegroup targets for each root npm package
 * and all files for that package and its transitive deps are included
 * in the filegroup. For example, `@<workspace>//:jasmine` would
 * include all files in the jasmine npm package and all of its
 * transitive dependencies.
 *
 * nodejs_binary targets are also generated for all `bin` scripts
 * in each package. For example, the `@<workspace>//:jasmine/jasmine`
 * target will be generated for the `jasmine` binary in the `jasmine`
 * npm package:
 *
 * ```
 * nodejs_binary(
 *   name = "jasmine/jasmine",
 *   entry_point = "jasmine/bin/jasmine.js",
 *   data = [":jasmine"],
 * )
 * ```
 *
 * Additionally, the following coarse grained filegroup targets
 * are also generated for backward compatibility with the node_modules
 * attribute of nodejs_binary and other rules that take that
 * attribute:
 *
 * `@<workspace>//:node_modules`: The entire node_modules directory in one
 *   catch-all filegroup. NB: Using this target may have bad performance
 *   implications if there are many files in filegroup.
 *   See https://github.com/bazelbuild/bazel/issues/5153.
 *
 * `@<workspace>//:node_modules_lite`: A lite version of the node_modules filegroup
 *   that includes only js, d.ts and json files as well as the .bin folder. This
 *   can be used in some cases to improve performance by reducing the number
 *   of runfiles. The recommended approach to reducing performance
 *   is to use fine grained deps such as ["@npm//:a", "@npm://b", ...].
 *   There are cases where the node_modules_lite filegroup will
 *   not include files with no extension that are needed. The feature request
 *   https://github.com/bazelbuild/bazel/issues/5769 would allow this
 *   filegroup to include those files.
 *
 * This work is based off the fine grained deps concepts in
 * https://github.com/pubref/rules_node developed by @pcj.
 *
 * @see https://docs.google.com/document/d/1AfjHMLVyE_vYwlHSK7k7yW_IIGppSxsQtPm9PTr1xEo
 */
'use strict';

const fs = require('fs');
const path = require('path');

const BUILD_FILE_HEADER = `# Generated file from yarn_install rule.
# See $(bazel info output_base)/external/build_bazel_rules_nodejs/internal/npm_install/generate_build_file.js

# All rules in other repositories can use these targets
package(default_visibility = ["//visibility:public"])

load("@build_bazel_rules_nodejs//:defs.bzl", "nodejs_binary")

# The entire node_modules directory in one catch-all filegroup.
# NB: Using this target may have bad performance implications if
# there are many files in filegroup.
# See https://github.com/bazelbuild/bazel/issues/5153.
filegroup(
    name = "node_modules",
    srcs = glob(
        include = ["node_modules/**/*"],
        exclude = [
          # Files under test & docs may contain file names that
          # are not legal Bazel labels (e.g.,
          # node_modules/ecstatic/test/public/中文/檔案.html)
          "node_modules/**/test/**",
          "node_modules/**/docs/**",
          # Files with spaces in the name are not legal Bazel labels
          "node_modules/**/* */**",
          "node_modules/**/* *",
        ],
    ),
)

# A lite version of the node_modules filegroup that includes
# only js, d.ts and json files as well as the .bin folder. This can
# be used in some cases to improve performance by reducing the number
# of runfiles. The recommended approach to reducing performance
# is to use fine grained deps such as ["@npm//:a", "@npm://b", ...].
# There are cases where the node_modules_lite filegroup will
# not include files with no extension that are needed. The feature request
# https://github.com/bazelbuild/bazel/issues/5769 would allow this
# filegroup to include those files.
filegroup(
    name = "node_modules_lite",
    srcs = glob(
        include = [
          "node_modules/**/*.js",
          "node_modules/**/*.d.ts",
          "node_modules/**/*.json",
          "node_modules/.bin/*",
        ],
        exclude = [
          # Files under test & docs may contain file names that
          # are not legal Bazel labels (e.g.,
          # node_modules/ecstatic/test/public/中文/檔案.html)
          "node_modules/**/test/**",
          "node_modules/**/docs/**",
          # Files with spaces in the name are not legal Bazel labels
          "node_modules/**/* */**",
          "node_modules/**/* *",
        ],
    ),
)

`

if (require.main === module) {
  main();
}

/**
 * Main entrypoint.
 * Write BUILD file.
 */
function main() {
  // find all packages (including packages in nested node_modules)
  const pkgs = findPackages();
  const scopes = findScopes();

  // flatten dependencies
  const pkgsMap = new Map();
  pkgs.forEach(pkg => pkgsMap.set(pkg._dir, pkg));
  pkgs.forEach(pkg => flattenDependencies(pkg, pkg, pkgsMap));

  // generate the BUILD file
  let buildFile = BUILD_FILE_HEADER;
  pkgs.filter(pkg => !pkg._isNested).forEach(pkg => buildFile += printPackage(pkg));
  scopes.forEach(scope => buildFile += printScope(scope, pkgs));
  try {
    const manualContents = fs.readFileSync(`manual_build_file_contents`, {encoding: 'utf8'});
    buildFile += '\n\n';
    buildFile += manualContents;
  } catch (e) {
  }
  fs.writeFileSync('BUILD.bazel', buildFile);
}

module.exports = {main};

/**
 * Checks if a path is an npm package which is is a directory with a package.json file.
 */
function isPackage(p) {
  //
  const packageJson = path.posix.join(p, 'package.json');
  return fs.statSync(p).isDirectory() && fs.existsSync(packageJson) &&
      fs.statSync(packageJson).isFile();
}

/**
 * Finds and returns an array of all packages under a given path.
 */
function findPackages(p = 'node_modules') {
  if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) {
    return [];
  }

  const result = [];

  const listing = fs.readdirSync(p);

  const packages = listing.filter(f => !f.startsWith('@'))
                       .map(f => path.posix.join(p, f))
                       .filter(f => isPackage(f));
  packages.forEach(
      f => result.push(parsePackage(f), ...findPackages(path.posix.join(f, 'node_modules'))));

  const scopes = listing.filter(f => f.startsWith('@'))
                     .map(f => path.posix.join(p, f))
                     .filter(f => fs.statSync(f).isDirectory());
  scopes.forEach(f => result.push(...findPackages(f)));

  return result;
}

function findScopes() {
  const p = 'node_modules';
  if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) {
    return [];
  }

  const listing = fs.readdirSync(p);

  const scopes = listing.filter(f => f.startsWith('@'))
                     .map(f => path.posix.join(p, f))
                     .filter(f => fs.statSync(f).isDirectory())
                     .map(f => f.replace(/^node_modules\//, ''));

  return scopes;
}

/**
 * Given the name of a top-level folder in node_modules, parse the
 * package json and return it as an object along with
 * some additional internal attributes prefixed with '_'.
 */
function parsePackage(p) {
  // Parse the package.json file of this package
  const pkg = JSON.parse(fs.readFileSync(`${p}/package.json`, {encoding: 'utf8'}));

  // Trim the leading node_modules from the path and
  // assign to _dir for future use
  pkg._dir = p.replace(/^node_modules\//, '');

  // Keep track of whether or not this is a nested package
  pkg._isNested = p.match(/\/node_modules\//);

  // Initialize _dependencies to an empty array
  // which is later filled with the flattened dependency list
  pkg._dependencies = [];

  // For root packages, transform the pkg.bin entries
  // into a new Map called _executables
  pkg._executables = new Map();
  if (!pkg._isNested) {
    if (Array.isArray(pkg.bin)) {
      // should not happen, but ignore it if present
    } else if (typeof pkg.bin === 'string') {
      pkg._executables.set(pkg._dir, cleanupBinPath(pkg.bin));
    } else if (typeof pkg.bin === 'object') {
      for (let key in pkg.bin) {
        pkg._executables.set(key, cleanupBinPath(pkg.bin[key]));
      }
    }
  }

  return pkg;
}

/**
 * Given a path, remove './' if it exists.
 */
function cleanupBinPath(path) {
  // Bin paths usually come in 2 flavors: './bin/foo' or 'bin/foo',
  // sometimes other stuff like 'lib/foo'.  Remove prefix './' if it
  // exists.
  path = path.replace(/\\/g, '/');
  if (path.indexOf('./') === 0) {
    path = path.slice(2);
  }
  return path;
}

/**
 * Flattens all transitive dependencies of a package
 * into a _dependencies array.
 */
function flattenDependencies(pkg, dep, pkgsMap) {
  if (pkg._dependencies.indexOf(dep) !== -1) {
    // circular dependency
    return;
  }
  pkg._dependencies.push(dep);
  const findDeps = function(targetDeps, required) {
    Object.keys(targetDeps || {})
        .map(targetDep => {
          // look for matching nested package
          const dirSegments = dep._dir.split('/');
          while (dirSegments.length) {
            const maybe = path.posix.join(...dirSegments, 'node_modules', targetDep);
            if (pkgsMap.has(maybe)) {
              return pkgsMap.get(maybe);
            }
            dirSegments.pop();
          }
          // look for matching root package
          if (pkgsMap.has(targetDep)) {
            return pkgsMap.get(targetDep);
          }
          // dependency not found
          if (required) {
            throw new Error(`Could not find required dep ${targetDep} of ${dep._dir}`)
          }
          return null;
        })
        .filter(dep => !!dep)
        .map(dep => flattenDependencies(pkg, dep, pkgsMap));
  };
  findDeps(dep.dependencies, true);
  findDeps(dep.peerDependencies, true);
  // `optionalDependencies` that are missing should be silently
  // ignored since the npm/yarn will not fail if these dependencies
  // fail to install. Packages should handle the cases where these
  // dependencies are missing gracefully at runtime.
  // An example of this is the `chokidar` package which specifies
  // `fsevents` as an optionalDependency. On OSX/linux, `fsevents`
  // is installed successfully, but on Windows, `fsevents` fails
  // to install and the package will not be present when checking
  // the dependencies of `chokidar`.
  findDeps(dep.optionalDependencies, false);
}

/**
 * Reformat/pretty-print a json object as a skylark comment (each line
 * starts with '# ').
 */
function printJson(pkg) {
  // Clone and modify _dependencies to avoid circular issues when JSONifying
  const cloned = {...pkg};
  cloned._dependencies = cloned._dependencies.map(dep => dep._dir);
  return JSON.stringify(cloned, null, 2).split('\n').map(line => `# ${line}`).join('\n');
}

/**
 * Given a pkg, print a skylark `filegroup` target for the package.
 */
function printPackage(pkg) {
  let result = `
# Generated target for npm package "${pkg._dir}"
${printJson(pkg)}
filegroup(
    name = "${pkg._dir}",
    srcs = [
        # ${pkg._dir} package contents (and contents of nested node_modules)
        ":${pkg._dir}__files",
        # direct or transitive dependencies hoisted to root by the package manager
        ${
      pkg._dependencies.filter(dep => dep != pkg)
          .filter(dep => !dep._isNested)
          .map(dep => `":${dep._dir}__files",`)
          .join('\n        ')}
    ],
    tags = ["NODE_MODULE_MARKER"],
)

filegroup(
    name = "${pkg._dir}__files",
    srcs = glob(
        include = ["node_modules/${pkg._dir}/**/*"],
        exclude = [
          # Files under test & docs may contain file names that
          # are not legal Bazel labels (e.g.,
          # node_modules/ecstatic/test/public/中文/檔案.html)
          "node_modules/${pkg._dir}/test/**",
          "node_modules/${pkg._dir}/docs/**",
          # Files with spaces in the name are not legal Bazel labels
          "node_modules/${pkg._dir}/**/* */**",
          "node_modules/${pkg._dir}/**/* *",
        ],
    ),
    tags = ["NODE_MODULE_MARKER"],
)

filegroup(
    name = "${pkg._dir}__typings",
    srcs = glob(
        include = ["node_modules/${pkg._dir}/**/*.d.ts"],
        exclude = [
          # Files under test & docs may contain file names that
          # are not legal Bazel labels (e.g.,
          # node_modules/ecstatic/test/public/中文/檔案.html)
          "node_modules/${pkg._dir}/test/**",
          "node_modules/${pkg._dir}/docs/**",
          # Files with spaces in the name are not legal Bazel labels
          "node_modules/${pkg._dir}/**/* */**",
          "node_modules/${pkg._dir}/**/* *",
        ],
    ),
    tags = ["NODE_MODULE_MARKER"],
)
`;

  if (pkg._executables) {
    for (const [name, path] of pkg._executables.entries()) {
      result += `# Wire up the \`bin\` entry \`${name}\`
nodejs_binary(
    name = "${pkg._dir}/${name}",
    entry_point = "${pkg._dir}/${path}",
    install_source_map_support = False,
    data = [":${pkg._dir}"],
)

`;
    }
  }

  return result;
}

/**
 * Given a scope, print a skylark `filegroup` target for the scope.
 */
function printScope(scope, pkgs) {
  const scopePkgs = pkgs.filter(pkg => !pkg._isNested && pkg._dir.startsWith(`${scope}/`));
  return `
# Generated target for npm scope ${scope}
filegroup(
    name = "${scope}",
    srcs = [
        ${scopePkgs.map(pkg => `":${pkg._dir}",`).join('\n        ')}
    ],
    tags = ["NODE_MODULE_MARKER"],
)

`;
}
