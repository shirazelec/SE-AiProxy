import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { BoundedCache } from './sessionCache.js';
import { analyzeImageWithDeepSeekVision } from './deepseek.js';

// Cache vision analysis by sha256 hash or file mtime so we never re-analyze identical images
const visionCache = new BoundedCache({ maxEntries: 200, ttlMs: 24 * 60 * 60 * 1000 });

function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

const IMAGE_EXT_RE = /\.(?:png|jpe?g|webp|bmp|gif)$/i;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

// Local paths come from client requests; only ever read real image files so a request
// cannot make the proxy upload arbitrary files (keys, ~/.ssh, config.json) to DeepSeek.
export function isSafeImageFile(filePath, stat = fs.statSync(filePath)) {
  if (!IMAGE_EXT_RE.test(String(filePath)) || !stat.isFile() || stat.size === 0 || stat.size > MAX_IMAGE_BYTES) return false;
  const head = Buffer.alloc(12);
  const fd = fs.openSync(filePath, 'r');
  try { fs.readSync(fd, head, 0, 12, 0); } finally { fs.closeSync(fd); }
  return head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) // PNG
    || (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) // JPEG
    || head.subarray(0, 4).toString('latin1') === 'GIF8'
    || (head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP')
    || head.subarray(0, 2).toString('latin1') === 'BM';
}

export function parseDataUrl(url) {
  if (typeof url !== 'string') return null;
  const match = /^data:(image\/[a-zA-Z0-9+.-]+);base64,(.+)$/.exec(url);
  if (!match) return null;
  return {
    mimeType: match[1],
    buffer: Buffer.from(match[2], 'base64')
  };
}

export function findImageFileInText(text) {
  if (!text || typeof text !== 'string') return null;
  const regex = /(?:path=["']([^"']+\.(?:png|jpe?g|webp|bmp|gif))["']|((?:[\/~]|\b)[^\s"'<>:]+\.(?:png|jpe?g|webp|bmp|gif))\b)/i;
  const match = regex.exec(text);
  if (!match) return null;
  const candidate = (match[1] || match[2] || '').trim();
  if (candidate && fs.existsSync(candidate)) {
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile()) return candidate;
    } catch {}
  }
  return null;
}

export async function getVisionAnalysis({ buffer, filePath, token, signal, prompt }) {
  let fileBuffer = buffer;
  let cacheKey = null;

  if (filePath && !fileBuffer) {
    try {
      if (fs.existsSync(filePath)) {
        const stat = fs.statSync(filePath);
        if (!isSafeImageFile(filePath, stat)) {
          console.warn(`[Vision] Refusing to read non-image file ${filePath}`);
          return null;
        }
        cacheKey = `file:${filePath}:${stat.mtimeMs}:${stat.size}`;
        if (visionCache.has(cacheKey)) {
          return visionCache.get(cacheKey);
        }
        fileBuffer = fs.readFileSync(filePath);
      }
    } catch (err) {
      console.warn(`[Vision] Failed to read image file ${filePath}:`, err.message);
      return null;
    }
  }

  if (fileBuffer) {
    if (!cacheKey) {
      cacheKey = `buf:${sha256Buffer(fileBuffer)}`;
    }
    if (visionCache.has(cacheKey)) {
      return visionCache.get(cacheKey);
    }
  }

  if (!fileBuffer && !filePath) return null;

  try {
    console.log(`[Vision] Calling DeepSeek Multimodal Vision API for image (${filePath || 'buffer'})...`);
    const analysis = await analyzeImageWithDeepSeekVision({
      token,
      buffer: fileBuffer,
      filePath,
      prompt: prompt || 'Describe this image in detail and extract all visible text, numbers, labels, icons, colors, layout, and UI elements. Respond in the primary language of the image content (e.g. Persian/فارسی or English).',
      signal
    });

    if (analysis) {
      visionCache.set(cacheKey, analysis);
      console.log(`[Vision] Vision analysis succeeded (${analysis.length} chars).`);
      return analysis;
    }
  } catch (err) {
    console.warn(`[Vision] Vision analysis failed:`, err.message);
  }
  return null;
}

export async function enrichInputWithVision({ input, token, signal }) {
  if (!Array.isArray(input) || input.length === 0 || !token) return input;

  // Track tool calls to match call_id for view_image
  const toolCallPaths = new Map();
  for (const item of input) {
    if (item?.type === 'function_call' || item?.type === 'call') {
      const name = item.name || item.call_id;
      if (name === 'view_image' && item.call_id) {
        let args = item.arguments;
        if (typeof args === 'string') {
          try { args = JSON.parse(args); } catch {}
        }
        if (args?.path) {
          toolCallPaths.set(item.call_id, args.path);
        }
      }
    }
  }

  // Iterate over items and enrich any image references
  for (let i = 0; i < input.length; i++) {
    const item = input[i];
    if (!item) continue;

    // 1. Tool result for view_image
    if ((item.type === 'function_call_output' || item.type === 'tool_result') && item.call_id) {
      const imgPath = toolCallPaths.get(item.call_id);
      if (imgPath && fs.existsSync(imgPath)) {
        const analysis = await getVisionAnalysis({ filePath: imgPath, token, signal });
        if (analysis) {
          item.output = `[DeepSeek Multimodal Vision Analysis of ${imgPath}]:\n${analysis}`;
          item.content = item.output;
        }
      }
    }

    // 2. User message with attached image parts
    if (item.role === 'user' || item.type === 'userMessage') {
      if (Array.isArray(item.content)) {
        for (const part of item.content) {
          if (!part) continue;
          if (part.type === 'image_url' && part.image_url?.url) {
            const dataUrl = parseDataUrl(part.image_url.url);
            let analysis = null;
            if (dataUrl) {
              analysis = await getVisionAnalysis({ buffer: dataUrl.buffer, token, signal });
            } else if (part.image_url.url.startsWith('file://')) {
              const fPath = part.image_url.url.replace('file://', '');
              analysis = await getVisionAnalysis({ filePath: fPath, token, signal });
            } else if (fs.existsSync(part.image_url.url)) {
              analysis = await getVisionAnalysis({ filePath: part.image_url.url, token, signal });
            }
            if (analysis) {
              part.type = 'text';
              part.text = `[DeepSeek Multimodal Vision Perception of Attached Image]:\n${analysis}`;
            }
          } else if (part.type === 'input_image' && part.image_url) {
            const dataUrl = parseDataUrl(part.image_url);
            const analysis = dataUrl ? await getVisionAnalysis({ buffer: dataUrl.buffer, token, signal }) : null;
            if (analysis) {
              part.type = 'text';
              part.text = `[DeepSeek Multimodal Vision Perception of Attached Image]:\n${analysis}`;
            }
          }
        }
      } else if (typeof item.content === 'string') {
        const fPath = findImageFileInText(item.content);
        if (fPath) {
          const analysis = await getVisionAnalysis({ filePath: fPath, token, signal });
          if (analysis) {
            item.content = `${item.content}\n\n[DeepSeek Multimodal Vision Perception of Image (${fPath})]:\n${analysis}`;
          }
        }
      }
    }
  }

  return input;
}
