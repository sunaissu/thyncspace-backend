import { readFileSync } from "node:fs";
import path from "node:path";

type PackageMetadata = {
  version?: unknown;
};

const packagePath = path.resolve(__dirname, "..", "..", "package.json");
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
