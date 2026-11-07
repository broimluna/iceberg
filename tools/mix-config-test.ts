// The Mix boot config tool: render -> encrypt -> decrypt round-trips, and
// openssl (an independent AES implementation) reads what the CLI writes.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { makeChecker } from "./lib/harness.ts";
import { renderConfig, encryptConfig, decryptConfig } from "./mix-config.ts";

const { check, finish } = makeChecker();
const KEY_HEX = Buffer.from("U8rYu9uzHmujSvAogNfj4IfuC9GRJzNCarb+cfaYN5k=", "base64").toString("hex");
const IV_HEX = "05ec55c6795f972c0f38a2206a81e369";

const cfg = renderConfig("http://h:1/");
const back = decryptConfig(encryptConfig(cfg));
check(back.cpipe_url === "http://h:1/cpipe", `cpipe_url ${back.cpipe_url}`);
check(back.mix_platform_services_url === "http://h:1/mix", `mix_platform_services_url ${back.mix_platform_services_url}`);
check(back.guest_baseUrl === "http://h:1" && back.guest_v2_baseUrl === "http://h:1/jgc/v5", `guest urls ${back.guest_baseUrl} ${back.guest_v2_baseUrl}`);
check(back.guest_clientId === "DI-SPARK-PROD", `guest_clientId ${back.guest_clientId}`);
check(back.mix_platform_services_cellophane === "F7EA7678-FE45-4A00-89EB-496EFDA74761", "cellophane token kept");
check(Object.keys(back).length === 16, `16 keys (${Object.keys(back).length})`);

const dir = mkdtempSync(join(tmpdir(), "mix-config-"));
const out = join(dir, "n7c4c656");
await $`bun ${import.meta.dir}/mix-config.ts render http://h:1 --out ${out}`.quiet();
const viaOpenssl = await $`base64 -d ${out} | openssl enc -d -aes-256-cbc -K ${KEY_HEX} -iv ${IV_HEX}`.quiet().text();
let parsed: any = null;
try { parsed = JSON.parse(viaOpenssl); } catch {}
check(parsed?.cpipe_url === "http://h:1/cpipe", `openssl decrypts the CLI output (${parsed?.cpipe_url})`);

const printed = await $`bun ${import.meta.dir}/mix-config.ts decrypt ${out}`.quiet().text();
check(JSON.parse(printed).guest_clientId === "DI-SPARK-PROD", "CLI decrypt prints the JSON");
check(readFileSync(out, "utf8").trim().length > 0 && !readFileSync(out, "utf8").includes("{"), "file is encrypted Base64, not JSON");

finish();
