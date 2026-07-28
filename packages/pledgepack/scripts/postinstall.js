#!/usr/bin/env node

// Postinstall script for pledgepack
// Downloads the native pledgepack binary from GitHub Releases for the current platform.

import { existsSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';

const __dirname = dirname(fileURLToPath(import.meta.url));
const platform = process.platform;
const arch = process.arch;

const GITHUB_REPO = 'pledgeandgrow/pledgerepo';
const VERSION = '0.2.6';

const platformAssets = {
  'darwin': {
    'arm64': 'pledge-darwin-arm64',
    'x64': 'pledge-darwin-x64',
  },
  'linux': {
    'x64': 'pledge-linux-x64',
  },
  'win32': {
    'x64': 'pledge.exe',
  },
};

const assetName = platformAssets[platform]?.[arch];

if (!assetName) {
  console.warn(`[pledgepack] No prebuilt binary for ${platform}-${arch}. Building from source...`);
  process.exit(0);
}

// Check if local binary already exists (from cargo build)
const binDir = join(__dirname, '..', 'bin');
const localBinary = join(binDir, 'pledgepack');
const localExe = join(binDir, 'pledgepack.exe');

if (existsSync(localBinary) || existsSync(localExe)) {
  console.log('[pledgepack] Using local binary.');
  process.exit(0);
}

// Download from GitHub Releases
const downloadUrl = `https://github.com/${GITHUB_REPO}/releases/download/v${VERSION}/${assetName}`;
const outputPath = platform === 'win32' ? localExe : localBinary;

async function download() {
  console.log(`[pledgepack] Downloading binary from GitHub Releases (v${VERSION})...`);
  console.log(`  → ${downloadUrl}`);

  mkdirSync(binDir, { recursive: true });

  try {
    const response = await fetch(downloadUrl, { redirect: 'follow' });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const tmpPath = outputPath + '.tmp';
    const writeStream = createWriteStream(tmpPath);
    await pipeline(Readable.fromWeb(response.body), writeStream);
    renameSync(tmpPath, outputPath);

    console.log('[pledgepack] Binary downloaded successfully.');
  } catch (err) {
    console.warn(`[pledgepack] Failed to download binary: ${err.message}`);
    console.warn('[pledgepack] Run "cargo build --release" in the pledgepack package to build from source.');
    try { unlinkSync(outputPath + '.tmp'); } catch {}
    process.exit(0);
  }
}

download();
