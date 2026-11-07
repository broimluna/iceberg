/**
 * cpipe: the Disney Mix app's versioned content CDN (docs/MIX_API.md
 * section 2).
 *
 * - GET /cpipe?restrict=true&cv=<client version>[&v=<manifest version>]
 *   returns the manifest (Mix/CpipeManifestApi.cs). The app sends
 *   `Authorization: <cellophane_client_id_assets>`, a public token baked
 *   into every client, so only its presence is checked.
 * - GET /cpipe/files/[<v>/]<path> serves files named in the manifest
 *   from data/mix/cpipe/. The original CDN put a version segment in
 *   front of each path, so a leading all-digits segment is ignored.
 *
 * The manifest is the recreation's bundled one (version 00134,
 * 2017-02-15) with cdnRoot pointed here and the boot config's version
 * set by config.mix.cpipeConfigVersion.
 */
import express from "express";
import path from "path";
import { existsSync, statSync } from "fs";
import config from "../config.ts";
import manifestFile from "../../data/mix/cpipe-manifest.json";

const router = express.Router();
const FILES_ROOT = path.resolve(import.meta.dir, "../../data/mix/cpipe");
const CONFIG_PATH = "donotcopy/n7c4c656";

router.get('/cpipe', (req, res) => {
    if (!req.headers.authorization) {
        return res.status(400).json({ error: 'missing authorization' });
    }
    const proto = (req.get('x-forwarded-proto') || req.protocol).split(',')[0].trim();
    const manifest = structuredClone((manifestFile as any).manifest);
    manifest.cdnRoot = `${proto}://${req.get('host')}/cpipe/files`;
    manifest.paths[CONFIG_PATH] = { ...manifest.paths[CONFIG_PATH], v: config.mix.cpipeConfigVersion };
    res.json({ ...(manifestFile as any), manifest });
});

router.get('/cpipe/files/*', (req, res) => {
    const segments = String((req.params as any)[0] ?? '').split('/');
    if (segments.length > 1 && /^\d+$/.test(segments[0])) segments.shift();
    const file = path.resolve(FILES_ROOT, segments.join('/'));
    if (!file.startsWith(FILES_ROOT + path.sep) || !existsSync(file) || !statSync(file).isFile()) {
        return res.status(404).end();
    }
    res.sendFile(file);
});

export default router;
