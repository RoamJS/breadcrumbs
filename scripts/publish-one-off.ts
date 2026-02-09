import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { S3 } from "@aws-sdk/client-s3";
import mime from "mime-types";

const DIST_DIR = path.join(process.cwd(), "dist");
const ASSETS_DIR = path.join(process.cwd(), "assets");

type ParsedArgs = {
  skipGithub: boolean;
  skipS3: boolean;
  skipBuild: boolean;
  tag?: string;
  bucket?: string;
  branch?: string;
};

const parseArgs = (): ParsedArgs => {
  const args = process.argv.slice(2);
  return args.reduce<ParsedArgs>(
    (acc, arg) => {
      if (arg === "--skip-github") return { ...acc, skipGithub: true };
      if (arg === "--skip-s3") return { ...acc, skipS3: true };
      if (arg === "--skip-build") return { ...acc, skipBuild: true };
      if (arg.startsWith("--tag=")) return { ...acc, tag: arg.slice(6) };
      if (arg.startsWith("--bucket=")) return { ...acc, bucket: arg.slice(9) };
      if (arg.startsWith("--branch=")) return { ...acc, branch: arg.slice(9) };
      return acc;
    },
    { skipGithub: false, skipS3: false, skipBuild: false },
  );
};

const ensureDistExists = (): void => {
  if (!fs.existsSync(DIST_DIR)) {
    throw new Error("dist/ does not exist. Run build first.");
  }
};

const getRepo = (): string => {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  try {
    const remote = execSync("git config --get remote.origin.url")
      .toString()
      .trim();
    const match = /[:/]([^/]+\/[^/.]+)(?:\.git)?$/.exec(remote);
    return match ? match[1] : "samepage.network";
  } catch {
    return "samepage.network";
  }
};

const getBranch = (branchArg?: string): string => {
  if (branchArg) return branchArg;
  if (process.env.GITHUB_HEAD_REF) return process.env.GITHUB_HEAD_REF;
  if (process.env.GITHUB_REF_NAME) return process.env.GITHUB_REF_NAME;
  try {
    return execSync("git rev-parse --abbrev-ref HEAD").toString().trim();
  } catch {
    return "main";
  }
};

const getTag = (tagArg?: string): string => {
  if (tagArg) return tagArg;
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  const h = String(now.getUTCHours()).padStart(2, "0");
  const min = String(now.getUTCMinutes()).padStart(2, "0");
  return `${y}.${m}.${d}.${h}${min}`;
};

const runBuild = (): void => {
  execSync("npx samepage build --dry", { stdio: "inherit" });
};

const runZip = (zipName: string): void => {
  const cmd =
    process.platform === "win32"
      ? `powershell -NoProfile -Command "Compress-Archive -Path * -DestinationPath ${zipName} -Force"`
      : `zip -qr ${zipName} .`;
  const cwd = process.cwd();
  process.chdir(DIST_DIR);
  try {
    execSync(cmd, { stdio: "inherit" });
  } finally {
    process.chdir(cwd);
  }
};

type GithubRequestArgs = {
  endpoint: string;
  method?: string;
  token: string;
  body?: unknown;
  host: string;
};

type GithubError = Error & { response?: unknown };

