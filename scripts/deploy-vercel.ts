import { put } from "@vercel/blob";
import fs from "fs";
import { execSync } from "child_process";
import path from "path";

const build = (): void => {
  execSync("npx samepage build --dry", { stdio: "inherit" });
};

const resolveBranch = (): string =>
  process.env.GITHUB_HEAD_REF ||
  process.env.GITHUB_REF_NAME ||
  execSync("git rev-parse --abbrev-ref HEAD").toString().trim() ||
  "main";

const deploy = async (): Promise<void> => {
  process.env.NODE_ENV = process.env.NODE_ENV || "production";

  console.log("Deploying ...");
  if (!process.argv.includes("--no-compile")) {
    try {
      console.log("Building");
      build();
    } catch (error) {
      console.error("Deployment failed on compile:", error);
      process.exit(1);
    }
  }

  try {
    const resolvedWorkspace = "breadcrumbs";
    const token = process.env.BLOB_READ_WRITE_TOKEN;
    if (!token) {
      throw new Error(
        "BLOB_READ_WRITE_TOKEN is required but not found in environment variables",
      );
    }

    const resolvedBranch = resolveBranch();
    const distPath = path.join(process.cwd(), "dist");
    const files = [
      "extension.js",
      "extension.css",
      "package.json",
      "README.md",
      "CHANGELOG.md",
    ];

    for (const file of files) {
      const filePath = path.join(distPath, file);
      if (!fs.existsSync(filePath)) {
        console.log(`Skipping ${file} - file does not exist`);
        continue;
      }

      const content = fs.readFileSync(filePath);
      const pathname =
        resolvedBranch === "main"
          ? `releases/${resolvedWorkspace}/${file}`
          : `releases/${resolvedWorkspace}/${resolvedBranch}/${file}`;

      console.log(`Uploading ${file}...`);
      const blob = await put(pathname, content, {
        access: "public",
        addRandomSuffix: false,
        allowOverwrite: true,
        token,
      });
      console.log(`Uploaded to ${blob.url}`);
    }

    console.log("Deploy completed successfully!");
    const urlBase = process.env.ROMEJS_RELEASES_BASE_URL || "https://RomeJS.com";
    const url = `${urlBase}/releases/${resolvedWorkspace}/${resolvedBranch}`;
    console.log(url);
  } catch (error) {
    console.error("Deploy failed:", error);
    process.exit(1);
  }
};

deploy().catch((error) => {
  console.error(error);
  process.exit(1);
});
