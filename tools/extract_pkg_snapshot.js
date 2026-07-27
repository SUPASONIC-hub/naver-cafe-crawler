const fs = require("fs");
const path = require("path");
const vm = require("vm");

const exePath = process.argv[2] || "naver-cafe-crawler.exe";
const outDir = process.argv[3] || "recovered";

const exe = fs.readFileSync(exePath);
const marker = "function readPrelude";
const markerAt = exe.indexOf(Buffer.from(marker));
if (markerAt < 0) {
  throw new Error("pkg readPrelude marker not found");
}

const window = exe.subarray(markerAt, markerAt + 1200).toString("utf8");
const readNumber = (name) => {
  const match = window.match(new RegExp(`${name} = '([0-9 ]+)' \\| 0`));
  if (!match) throw new Error(`${name} not found`);
  return Number(match[1].trim());
};

const payloadPosition = readNumber("PAYLOAD_POSITION");
const payloadSize = readNumber("PAYLOAD_SIZE");
const preludePosition = readNumber("PRELUDE_POSITION");
const preludeSize = readNumber("PRELUDE_SIZE");

const payload = exe.subarray(payloadPosition, payloadPosition + payloadSize);
const prelude = exe.subarray(preludePosition, preludePosition + preludeSize).toString("utf8");

const argsStart = findPreludeArgsStart(prelude);
const argsSource = `[${prelude.slice(argsStart, prelude.lastIndexOf(");"))}]`;
const args = vm.runInNewContext(argsSource);
const vfsIndex = args.findIndex((arg) =>
  arg && typeof arg === "object" && !Array.isArray(arg) &&
  Object.keys(arg).some((key) => key.includes("\\snapshot\\naver-cafe-crawler\\"))
);
if (vfsIndex < 0) {
  throw new Error(`virtual filesystem argument not found; parsed ${args.length} args`);
}

const vfs = args[vfsIndex];
const entrypoint = args.find((arg) =>
  typeof arg === "string" && arg.includes("\\snapshot\\naver-cafe-crawler\\")
);

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(
  path.join(outDir, "pkg-manifest.json"),
  JSON.stringify({ entrypoint, vfs }, null, 2)
);

let written = 0;
for (const [snapshotPath, record] of Object.entries(vfs)) {
  if (!snapshotPath.startsWith("C:\\snapshot\\naver-cafe-crawler\\")) continue;
  if (!record["0"]) continue;

  const rel = snapshotPath
    .replace("C:\\snapshot\\naver-cafe-crawler\\", "")
    .replaceAll("\\", "/");
  const target = path.join(outDir, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });

  const [offset, size] = record["0"];
  fs.writeFileSync(target, payload.subarray(offset, offset + size));
  written += 1;
}

console.log(JSON.stringify({
  payloadPosition,
  payloadSize,
  preludePosition,
  preludeSize,
  entrypoint,
  vfsIndex,
  filesWritten: written,
}, null, 2));

function findPreludeArgsStart(source) {
  const tailNeedle = '\n,\n"C:\\\\snapshot\\\\naver-cafe-crawler\\\\launcher.js"';
  const entryArg = source.lastIndexOf(tailNeedle);
  if (entryArg < 0) throw new Error("entrypoint argument not found");

  let depth = 0;
  let inString = false;
  let quote = "";
  let escaped = false;

  for (let i = entryArg - 1; i >= 0; i -= 1) {
    const ch = source[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === quote) {
        inString = false;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = true;
      quote = ch;
      continue;
    }
    if (ch === "}") {
      depth += 1;
      continue;
    }
    if (ch === "{") {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }
  throw new Error("virtual filesystem object start not found");
}
