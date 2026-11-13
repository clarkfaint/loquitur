#!/usr/bin/env node
/**
 * Lectern icon generator (U-005).
 *
 * Draws an original geometric mark — a rounded square carrying three horizontal bars of decreasing
 * length — with `@napi-rs/canvas` at each requested size. Nothing is downloaded or traced: the mark is
 * built from a rounded rectangle and three filled rectangles, and it is drawn from scratch at every
 * size so the set stays sharp instead of being resampled from one bitmap.
 *
 *   node make-icons.mjs --out <dir> --sizes 16,32,48,128
 *
 * The mark is intentionally type-free, so icon generation never depends on which fonts the host
 * happens to expose.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createCanvas } from "@napi-rs/canvas";

const USAGE = "Usage: node make-icons.mjs --out <dir> [--sizes 16,32,48,128]";
const DEFAULT_SIZES = [16, 32, 48, 128];
const MAX_SIZE = 1024;
const MARK = { background: "#1d3557", foreground: "#f1faee", bars: [1, 0.72, 0.44] };

function drawMark(size) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext("2d");
  const inset = Math.max(1, Math.round(size * 0.06));
  const box = size - inset * 2;
  ctx.fillStyle = MARK.background;
  ctx.beginPath();
  ctx.roundRect(inset, inset, box, box, Math.max(2, Math.round(size * 0.18)));
  ctx.fill();

  const barHeight = Math.max(1, Math.round(size * 0.1));
  const gap = Math.max(1, Math.round(size * 0.1));
  const total = barHeight * MARK.bars.length + gap * (MARK.bars.length - 1);
  let y = Math.round((size - total) / 2);
  ctx.fillStyle = MARK.foreground;
  for (const share of MARK.bars) {
    const width = Math.round(box * share);
    ctx.fillRect(Math.round((size - width) / 2), y, width, barHeight);
    y += barHeight + gap;
  }
  return canvas.toBuffer("image/png");
}

function parseArguments(argv) {
  let out = null;
  let sizes = DEFAULT_SIZES;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--out") {
      const value = argv[index + 1];
      if (value === undefined || value === "") return { error: "--out needs a directory" };
      out = value;
      index += 1;
    } else if (argument === "--sizes") {
      const value = argv[index + 1];
      if (value === undefined || value === "") return { error: "--sizes needs a comma-separated list" };
      sizes = value.split(",").map((part) => Number.parseInt(part.trim(), 10));
      index += 1;
    } else if (argument !== "") return { error: `Unexpected argument: ${argument}` };
  }
  if (out === null) return { error: "--out is required" };
  for (const size of sizes) {
    if (!Number.isInteger(size) || size < 1 || size > MAX_SIZE) return { error: `Invalid size: ${size}` };
  }
  if (sizes.length === 0) return { error: "--sizes needs at least one size" };
  return { out, sizes };
}

async function main(argv) {
  const options = parseArguments(argv);
  if (options.error !== undefined) {
    process.stderr.write(`${options.error}\n${USAGE}\n`);
    return 1;
  }
  await mkdir(options.out, { recursive: true });
  const written = [];
  for (const size of options.sizes) {
    const png = drawMark(size);
    await writeFile(join(options.out, `${size}.png`), png);
    written.push(`${size}.png (${png.length} bytes)`);
  }
  process.stdout.write(`make-icons: wrote ${written.join(", ")} into ${options.out}\n`);
  return 0;
}

process.exitCode = await main(process.argv.slice(2));
