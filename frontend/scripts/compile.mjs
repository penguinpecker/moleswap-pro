import solc from "solc";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const contractsDir = path.join(__dirname, "..", "contracts");
const outDir = path.join(__dirname, "..", "artifacts");

fs.mkdirSync(outDir, { recursive: true });

const sources = {};
for (const file of fs.readdirSync(contractsDir)) {
  if (file.endsWith(".sol")) {
    sources[file] = { content: fs.readFileSync(path.join(contractsDir, file), "utf8") };
  }
}

const input = {
  language: "Solidity",
  sources,
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
  },
};

console.log("Compiling contracts...\n");
const output = JSON.parse(solc.compile(JSON.stringify(input)));

if (output.errors) {
  for (const err of output.errors) {
    if (err.severity === "error") {
      console.error(err.formattedMessage);
      process.exit(1);
    } else {
      console.warn(err.formattedMessage);
    }
  }
}

for (const [fileName, contracts] of Object.entries(output.contracts)) {
  for (const [contractName, data] of Object.entries(contracts)) {
    const artifact = {
      contractName,
      abi: data.abi,
      bytecode: "0x" + data.evm.bytecode.object,
    };
    const outPath = path.join(outDir, `${contractName}.json`);
    fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2));
    console.log(`  ${contractName} → ${outPath} (${artifact.bytecode.length / 2} bytes)`);
  }
}

console.log("\nDone.");
