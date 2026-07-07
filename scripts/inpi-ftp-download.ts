import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { prisma } from "../lib/prisma";

loadDotEnv();

const user = process.env.INPI_FTP_USER;
const password = process.env.INPI_FTP_PASSWORD;
const outputDir = resolve(process.cwd(), process.env.INPI_DOWNLOAD_DIR ?? "data/inpi");
const fileName = process.argv[2];

if (!user || !password) {
  console.log("INPI FTP download pret, mais INPI_FTP_USER / INPI_FTP_PASSWORD manquent dans .env.");
  process.exit(0);
}

if (!fileName) {
  console.error("Usage: npm run inpi:ftp:download -- <file_name>");
  process.exit(1);
}

mkdirSync(outputDir, { recursive: true });

const file = await prisma.$queryRawUnsafe<Array<{ remote_url: string; file_name: string }>>(
  "SELECT remote_url, file_name FROM inpi_ftp_files WHERE file_name = $1",
  fileName,
);

if (!file[0]) {
  console.error(`Fichier inconnu dans inpi_ftp_files: ${fileName}`);
  process.exit(1);
}

const targetPath = resolve(outputDir, basename(file[0].file_name));
await prisma.$executeRaw`
  UPDATE inpi_ftp_files
  SET status = 'DOWNLOADING', updated_at = now()
  WHERE file_name = ${fileName}
`;

const curl = spawn(
  "curl.exe",
  [
    "--fail",
    "--location",
    "--continue-at",
    "-",
    "--user",
    `${user}:${password}`,
    "--output",
    targetPath,
    file[0].remote_url,
  ],
  { stdio: ["ignore", "inherit", "pipe"] },
);

let stderr = "";
curl.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
  process.stderr.write(redact(chunk.toString()));
});

curl.on("close", async (code) => {
  if (code === 0) {
    await prisma.$executeRaw`
      UPDATE inpi_ftp_files
      SET status = 'DOWNLOADED', updated_at = now()
      WHERE file_name = ${fileName}
    `;
    console.log(`Telechargement termine: ${targetPath}`);
  } else {
    await prisma.$executeRaw`
      UPDATE inpi_ftp_files
      SET status = 'DOWNLOAD_ERROR', updated_at = now()
      WHERE file_name = ${fileName}
    `;
    console.error(redact(stderr || `curl exited with ${code}`));
    process.exitCode = code ?? 1;
  }

  await prisma.$disconnect();
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
    process.env[key] = valueParts.join("=").replace(/^"|"$/g, "");
  }
}
