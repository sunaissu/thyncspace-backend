import { readFileSync } from "node:fs";

type PackageMetadata = {
  version?: unknown;
};

const packagePath = new URL("../../package.json", import.meta.url);
const packageMetadata = JSON.parse(
  readFileSync(packagePath, "utf8"),
) as PackageMetadata;

if (
  typeof packageMetadata.version !== "string" ||
  !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(packageMetadata.version)
) {
  throw new Error("backend/package.json must contain a valid application version");
}

export const APP_VERSION = packageMetadata.version;