const githubRequest = async ({
  endpoint,
  method = "GET",
  token,
  body,
  host,
}: GithubRequestArgs): Promise<any> => {
  const response = await fetch(`${host}${endpoint}`, {
    method,
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/vnd.github+json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  let data: any = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { message: text };
  }

  if (!response.ok) {
    const err: GithubError = new Error(`GitHub API failed (${response.status})`);
    err.response = data;
    throw err;
  }
  return data;
};

const uploadGithubRelease = async ({
  repo,
  tag,
  token,
  branch,
}: {
  repo: string;
  tag: string;
  token?: string;
  branch: string;
}): Promise<void> => {
  if (branch !== "main") {
    console.warn("Not on main branch, skipping GitHub release.");
    return;
  }
  if (!token) {
    console.warn("No GITHUB_TOKEN set, skipping GitHub release.");
    return;
  }

  const sha =
    process.env.GITHUB_SHA || execSync("git rev-parse HEAD").toString().trim();
  const message = await githubRequest({
    endpoint: `/repos/${repo}/commits/${sha}`,
    token,
    host: "https://api.github.com",
  }).then((r) => r.commit?.message || `Release ${tag}`);

  let release: any;
  try {
    release = await githubRequest({
      endpoint: `/repos/${repo}/releases`,
      method: "POST",
      token,
      host: "https://api.github.com",
      body: {
        tag_name: tag,
        name: message.length > 50 ? `${message.slice(0, 47)}...` : message,
        body: message.length > 50 ? `...${message.slice(47)}` : "",
      },
    });
  } catch (error) {
    const err = error as GithubError & {
      response?: { errors?: { code?: string }[] };
    };
    const alreadyExists =
      Array.isArray(err.response?.errors) &&
      err.response.errors[0] &&
      err.response.errors[0].code === "already_exists";
    if (!alreadyExists) throw error;
    release = await githubRequest({
      endpoint: `/repos/${repo}/releases/tags/${tag}`,
      token,
      host: "https://api.github.com",
    });
  }

  const distFiles = fs.readdirSync(DIST_DIR).filter((f) => f !== "package.json");
  await Promise.all(
    distFiles.map(async (fileName) => {
      const filePath = path.join(DIST_DIR, fileName);
      const content = fs.readFileSync(filePath);
      const response = await fetch(
        `https://uploads.github.com/repos/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(
          fileName,
        )}`,
        {
          method: "POST",
          headers: {
            Authorization: `token ${token}`,
            Accept: "application/vnd.github+json",
            "Content-Type": mime.lookup(filePath) || "application/octet-stream",
          },
          body: content,
        },
      );
      if (!response.ok) {
        const text = await response.text();
        let parsed: any = {};
        try {
          parsed = text ? JSON.parse(text) : {};
        } catch {
          parsed = { message: text };
        }
        const alreadyExists =
          Array.isArray(parsed.errors) &&
          parsed.errors[0] &&
          parsed.errors[0].code === "already_exists";
        if (alreadyExists) {
          console.warn(`Release asset ${fileName} already exists`);
          return;
        }
        throw new Error(`Failed to upload ${fileName}: ${JSON.stringify(parsed)}`);
      }
    }),
  );

  console.log(`GitHub release published for tag ${release.tag_name}`);
};

const uploadS3Artifacts = async ({
  repo,
  branch,
  bucket,
}: {
  repo: string;
  branch: string;
  bucket: string;
}): Promise<void> => {
  if (!process.env.AWS_ACCESS_KEY_ID) {
    console.warn("No AWS_ACCESS_KEY_ID set, skipping S3 uploads.");
    return;
  }
  if (bucket === "none") {
    console.warn("Bucket set to none, skipping S3 uploads.");
    return;
  }

  const s3 = new S3({});
  const artifacts = fs.existsSync(DIST_DIR) ? fs.readdirSync(DIST_DIR) : [];
  const assets = fs.existsSync(ASSETS_DIR) ? fs.readdirSync(ASSETS_DIR) : [];
  const repoName = repo
    .split("/")
    .slice(-1)[0]
    .replace(/-samepage$/, "");

  const files = artifacts
    .flatMap((name) => {
      const key = `releases/${repo}/${branch === "main" ? "" : `${branch}/`}${name}`;
      const localPath = path.join(DIST_DIR, name);
      const lowerKey = key.toLowerCase();
      if (key === lowerKey) return [{ key, localPath }];
      return [
        { key, localPath },
        { key: lowerKey, localPath },
      ];
    })
    .concat(
      branch === "main"
        ? assets.map((name) => ({
            key: `assets/${repoName}/${name}`,
            localPath: path.join(ASSETS_DIR, name),
          }))
        : [],
    );

  await Promise.all(
    files.map(({ key, localPath }) =>
      s3
        .putObject({
          Bucket: bucket,
          Key: key,
          Body: fs.createReadStream(localPath),
          ContentType: mime.lookup(localPath) || "application/octet-stream",
        })
        .then(() => console.log(`Uploaded ${localPath} to s3://${bucket}/${key}`)),
    ),
  );
};

const main = async (): Promise<void> => {
  const { skipGithub, skipS3, skipBuild, tag, bucket, branch: branchArg } =
    parseArgs();

  const repo = getRepo();
  const branch = getBranch(branchArg);
  const releaseTag = getTag(tag);
  const bucketName = bucket || "samepage.network";
  const repoBaseName = repo.split("/").slice(-1)[0];

  if (!skipBuild) {
    console.log(`Building extension for ${repo} on branch ${branch}...`);
    runBuild();
  } else {
    console.log(`Skipping build for ${repo} on branch ${branch}...`);
  }
  ensureDistExists();

  const zipName = `${repoBaseName}.zip`;
  runZip(zipName);

  if (!skipGithub) {
    await uploadGithubRelease({
      repo,
      tag: releaseTag,
      token: process.env.GITHUB_TOKEN,
      branch,
    });
  }

  if (!skipS3) {
    await uploadS3Artifacts({
      repo,
      branch,
      bucket: bucketName,
    });
  }

  console.log("One-off publish complete.");
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
