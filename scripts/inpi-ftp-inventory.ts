import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { prisma } from "../lib/prisma";

loadDotEnv();

const user = process.env.INPI_FTP_USER;
const password = process.env.INPI_FTP_PASSWORD;
const baseUrl = process.env.INPI_FTP_BASE_URL ?? "ftp://www.inpi.net/";

if (!user || !password) {
  console.log("INPI FTP inventaire pret, mais INPI_FTP_USER / INPI_FTP_PASSWORD manquent dans .env.");
  process.exit(0);
}

async function ensureTable() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS inpi_ftp_files (
      file_name TEXT PRIMARY KEY,
      file_type TEXT NOT NULL,
      size_bytes BIGINT,
      modified_label TEXT,
      remote_url TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'DISCOVERED',
      discovered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function listRemote() {
  const stdout = await runCurl(baseUrl);
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseFtpLine)
    .filter((item): item is RemoteFile => Boolean(item));
}

type RemoteFile = {
  fileName: string;
  sizeBytes: bigint;
  modifiedLabel: string;
  remoteUrl: string;
  fileType: string;
};

function parseFtpLine(line: string): RemoteFile | null {
  const parts = line.split(/\s+/);
  if (parts.length < 9) return null;
  const size = BigInt(parts[4] ?? "0");
  const modifiedLabel = parts.slice(5, 8).join(" ");
  const fileName = parts.slice(8).join(" ");
  if (!fileName || fileName === "readme.txt") return null;

  return {
    fileName,
    sizeBytes: size,
    modifiedLabel,
    remoteUrl: `${baseUrl.replace(/\/$/, "")}/${encodeURIComponent(fileName)}`,
    fileType: inferFileType(fileName),
  };
}

function inferFileType(fileName: string) {
  if (fileName.includes("formalites")) return "RNE_FORMALITES";
  if (fileName.includes("comptes_annuels")) return "RNE_COMPTES_ANNUELS";
  if (fileName.includes("actes")) return "RNE_ACTES";
  return "UNKNOWN";
}

async function saveFile(file: RemoteFile) {
  await prisma.$executeRaw`
    INSERT INTO inpi_ftp_files (
      file_name,
      file_type,
      size_bytes,
      modified_label,
      remote_url,
      status,
      updated_at
    )
    VALUES (
      ${file.fileName},
      ${file.fileType},
      ${file.sizeBytes},
      ${file.modifiedLabel},
      ${file.remoteUrl},
      'DISCOVERED',
      now()
    )
    ON CONFLICT (file_name) DO UPDATE SET
      file_type = EXCLUDED.file_type,
      size_bytes = EXCLUDED.size_bytes,
      modified_label = EXCLUDED.modified_label,
      remote_url = EXCLUDED.remote_url,
      updated_at = now()
  `;
}

function runCurl(url: string) {
  return new Promise<string>((resolvePromise, reject) => {
    const curl = spawn(
      "curl.exe",
      ["--silent", "--show-error", "--fail", "--user", `${user}:${password}`, url],
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
      if (code !== 0) reject(new Error(redact(stderr || `curl exited with ${code}`)));
      else resolvePromise(stdout);
    });
  });
}

async function main() {
  await ensureTable();
  const files = await listRemote();
  for (const file of files) {
    await saveFile(file);
  }

  console.log(`${files.length} fichiers INPI FTP inventories.`);
  for (const file of files) {
    console.log(`${file.fileType} ${formatBytes(file.sizeBytes)} ${file.fileName}`);
  }
}

main()
  .catch((error) => {
    console.error(redact((error as Error).message));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

function formatBytes(value: bigint) {
  const gb = Number(value) / 1024 / 1024 / 1024;
  return `${gb.toFixed(2)} Go`;
}

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
