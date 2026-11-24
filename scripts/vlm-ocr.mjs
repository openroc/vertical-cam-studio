// 把 abtest/ 下的各阶段图像逐张喂给本地 VLM（llama.cpp OpenAI 兼容接口），
// 做 OCR A/B 对照，找出"白板化"影响识别的具体环节。
//
//   node scripts/vlm-ocr.mjs [dir] [endpoint]
//
// 例：node scripts/vlm-ocr.mjs abtest http://127.0.0.1:8080

import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const dir = resolve(process.argv[2] || 'abtest');
const endpoint = process.argv[3] || 'http://127.0.0.1:8080';

const PROMPT = '请准确读出图片中的文字，只输出文字本身，不要解释、不要标点。';

async function ocr(file) {
  const b64 = readFileSync(file).toString('base64');
  const mime = file.toLowerCase().endsWith('.jpg') ? 'image/jpeg' : 'image/png';
  const res = await fetch(`${endpoint}/v1/chat/completions`, {
    method: 'POST',
    // 与 --audit 主进程版保持一致：本地推理卡住时不能让脚本永久挂起
    signal: AbortSignal.timeout(120000),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'local',
      temperature: 0,
      max_tokens: 64,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: PROMPT },
          { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } }
        ]
      }]
    })
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const json = await res.json();
  return (json.choices?.[0]?.message?.content || '').trim();
}

const files = readdirSync(dir)
  .filter((f) => /\.(png|jpg|jpeg)$/i.test(f))
  .sort();

console.log(`endpoint: ${endpoint}`);
console.log(`files   : ${files.length}\n`);

const results = [];
for (const f of files) {
  const t0 = Date.now();
  let text = '';
  let err = '';
  try {
    text = await ocr(join(dir, f));
  } catch (e) {
    err = e.message;
  }
  const ms = Date.now() - t0;
  results.push({ file: f, text, ms, err });
  console.log(`${f.padEnd(24)} ${String(ms).padStart(6)}ms  ->  ${err ? `[ERR] ${err}` : JSON.stringify(text)}`);
}

console.log('\n--- 汇总 ---');
for (const r of results) {
  const hit = /绝对值/.test(r.text) && /\|\|/.test(r.text);
  const brackets = /\[\]/.test(r.text) || /【】/.test(r.text);
  const flag = hit ? '✔ 双竖线正确' : brackets ? '✘ 变成方括号' : '△ 其他差异';
  console.log(`${r.file.padEnd(24)} ${flag}   ${JSON.stringify(r.text)}`);
}
