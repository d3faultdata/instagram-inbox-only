#!/usr/bin/env node
/**
 * Static checks that would otherwise only surface as a silent failure at load
 * time: missing files, hosts the manifest has no permission for, allow-regexes
 * that do not compile under RE2.
 */
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const { BUILTIN_SITES } = require("../src/common/config.js");
const { buildAllowRegex } = require("../src/common/matcher.js");

const problems = [];
const manifest = JSON.parse(
  fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8")
);

function exists(relative) {
  return fs.existsSync(path.join(ROOT, relative));
}

/* Files the manifest points at must be present. */
const referenced = [
  manifest.background?.service_worker,
  manifest.options_ui?.page,
  ...Object.values(manifest.icons || {}),
].filter(Boolean);

for (const file of referenced) {
  if (!exists(file)) problems.push(`manifest references missing file: ${file}`);
}

/* Files the service worker and options page pull in must be present too. */
for (const file of [
  "src/common/matcher.js",
  "src/common/config.js",
  "src/content/guard.js",
  "src/options/options.js",
  "src/options/options.css",
]) {
  if (!exists(file)) problems.push(`missing source file: ${file}`);
}

/* Every built-in site needs host permissions, or its guard never registers. */
for (const site of BUILTIN_SITES) {
  for (const host of site.hosts) {
    const covered = (manifest.host_permissions || []).some((pattern) =>
      pattern.includes(host)
    );
    if (!covered) {
      problems.push(`no host_permissions entry covers ${host} (${site.id})`);
    }
  }

  try {
    new RegExp(buildAllowRegex(site));
  } catch (err) {
    problems.push(`allow regex for ${site.id} does not compile: ${err.message}`);
  }

  if (!site.home.startsWith("/")) {
    problems.push(`${site.id} home must be an absolute path`);
  }
}

/* Permissions the code actually calls. */
for (const permission of [
  "declarativeNetRequest",
  "scripting",
  "storage",
  "alarms",
  "webNavigation",
]) {
  if (!(manifest.permissions || []).includes(permission)) {
    problems.push(`missing permission: ${permission}`);
  }
}

if (manifest.manifest_version !== 3) {
  problems.push("expected manifest_version 3");
}

if (problems.length) {
  console.error("manifest validation failed:");
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(`manifest ok (${BUILTIN_SITES.length} built-in sites)`);
