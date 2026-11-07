// Renders and decrypts the Disney Mix boot config (donotcopy/n7c4c656),
// the file that tells the app where the Guest Controller, Mix API and
// cpipe are. See docs/MIX_API.md section 2.
//
//   bun tools/mix-config.ts render <baseUrl> [--out <file>]
//   bun tools/mix-config.ts decrypt <file>
//
// Put the rendered file at StreamingAssets/donotcopy/n7c4c656 in the
// Mix build (the app reads that bundled copy on first boot).
import crypto from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

// Mix/ConfigurationManager.cs GetKey() / GetIV().
const KEY = Buffer.from("U8rYu9uzHmujSvAogNfj4IfuC9GRJzNCarb+cfaYN5k=", "base64");
const IV = Buffer.from("05ec55c6795f972c0f38a2206a81e369", "hex");

/** Disney's original prod config with every service pointed at baseUrl. */
export function renderConfig(baseUrl: string): Record<string, string> {
  const base = baseUrl.replace(/\/+$/, "");
  return {
    guest_baseUrl: base,
    guest_v2_baseUrl: `${base}/jgc/v5`,
    guest_clientId: "DI-SPARK-PROD",
    tou_url_en: "http://disneytermsofuse.com/english/",
    privacy_policy_url_en: "https://disneyprivacycenter.com/privacy-policy-translations/english/",
    need_help_url_en: "https://help.disney.com/Apps/Disney-Mix",
    ca_privacy_url_en: "https://disneyprivacycenter.com/notice-to-california-residents/",
    coppa_url_en: "https://disneyprivacycenter.com/kids-privacy-policy/english/",
    force_update_version: "2.3",
    android_app_store_link: "market://details?id=com.disney.mix",
    ios_app_store_link: "http://itunes.apple.com/app/id1077622694?mt=8",
    cellophane_client_id_assets: "GAE 01D93B3F-8532-4A91-81E7-558BE3600600",
    cpipe_url: `${base}/cpipe`,
    mix_platform_services_url: `${base}/mix`,
    mix_platform_services_cellophane: "F7EA7678-FE45-4A00-89EB-496EFDA74761",
    gcm_sender_id: "133104891689",
  };
}

/** AES-256-CBC (PKCS7) with the app's fixed key and IV, as Base64. */
export function encryptConfig(obj: object): string {
  const c = crypto.createCipheriv("aes-256-cbc", KEY, IV);
  return Buffer.concat([c.update(JSON.stringify(obj, null, 4), "utf8"), c.final()]).toString("base64");
}

export function decryptConfig(b64: string): any {
  const d = crypto.createDecipheriv("aes-256-cbc", KEY, IV);
  return JSON.parse(Buffer.concat([d.update(Buffer.from(b64.trim(), "base64")), d.final()]).toString("utf8"));
}

if (import.meta.main) {
  const [cmd, arg, ...rest] = process.argv.slice(2);
  if (cmd === "render" && arg) {
    const text = encryptConfig(renderConfig(arg));
    const i = rest.indexOf("--out");
    if (i >= 0 && rest[i + 1]) writeFileSync(rest[i + 1], text);
    else process.stdout.write(text + "\n");
  } else if (cmd === "decrypt" && arg) {
    console.log(JSON.stringify(decryptConfig(readFileSync(arg, "utf8")), null, 2));
  } else {
    console.error("usage: bun tools/mix-config.ts render <baseUrl> [--out <file>]\n       bun tools/mix-config.ts decrypt <file>");
    process.exit(2);
  }
}
