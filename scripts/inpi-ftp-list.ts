import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

loadDotEnv();

const host = process.env.INPI_FTP_HOST ?? "www.inpi.net";
const user = process.env.INPI_FTP_USER;
const password = process.env.INPI_FTP_PASSWORD;
const baseUrl = process.env.INPI_FTP_BASE_URL ?? `ftp://${host}/`;

if (!user || !password) {
  console.log("INPI FTP pret, mais INPI_FTP_USER / INPI_FTP_PASSWORD manquent dans .env.");
  process.exit(0);
}

const target = process.argv[2] ?? baseUrl;

const curl = spawn(
  "curl.exe",
  [
    "--silent",
    "--show-error",
    "--fail",
    "--user",
    `${user}:${password}`,
    target,
  ],
  { stdio: ["ignore", "pipe", "pipe"] },
);

let stdout = "";
let stderr = "";

curl.stdout.on("data", (chunk) => {
  stdout += chunk.toString();
});

curl.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});

curl.on("close", (code) => {
  if (code !== 0) {
    console.error(redact(stderr || `curl exited with ${code}`));
    process.exit(code ?? 1);
  }

  console.log(stdout.trim());
});

function redact(value: string) {
  return value.replaceAll(password ?? "", "[REDACTED]");
}

function loadDotEnv() {
  const path = resolve(process.cwd(), ".env");
  if (!existsSync(path)) return;

  const content = readFileSync(path, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [key, ...valueParts] = trimmed.split("=");
    if (process.env[key]) continue;
    const rawValue = valueParts.join("=");
    process.env[key] = rawValue.replace(/^"|"$/g, "");
  }
}
