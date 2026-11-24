'use strict';

/**
 * 开发工具探针（--smoke / --abtest / --shapes / --audit）。
 * 从 main.js 拆出以降低单体文件体积；宿主依赖全部通过 createProbes 注入。
 * getMainWindow() 用 getter 而非快照，兼容窗口重建。
 */
function createProbes({ app, BrowserWindow, fs, path, getMainWindow, flushUsage, usageFile, usageLogFile }) {

/* ------------------------------------------------------------------ */
/* --abtest：生成白板管线的各阶段图像，供本地 VLM 做 A/B OCR 对照      */
/* ------------------------------------------------------------------ */

async function runAbTest() {
  const outDir = path.join(app.getAppPath(), 'abtest');
  fs.mkdirSync(outDir, { recursive: true });

  try {
    await waitForDevReady();

    /* 细笔画扫描：把 "||" 画成精确 1/2/3/5 px 宽的竖线，
       再分别过 灰度 / 对比度 / 二值化 / JPEG / 缩小 各阶段，
       看哪一档会把 "||" 变成 "[]"。 */
    const variants = await getMainWindow().webContents.executeJavaScript(`(async () => {
      const WIDTHS = [1, 2, 3, 5];
      const results = [];

      const mkCanvas = (w, h) => {
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        return c;
      };

      for (const w of WIDTHS) {
        const W = 460;
        const H = 110;

        // 1) 画布：白板底 + "绝对值" + 精确 w 像素宽的两根竖线
        const base = mkCanvas(W, H);
        const ctx = base.getContext('2d');
        const g = ctx.createLinearGradient(0, 0, W, H);
        g.addColorStop(0, '#fdfdfb');
        g.addColorStop(0.6, '#f2f2ee');
        g.addColorStop(1, '#e4e4df');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = '#1c1c1c';
        ctx.font = '34px "Microsoft YaHei", "PingFang SC", sans-serif';
        ctx.textBaseline = 'middle';
        const label = '绝对值';
        ctx.fillText(label, 24, H / 2);
        const textW = ctx.measureText(label).width;
        const barTop = Math.round(H / 2 - 16);
        const barH = 32;
        const barX = Math.round(24 + textW + 14);
        const gap = 5;
        ctx.fillRect(barX, barTop, w, barH);
        ctx.fillRect(barX + w + gap, barTop, w, barH);

        // 2) 模拟相机拍摄：轻微失焦 + 噪点
        const photo = mkCanvas(W, H);
        const pctx = photo.getContext('2d');
        pctx.filter = 'blur(0.5px)';
        pctx.drawImage(base, 0, 0);
        const id = pctx.getImageData(0, 0, W, H);
        for (let i = 0; i < id.data.length; i += 4) {
          const n = (Math.random() - 0.5) * 12;
          id.data[i] += n; id.data[i + 1] += n; id.data[i + 2] += n;
        }
        pctx.putImageData(id, 0, 0);

        // 3) 各阶段（走应用里同一套白板算法）
        const clone = () => {
          const c = mkCanvas(W, H);
          c.getContext('2d').drawImage(photo, 0, 0);
          return c;
        };

        const contrast = clone();
        window.__wb.applyWhiteboard(contrast, { contrast: 1.8, binarize: false });

        const binary = clone();
        window.__wb.applyWhiteboard(binary, { contrast: 1.8, binarize: true });

        // 4) 缩小一半（模拟 VLM 内部对大图的下采样）
        const half = (src) => {
          const c = mkCanvas(Math.round(src.width / 2), Math.round(src.height / 2));
          const cx = c.getContext('2d');
          cx.imageSmoothingEnabled = true;
          cx.drawImage(src, 0, 0, c.width, c.height);
          return c;
        };
        const rawHalf = half(photo);
        const binHalf = half(binary);

        // 5) 量一下竖线笔画特征
        const profile = (canvas, scale) => {
          const s = scale || 1;
          const cx = canvas.getContext('2d', { willReadFrequently: true });
          const d = cx.getImageData(0, 0, canvas.width, canvas.height).data;
          const ink = [];
          for (let x = 0; x < canvas.width; x += 1) {
            let n = 0;
            for (let y = 0; y < canvas.height; y += 1) {
              const i = (y * canvas.width + x) * 4;
              const g2 = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
              if (g2 < 128) n += 1;
            }
            ink.push(n);
          }
          const bx = Math.round(barX * s);
          const bw = Math.max(1, Math.round(w * s));
          const bTop = Math.round(barTop * s);
          const bH = Math.max(1, Math.round(barH * s));
          const region = [];
          for (let x = Math.max(0, bx - 4); x < Math.min(canvas.width, bx + 2 * bw + Math.round(gap * s) + 6); x += 1) {
            region.push({ x, ink: ink[x] });
          }
          // 竖线连续性：中间有多少行没有墨
          const rowsWithInk = [];
          for (let y = bTop; y < Math.min(canvas.height, bTop + bH); y += 1) {
            let n = 0;
            for (let x = bx; x < Math.min(canvas.width, bx + bw); x += 1) {
              const i = (y * canvas.width + x) * 4;
              const g2 = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
              if (g2 < 128) n += 1;
            }
            rowsWithInk.push(n);
          }
          const solidRows = rowsWithInk.filter((n) => n > 0).length;
          return {
            barX: bx,
            barH: bH,
            solidRows,
            brokenRows: rowsWithInk.length - solidRows,
            cols: region
          };
        };

        const push = (name, canvas, type, quality) => {
          results.push({
            name,
            width: w,
            type,
            dataUrl: canvas.toDataURL(type, quality)
          });
        };

        push('w' + w + '_raw.png', photo, 'image/png');
        push('w' + w + '_contrast.png', contrast, 'image/png');
        push('w' + w + '_binarize.png', binary, 'image/png');
        push('w' + w + '_binarize_q92.jpg', binary, 'image/jpeg', 0.92);
        push('w' + w + '_raw_q92.jpg', photo, 'image/jpeg', 0.92);
        push('w' + w + '_raw_x50.png', rawHalf, 'image/png');
        push('w' + w + '_binarize_x50.png', binHalf, 'image/png');

        results.push({
          name: 'profile_w' + w,
          width: w,
          profile: {
            raw: profile(photo, 1),
            contrast: profile(contrast, 1),
            binary: profile(binary, 1),
            rawHalf: profile(rawHalf, 0.5),
            binHalf: profile(binHalf, 0.5)
          }
        });
      }

      /* ---- 真实感样本：透视倾斜 + 失焦 + 噪点 + 不均匀光照 ---- */
      const RW = 640;
      const RH = 360;
      const CROP = { x: 30, y: 100, w: 300, h: 120 };

      const board = mkCanvas(RW, RH);
      const bctx = board.getContext('2d');
      const bg = bctx.createLinearGradient(0, 0, RW, RH);
      bg.addColorStop(0, '#fbfbf8');
      bg.addColorStop(0.5, '#efefeb');
      bg.addColorStop(1, '#dcdcd6');
      bctx.fillStyle = bg;
      bctx.fillRect(0, 0, RW, RH);
      bctx.save();
      bctx.translate(RW / 2, RH / 2);
      bctx.rotate(3 * Math.PI / 180);          // 相机与白板不垂直
      bctx.translate(-RW / 2, -RH / 2);
      bctx.fillStyle = '#1b1b1b';
      bctx.font = '40px "Microsoft YaHei", "PingFang SC", sans-serif';
      bctx.textBaseline = 'middle';
      bctx.fillText('绝对值', 60, 160);
      const tw = bctx.measureText('绝对值').width;
      const bx = 60 + tw + 18;
      bctx.fillRect(bx, 138, 2, 44);
      bctx.fillRect(bx + 11, 138, 2, 44);
      bctx.restore();

      const photo = mkCanvas(RW, RH);
      const pctx = photo.getContext('2d');
      pctx.filter = 'blur(0.7px)';
      pctx.drawImage(board, 0, 0);
      const pid = pctx.getImageData(0, 0, RW, RH);
      for (let i = 0; i < pid.data.length; i += 4) {
        const n = (Math.random() - 0.5) * 16;
        pid.data[i] += n; pid.data[i + 1] += n; pid.data[i + 2] += n;
      }
      pctx.putImageData(pid, 0, 0);
      // 一侧阴影
      const sh = pctx.createLinearGradient(0, 0, RW, 0);
      sh.addColorStop(0, 'rgba(0,0,0,0.16)');
      sh.addColorStop(0.45, 'rgba(0,0,0,0)');
      sh.addColorStop(1, 'rgba(0,0,0,0.10)');
      pctx.fillStyle = sh;
      pctx.fillRect(0, 0, RW, RH);

      const cropOf = (src) => {
        const c = mkCanvas(CROP.w, CROP.h);
        c.getContext('2d').drawImage(src, CROP.x, CROP.y, CROP.w, CROP.h, 0, 0, CROP.w, CROP.h);
        return c;
      };
      const cloneOf = (src) => {
        const c = mkCanvas(src.width, src.height);
        c.getContext('2d').drawImage(src, 0, 0);
        return c;
      };

      const realFullRaw = photo;
      const realFullContrast = cloneOf(photo);
      window.__wb.applyWhiteboard(realFullContrast, { contrast: 1.8, binarize: false });
      const realFullBin = cloneOf(photo);
      window.__wb.applyWhiteboard(realFullBin, { contrast: 1.8, binarize: true });

      const realCropRaw = cropOf(photo);
      const realCropContrast = cropOf(realFullContrast);
      const realCropBin = cropOf(realFullBin);

      const pushReal = (name, canvas, type, quality) => {
        results.push({ name, width: 0, type, dataUrl: canvas.toDataURL(type, quality) });
      };

      pushReal('real_full_raw.png', realFullRaw, 'image/png');
      pushReal('real_full_contrast.png', realFullContrast, 'image/png');
      pushReal('real_full_binarize.png', realFullBin, 'image/png');
      pushReal('real_full_binarize_q92.jpg', realFullBin, 'image/jpeg', 0.92);
      pushReal('real_full_raw_q92.jpg', realFullRaw, 'image/jpeg', 0.92);
      pushReal('real_crop_raw.png', realCropRaw, 'image/png');
      pushReal('real_crop_contrast.png', realCropContrast, 'image/png');
      pushReal('real_crop_binarize.png', realCropBin, 'image/png');
      pushReal('real_crop_binarize_q92.jpg', realCropBin, 'image/jpeg', 0.92);
      pushReal('real_crop_raw_q92.jpg', realCropRaw, 'image/jpeg', 0.92);

      /* ---- 手写笔画：起收笔带"喇叭口"（笔画两端变粗），模拟真实白板 ---- */
      const FLARES = [
        { w: 2, ft: 2, fb: 1, tag: 'f2' },
        { w: 3, ft: 2, fb: 2, tag: 'f3' }
      ];

      for (const fl of FLARES) {
        const FW = 460;
        const FH = 110;
        const fb = mkCanvas(FW, FH);
        const fctx = fb.getContext('2d');
        const fbg = fctx.createLinearGradient(0, 0, FW, FH);
        fbg.addColorStop(0, '#fbfbf8');
        fbg.addColorStop(1, '#e2e2dc');
        fctx.fillStyle = fbg;
        fctx.fillRect(0, 0, FW, FH);
        fctx.fillStyle = '#1a1a1a';
        fctx.font = '34px "Microsoft YaHei", "PingFang SC", sans-serif';
        fctx.textBaseline = 'middle';
        fctx.fillText('绝对值', 24, FH / 2);
        const ftw = fctx.measureText('绝对值').width;
        const fTop = Math.round(FH / 2 - 16);
        const fH = 32;
        const fX = Math.round(24 + ftw + 14);
        const fGap = 6;
        // 笔画本体
        fctx.fillRect(fX, fTop, fl.w, fH);
        fctx.fillRect(fX + fl.w + fGap, fTop, fl.w, fH);
        // 起笔喇叭口（上端变宽）
        fctx.fillRect(fX - fl.ft, fTop, fl.w + fl.ft * 2, fl.ft);
        fctx.fillRect(fX + fl.w + fGap - fl.ft, fTop, fl.w + fl.ft * 2, fl.ft);
        // 收笔喇叭口（下端变宽）
        fctx.fillRect(fX - fl.fb, fTop + fH - fl.fb, fl.w + fl.fb * 2, fl.fb);
        fctx.fillRect(fX + fl.w + fGap - fl.fb, fTop + fH - fl.fb, fl.w + fl.fb * 2, fl.fb);

        // 相机：失焦 + 噪点（柔和边缘）
        const fphoto = mkCanvas(FW, FH);
        const fpctx = fphoto.getContext('2d');
        fpctx.filter = 'blur(0.7px)';
        fpctx.drawImage(fb, 0, 0);
        const fid = fpctx.getImageData(0, 0, FW, FH);
        for (let i = 0; i < fid.data.length; i += 4) {
          const n = (Math.random() - 0.5) * 14;
          fid.data[i] += n; fid.data[i + 1] += n; fid.data[i + 2] += n;
        }
        fpctx.putImageData(fid, 0, 0);

        const fclone = () => { const c = mkCanvas(FW, FH); c.getContext('2d').drawImage(fphoto, 0, 0); return c; };
        const fCon = fclone();
        window.__wb.applyWhiteboard(fCon, { contrast: 1.8, binarize: false });
        const fBin = fclone();
        window.__wb.applyWhiteboard(fBin, { contrast: 1.8, binarize: true });

        pushReal('flare_' + fl.tag + '_raw.png', fphoto, 'image/png');
        pushReal('flare_' + fl.tag + '_contrast.png', fCon, 'image/png');
        pushReal('flare_' + fl.tag + '_binarize.png', fBin, 'image/png');
        pushReal('flare_' + fl.tag + '_binarize_q92.jpg', fBin, 'image/jpeg', 0.92);
        pushReal('flare_' + fl.tag + '_raw_q92.jpg', fphoto, 'image/jpeg', 0.92);
      }

      return results;
    })()`);

    const profiles = {};
    for (const item of variants) {
      if (item.profile) {
        profiles[item.name] = item.profile;
        continue;
      }
      const buf = Buffer.from(String(item.dataUrl).split(',')[1], 'base64');
      fs.writeFileSync(path.join(outDir, item.name), buf);
    }

    fs.writeFileSync(path.join(outDir, 'profiles.json'), JSON.stringify(profiles, null, 2));
    console.log('[abtest] 图像已生成到', outDir);
    for (const [name, p] of Object.entries(profiles)) {
      console.log(
        '[abtest]', name,
        'raw(solid/broken)=', p.raw.solidRows + '/' + p.raw.brokenRows,
        'binary=', p.binary.solidRows + '/' + p.binary.brokenRows,
        'binHalf=', p.binHalf.solidRows + '/' + p.binHalf.brokenRows
      );
    }
    app.exit(0);
  } catch (err) {
    console.error('[abtest] 失败:', err);
    app.exit(1);
  }
}

/* --shapes：把 "||" 区域解码成 ASCII 像素画，量化"竖线两端长出横向帽"  */
/* ------------------------------------------------------------------ */

async function runShapeTest() {
  const outDir = path.join(app.getAppPath(), 'abtest');
  fs.mkdirSync(outDir, { recursive: true });

  try {
    await waitForDevReady();

    const results = await getMainWindow().webContents.executeJavaScript(`(async () => {
      const mk = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };

      const decode = (dataUrl) => new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          const c = mk(img.naturalWidth, img.naturalHeight);
          const cx = c.getContext('2d', { willReadFrequently: true });
          cx.drawImage(img, 0, 0);
          resolve(cx.getImageData(0, 0, c.width, c.height));
        };
        img.src = dataUrl;
      });

      const out = [];

      for (const w of [1, 2, 3, 5]) {
        const W = 460, H = 110;
        const base = mk(W, H);
        const ctx = base.getContext('2d');
        ctx.fillStyle = '#f2f2ee';
        ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = '#1c1c1c';
        ctx.font = '34px "Microsoft YaHei", "PingFang SC", sans-serif';
        ctx.textBaseline = 'middle';
        const label = '绝对值';
        ctx.fillText(label, 24, H / 2);
        const textW = ctx.measureText(label).width;
        const barTop = Math.round(H / 2 - 16);
        const barH = 32;
        const barX = Math.round(24 + textW + 14);
        const gap = 5;
        ctx.fillRect(barX, barTop, w, barH);
        ctx.fillRect(barX + w + gap, barTop, w, barH);

        // 轻微失焦 + 噪点，模拟相机拍摄
        const photo = mk(W, H);
        const pctx = photo.getContext('2d');
        pctx.filter = 'blur(0.5px)';
        pctx.drawImage(base, 0, 0);
        const id = pctx.getImageData(0, 0, W, H);
        for (let i = 0; i < id.data.length; i += 4) {
          const n = (Math.random() - 0.5) * 12;
          id.data[i] += n; id.data[i + 1] += n; id.data[i + 2] += n;
        }
        pctx.putImageData(id, 0, 0);

        const clone = () => { const c = mk(W, H); c.getContext('2d').drawImage(photo, 0, 0); return c; };

        const bin = clone();
        window.__wb.applyWhiteboard(bin, { contrast: 1.8, binarize: true });

        const stages = [
          { name: 'raw', url: photo.toDataURL('image/png') },
          { name: 'binarize', url: bin.toDataURL('image/png') },
          { name: 'binarize_jpeg92', url: bin.toDataURL('image/jpeg', 0.92) },
          { name: 'binarize_jpeg75', url: bin.toDataURL('image/jpeg', 0.75) },
          { name: 'binarize_jpeg60', url: bin.toDataURL('image/jpeg', 0.60) }
        ];

        for (const st of stages) {
          const img = await decode(st.url);
          const d = img.data;
          const at = (x, y) => {
            const i = (y * img.width + x) * 4;
            return 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
          };

          // ASCII 画：竖线区域（上下各留 3 行）
          const x0 = barX - 6;
          const x1 = barX + 2 * w + gap + 6;
          const y0 = barTop - 3;
          const y1 = barTop + barH + 3;
          const lines = [];
          for (let y = y0; y < y1; y += 1) {
            let s = '';
            for (let x = x0; x < x1; x += 1) {
              const g = at(x, y);
              s += g < 96 ? '#' : g < 160 ? '+' : '.';
            }
            lines.push(s);
          }

          // 量化：两竖线"夹缝"里的墨（= 方括号的内向横帽）
          let gapInk = 0;
          let capInk = 0;
          let haloInk = 0;
          for (let y = barTop; y < barTop + barH; y += 1) {
            for (let x = barX + w; x < barX + w + gap; x += 1) {
              if (at(x, y) < 128) gapInk += 1;
            }
          }
          // 竖线端点行上，向两侧伸出的墨
          for (const y of [barTop, barTop + 1, barTop + barH - 2, barTop + barH - 1]) {
            for (let x = barX - 5; x < barX; x += 1) if (at(x, y) < 128) capInk += 1;
            for (let x = barX + 2 * w + gap; x < barX + 2 * w + gap + 5; x += 1) if (at(x, y) < 128) capInk += 1;
          }
          // 竖线上方/下方的溢出墨（振铃）
          for (let y = barTop - 3; y < barTop; y += 1) {
            for (let x = barX; x < barX + w; x += 1) if (at(x, y) < 128) haloInk += 1;
          }
          for (let y = barTop + barH; y < barTop + barH + 3; y += 1) {
            for (let x = barX; x < barX + w; x += 1) if (at(x, y) < 128) haloInk += 1;
          }

          out.push({
            w,
            name: st.name,
            ascii: lines,
            gapInk,
            capInk,
            haloInk,
            png: st.url
          });
        }
      }
      return out;
    })()`);

    for (const r of results) {
      console.log('\\n===== 竖线宽度 ' + r.w + 'px · ' + r.name + ' =====');
      console.log('gapInk(夹缝墨)=' + r.gapInk + '  capInk(端点横帽)=' + r.capInk + '  haloInk(上下振铃)=' + r.haloInk);
      for (const line of r.ascii) console.log('   ' + line);
    }
    app.exit(0);
  } catch (err) {
    console.error('[shapes] 失败:', err);
    app.exit(1);
  }
}

/* ------------------------------------------------------------------ */
/* --audit <文件>：拿真实图片跑「白板管线各阶段」+ 本地 VLM 对照      */
/* ------------------------------------------------------------------ */

async function runAudit(filePath, comparePath) {
  const outDir = path.join(app.getAppPath(), 'abtest');
  fs.mkdirSync(outDir, { recursive: true });

  const toDataUrl = (p) => {
    const ext = path.extname(p).toLowerCase();
    const mime = ext === '.png' ? 'image/png'
      : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
      : ext === '.webp' ? 'image/webp' : 'image/bmp';
    return `data:${mime};base64,${fs.readFileSync(p).toString('base64')}`;
  };

  try {
    if (!fs.existsSync(filePath)) throw new Error('文件不存在: ' + filePath);
    await waitForDevReady();

    const buf = fs.readFileSync(filePath);
    const dataUrl = toDataUrl(filePath);
    const compareUrl = comparePath && fs.existsSync(comparePath) ? toDataUrl(comparePath) : null;

    const variants = await getMainWindow().webContents.executeJavaScript(`(async () => {
      const load = (url) => new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = url;
      });

      const img = await load(${JSON.stringify(dataUrl)});
      const W = img.naturalWidth;
      const H = img.naturalHeight;

      const mk = () => { const c = document.createElement('canvas'); c.width = W; c.height = H; return c; };
      const clone = () => { const c = mk(); c.getContext('2d').drawImage(img, 0, 0); return c; };

      const gray = clone();     window.__wb.applyWhiteboard(gray,     { contrast: 1,   binarize: false });
      const con18 = clone();    window.__wb.applyWhiteboard(con18,    { contrast: 1.8, binarize: false });
      const con32 = clone();    window.__wb.applyWhiteboard(con32,    { contrast: 3.2, binarize: false });
      const bin = clone();      window.__wb.applyWhiteboard(bin,      { contrast: 1.8, binarize: true });
      const binSoft = clone();  window.__wb.applyWhiteboard(binSoft,  { contrast: 1.8, binarize: true, softEdge: true });

      const halfOf = (src) => {
        const c = document.createElement('canvas');
        c.width = Math.round(src.width / 2); c.height = Math.round(src.height / 2);
        const cx = c.getContext('2d');
        cx.imageSmoothingEnabled = true;
        cx.drawImage(src, 0, 0, c.width, c.height);
        return c;
      };

      const scaleOf = (src, k) => {
        const c = document.createElement('canvas');
        c.width = Math.round(src.width * k); c.height = Math.round(src.height * k);
        const cx = c.getContext('2d');
        cx.imageSmoothingEnabled = true;
        cx.imageSmoothingQuality = 'high';
        cx.drawImage(src, 0, 0, c.width, c.height);
        return c;
      };

      const raw = clone();
      const items = [
        { name: 'raw.png',        url: raw.toDataURL('image/png') },
        { name: 'raw_q92.jpg',    url: raw.toDataURL('image/jpeg', 0.92) },
        { name: 'gray.png',       url: gray.toDataURL('image/png') },
        { name: 'contrast18.png', url: con18.toDataURL('image/png') },
        { name: 'contrast32.png', url: con32.toDataURL('image/png') },
        { name: 'binarize.png',   url: bin.toDataURL('image/png') },
        { name: 'binarize_q92.jpg', url: bin.toDataURL('image/jpeg', 0.92) },
        { name: 'binarize_soft.png', url: binSoft.toDataURL('image/png') },
        { name: 'raw_x50.png',    url: halfOf(raw).toDataURL('image/png') },
        { name: 'binarize_x50.png', url: halfOf(bin).toDataURL('image/png') },
        { name: 'raw_x2.png',     url: scaleOf(raw, 2).toDataURL('image/png') },
        { name: 'contrast18_x2.png', url: scaleOf(con18, 2).toDataURL('image/png') },
        { name: 'contrast18_x3.png', url: scaleOf(con18, 3).toDataURL('image/png') },
        { name: 'binarize_x2.png', url: scaleOf(bin, 2).toDataURL('image/png') },
        { name: 'contrast14.png', url: (() => { const c = clone(); window.__wb.applyWhiteboard(c, { contrast: 1.4, binarize: false }); return c.toDataURL('image/png'); })() },
        { name: 'contrast16.png', url: (() => { const c = clone(); window.__wb.applyWhiteboard(c, { contrast: 1.6, binarize: false }); return c.toDataURL('image/png'); })() },
        { name: 'contrast16_q92.jpg', url: (() => { const c = clone(); window.__wb.applyWhiteboard(c, { contrast: 1.6, binarize: false }); return c.toDataURL('image/jpeg', 0.92); })() },
        { name: 'contrast16_x2.png', url: scaleOf((() => { const c = clone(); window.__wb.applyWhiteboard(c, { contrast: 1.6, binarize: false }); return c; })(), 2).toDataURL('image/png') },
        { name: 'contrast16_x2_q92.jpg', url: scaleOf((() => { const c = clone(); window.__wb.applyWhiteboard(c, { contrast: 1.6, binarize: false }); return c; })(), 2).toDataURL('image/jpeg', 0.92) },
        { name: 'raw_x2_q92.jpg', url: scaleOf(raw, 2).toDataURL('image/jpeg', 0.92) },
        { name: 'contrast18_soft.png', url: (() => { const c = clone(); window.__wb.applyWhiteboard(c, { contrast: 1.8, binarize: true, softEdge: true }); return c.toDataURL('image/png'); })() },
        // ---- 应用**实际**的处理顺序：先放大 → 再白板化 → 再 JPEG ----
        // cropperToDataUrl() 里的顺序是 upscale → applyWhiteboard → toDataURL，
        // 与上面「先对比度后放大」的变体不是一回事，必须单独验证。
        { name: 'apporder_x2.png', url: (() => { const c = scaleOf(raw, 2); window.__wb.applyWhiteboard(c, { contrast: 1.6, binarize: false }); return c.toDataURL('image/png'); })() },
        { name: 'apporder_x2_q92.jpg', url: (() => { const c = scaleOf(raw, 2); window.__wb.applyWhiteboard(c, { contrast: 1.6, binarize: false }); return c.toDataURL('image/jpeg', 0.92); })() }
      ];
      // 对照组：程序实际产出的那张（白板图）
      const cmpUrl = ${compareUrl ? JSON.stringify(compareUrl) : 'null'};
      let cmpSize = '';
      if (cmpUrl) {
        const cmpImg = await load(cmpUrl);
        cmpSize = cmpImg.naturalWidth + 'x' + cmpImg.naturalHeight;
        const cmk = () => { const c = document.createElement('canvas'); c.width = cmpImg.naturalWidth; c.height = cmpImg.naturalHeight; return c; };
        const cclone = () => { const c = cmk(); c.getContext('2d').drawImage(cmpImg, 0, 0); return c; };
        const cAsis = cclone();
        const cSoft = cclone();
        window.__wb.applyWhiteboard(cSoft, { contrast: 1.8, binarize: true, softEdge: true });
        items.push({ name: 'compare_asis.png', url: cAsis.toDataURL('image/png') });
        items.push({ name: 'compare_x2.png',   url: scaleOf(cAsis, 2).toDataURL('image/png') });
        items.push({ name: 'compare_soft.png',  url: cSoft.toDataURL('image/png') });
      }

      return { size: W + 'x' + H, cmpSize, items };
    })()`);

    console.log('[audit] 原图:', filePath, '尺寸', variants.size);
    if (comparePath) console.log('[audit] 对照(程序实际产出):', comparePath, '尺寸', variants.cmpSize);

    const PROMPTS = [
      '请准确读出图片中的文字，只输出文字本身，不要解释、不要标点。',
      '请准确转写图片中的数学符号与公式，只输出转写结果本身，不要解释。'
    ];

    const endpoint = process.env.VLM_ENDPOINT || 'http://127.0.0.1:8080';

    for (const item of variants.items) {
      const out = path.join(outDir, 'audit_' + item.name);
      fs.writeFileSync(out, Buffer.from(String(item.url).split(',')[1], 'base64'));
      const row = [];
      for (const prompt of PROMPTS) {
        let text = '[ERR]';
        try {
          const res = await fetch(`${endpoint}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            // 本地推理偶尔会卡住，没有超时会一直挂着
            signal: AbortSignal.timeout(120000),
            body: JSON.stringify({
              model: 'local',
              temperature: 0,
              max_tokens: 96,
              messages: [{
                role: 'user',
                content: [
                  { type: 'text', text: prompt },
                  { type: 'image_url', image_url: { url: item.url } }
                ]
              }]
            })
          });
          if (!res.ok) throw new Error(res.status + ' ' + (await res.text()));
          const json = await res.json();
          text = (json.choices?.[0]?.message?.content || '').trim();
        } catch (e) {
          text = '[ERR] ' + e.message;
        }
        row.push(text);
      }
      console.log('[audit] ' + item.name.padEnd(20) + ' | ' + row[0] + '  ||  ' + row[1]);
    }
    console.log('[audit] 变体图已写入', outDir);
    app.exit(0);
  } catch (err) {
    console.error('[audit] 失败:', err);
    app.exit(1);
  }
}

/* ------------------------------------------------------------------ */
/* --smoke 自检：无需人工介入，跑一遍「渲染 → cropper → 保存」全链路   */
/* ------------------------------------------------------------------ */

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 等开发探针契约（app.js 末尾的 window.__wb）+ 页面加载完成。
 * 替代固定 delay：慢机/冷启动时脚本可能尚未执行到导出点，固定等待会偶发失败。
 *
 * requireCamera=true（仅 --smoke）时再等一帧视频就绪；摄像头不可用时
 * 只告警不中断 —— smoke 自己会报告 camStatus，是否可用由各探针判定。
 */
async function waitForDevReady({ requireCamera = false, timeoutMs = 15000 } = {}) {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    let ready = false;
    try {
      ready = !!(await getMainWindow().webContents.executeJavaScript(
        '!!window.__wb && document.readyState === "complete"'
      ));
      if (ready && requireCamera) {
        ready = !!(await getMainWindow().webContents.executeJavaScript(
          '!!document.querySelector("#video") && document.querySelector("#video").readyState >= 2'
        ));
      }
    } catch {
      // 页面导航/重载中，下一轮再试
    }
    if (ready) return;

    if (Date.now() >= deadline) {
      if (requireCamera) {
        console.warn('[dev] 等待摄像头首帧超时，继续跑探针（smoke 会报告实际状态）');
        return;
      }
      throw new Error('开发探针等待 window.__wb 就绪超时');
    }
    await delay(200);
  }
}

async function runSmokeTest() {
  // 与其它开发工具保持一致：产物统一落在 app 目录下，
  // 不再取决于启动时的工作目录（从不同目录启动会散落得到处都是 smoke/）。
  const outDir = path.join(app.getAppPath(), 'smoke');
  const shotDir = path.join(outDir, 'shots');
  fs.mkdirSync(shotDir, { recursive: true });

  try {
    await waitForDevReady({ requireCamera: true });

    const probe = await getMainWindow().webContents.executeJavaScript(`(async () => {
      const v = document.querySelector('#video');
      const q = (s) => document.querySelector(s);
      const rect = v ? v.getBoundingClientRect() : null;
      const stage = q('#previewStage');
      const stageRect = stage ? stage.getBoundingClientRect() : null;

      // 采样一帧，算平均亮度：区分「没有帧」和「帧是黑的」
      let frame = null;
      try {
        const c = document.createElement('canvas');
        c.width = 64; c.height = 36;
        const ctx = c.getContext('2d');
        ctx.drawImage(v, 0, 0, 64, 36);
        const d = ctx.getImageData(0, 0, 64, 36).data;
        let sum = 0;
        for (let i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] + d[i + 2];
        frame = { avgBrightness: Math.round(sum / ((d.length / 4) * 3)) };
      } catch (err) {
        frame = { error: err.message };
      }

      // 视频中心点上最顶层的元素：确认没被别的层挡住
      let topmost = null;
      if (rect && rect.width > 0) {
        const el = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        topmost = el ? (el.tagName + (el.id ? '#' + el.id : '') + (el.className ? '.' + String(el.className).split(' ').join('.') : '')) : null;
      }

      return {
        cropperLoaded: typeof Cropper !== 'undefined',
        camStatus: q('#camStatus') ? q('#camStatus').textContent : null,
        statusText: q('#statusText') ? q('#statusText').textContent : null,
        deviceCount: q('#deviceSelect') ? q('#deviceSelect').options.length : 0,
        videoSize: v ? [v.videoWidth, v.videoHeight] : null,
        videoReadyState: v ? v.readyState : null,
        videoPaused: v ? v.paused : null,
        videoStyle: v ? v.getAttribute('style') : null,
        videoRect: rect ? { x: rect.x, y: rect.y, w: rect.width, h: rect.height } : null,
        stageRect: stageRect ? { x: stageRect.x, y: stageRect.y, w: stageRect.width, h: stageRect.height } : null,
        rotTransform: q('#previewRot') ? q('#previewRot').style.transform : null,
        placeholderShown: q('#previewPlaceholder') ? q('#previewPlaceholder').style.display : null,
        outputDir: q('#outputDir') ? q('#outputDir').textContent : null,
        workspace: (() => {
          const preview = q('#previewPane');
          const edit = q('#editPane');
          return {
            mode: window.__wb.getWorkspaceMode(),
            editing: q('#panes').classList.contains('editing'),
            previewWidth: preview ? Math.round(preview.getBoundingClientRect().width) : 0,
            editWidth: edit ? Math.round(edit.getBoundingClientRect().width) : 0
          };
        })(),
        toast: (q('#toast') && !q('#toast').hidden) ? q('#toast').textContent : null,
        topmost,
        frame
      };
    })()`);

    console.log('[smoke] 初始状态:', JSON.stringify(probe));

    // 合成一张测试图 -> 走 cropperjs -> 保存到 smoke/shots，验证裁剪与落盘链路
    const saveResult = await getMainWindow().webContents.executeJavaScript(`(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 800; canvas.height = 600;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#1e88e5'; ctx.fillRect(0, 0, 800, 600);
      ctx.fillStyle = '#ffca28'; ctx.fillRect(100, 100, 300, 200);
      ctx.fillStyle = '#ffffff';
      ctx.font = '48px sans-serif';
      ctx.fillText('SMOKE', 250, 430);

      await window.__wb.loadImageIntoCropper(canvas.toDataURL('image/png'), NaN);
      const cropped = await window.__wb.cropperToDataUrl();
      // 用「输出目录覆盖」把产物写进 smoke/shots，
      // 而不是 patchSettings 改写用户的 outputDir（那会污染真实的 settings.json）
      const res = await api.saveImage({
        dataUrl: cropped.dataUrl,
        format: cropped.format,
        filenameTemplate: '{prefix}_{timestamp}',
        prefix: 'smoke',
        counter: 1,
        outputDir: ${JSON.stringify(shotDir)}
      });
      return res;
    })()`);

    console.log('[smoke] 保存结果:', JSON.stringify(saveResult));

    // Ctrl + 拖动平移验证：按住 Ctrl 把背景图拖动，检查画布位移
    const panResult = await getMainWindow().webContents.executeJavaScript(`(async () => {
      const cropper = window.__wb.getCropper();
      if (!cropper) return { skipped: 'no cropper' };
      cropper.zoom(0.8);                       // 先放大，制造"超出窗口"
      await new Promise((r) => setTimeout(r, 400));
      const before = cropper.getCanvasData();
      const box = cropper.dragBox;
      const rect = box.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const diag = [];
      const snap = (step) => diag.push({
        step,
        action: cropper.action,
        dragMode: cropper.options.dragMode,
        left: cropper.canvasData.left,
        top: cropper.canvasData.top,
        pointers: JSON.stringify(cropper.pointers),
        badge: document.querySelector('#modeBadge') ? document.querySelector('#modeBadge').textContent : null
      });

      snap('pre');
      // 按下 Ctrl（模拟用户按住 Ctrl 键）
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control', ctrlKey: true, bubbles: true }));
      await new Promise((r) => setTimeout(r, 80));
      snap('after-ctrl-down');

      box.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true,
        clientX: x, clientY: y, button: 0, buttons: 1, ctrlKey: true
      }));
      snap('after-ctrl-drag-down');
      document.dispatchEvent(new PointerEvent('pointermove', {
        bubbles: true, pointerId: 1, pointerType: 'mouse', isPrimary: true,
        clientX: x + 80, clientY: y + 50, button: 0, buttons: 1, ctrlKey: true
      }));
      snap('after-move');
      document.dispatchEvent(new PointerEvent('pointerup', {
        bubbles: true, pointerId: 1, pointerType: 'mouse', isPrimary: true,
        clientX: x + 80, clientY: y + 50, button: 0, buttons: 0, ctrlKey: true
      }));
      snap('after-up');

      // 松开 Ctrl
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Control', ctrlKey: false, bubbles: true }));
      await new Promise((r) => setTimeout(r, 200));

      const after = cropper.getCanvasData();
      const badge = document.querySelector('#modeBadge');
      return {
        diag,
        dragMode: cropper.options.dragMode,
        badgeAfterRelease: badge ? badge.textContent : null,
        before: { left: before.left, top: before.top },
        after: { left: after.left, top: after.top },
        moved: Math.abs(after.left - before.left) > 1 || Math.abs(after.top - before.top) > 1
      };
    })()`);

    console.log('[smoke] Ctrl 拖动结果:', JSON.stringify(panResult));

    // 裁剪框拉满后的交互探针：哪些手势还可用
    const boxProbe = await getMainWindow().webContents.executeJavaScript(`(async () => {
      const cropper = window.__wb.getCropper();
      if (!cropper) return { skipped: 'no cropper' };
      const container = cropper.container;
      const rect = container.getBoundingClientRect();
      const PE = (type, target, x, y, extra) => target.dispatchEvent(new PointerEvent(type, Object.assign({
        bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true,
        clientX: x, clientY: y, button: 0, buttons: 1
      }, extra || {})));

      // 把裁剪框拉到最大
      cropper.setCropBoxData({ left: 0, top: 0, width: rect.width, height: rect.height });
      await new Promise((r) => setTimeout(r, 200));
      const maximized = cropper.getCropBoxData();
      const faceAction = cropper.face.getAttribute('data-cropper-action');
      const dragBoxAction = cropper.dragBox.getAttribute('data-cropper-action');

      const out = { maximized, faceAction, dragBoxAction, tests: {} };

      // 测试 1：拖右侧控制点向左（缩小裁剪框）
      const east = cropper.cropBox.querySelector('.cropper-point.point-e');
      if (east) {
        const r = east.getBoundingClientRect();
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        PE('pointerdown', east, x, y);
        PE('pointermove', document, x - 60, y);
        PE('pointerup', document, x - 60, y, { buttons: 0 });
        await new Promise((r2) => setTimeout(r2, 150));
        out.tests.handleShrink = {
          widthBefore: maximized.width,
          widthAfter: cropper.getCropBoxData().width,
          worked: cropper.getCropBoxData().width < maximized.width - 1
        };
      }

      // 测试 2：在裁剪框内部（face）左键拖动
      const f = cropper.face.getBoundingClientRect();
      const fx = f.left + f.width / 2;
      const fy = f.top + f.height / 2;
      const canvasBefore = cropper.getCanvasData();
      PE('pointerdown', cropper.face, fx, fy);
      PE('pointermove', document, fx - 40, fy - 30);
      PE('pointerup', document, fx - 40, fy - 30, { buttons: 0 });
      await new Promise((r2) => setTimeout(r2, 150));
      const canvasAfter = cropper.getCanvasData();
      out.tests.faceDrag = {
        action: cropper.action,
        cropBoxMoved: Math.abs(cropper.getCropBoxData().left - maximized.left) > 1,
        canvasMoved: Math.abs(canvasAfter.left - canvasBefore.left) > 1
      };

      // 测试 3：在裁剪框外部（drag-box 空白处）左键拖动新建选区
      const cb = cropper.getCropBoxData();
      const ox = rect.left + 4;
      const oy = rect.top + 4;
      PE('pointerdown', cropper.dragBox, ox, oy);
      PE('pointermove', document, ox + 120, oy + 80);
      PE('pointerup', document, ox + 120, oy + 80, { buttons: 0 });
      await new Promise((r2) => setTimeout(r2, 150));
      out.tests.outsideDrag = {
        cropBoxBefore: { left: cb.left, top: cb.top, width: cb.width, height: cb.height },
        cropBoxAfter: cropper.getCropBoxData(),
        createdNewBox: Math.abs(cropper.getCropBoxData().width - cb.width) > 5
      };

      return out;
    })()`);

    console.log('[smoke] 裁剪框探针:', JSON.stringify(boxProbe));

    // 截取模式验证：不按 Ctrl 时，左键拖拽应画出新选区
    const selectProbe = await getMainWindow().webContents.executeJavaScript(`(async () => {
      const cropper = window.__wb.getCropper();
      if (!cropper) return { skipped: 'no cropper' };
      const PE = (type, target, x, y, buttons) => target.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true,
        clientX: x, clientY: y, button: 0, buttons: buttons === undefined ? 1 : buttons
      }));

      // 先把选区拉满，模拟用户的卡死状态
      const rect = cropper.container.getBoundingClientRect();
      cropper.setCropBoxData({ left: 0, top: 0, width: rect.width, height: rect.height });
      await new Promise((r) => setTimeout(r, 150));
      const full = cropper.getCropBoxData();

      // 不按 Ctrl，直接左键拖拽 → 应画出新选区
      const x0 = rect.left + 50;
      const y0 = rect.top + 30;
      const x1 = x0 + 220;
      const y1 = y0 + 130;
      PE('pointerdown', cropper.container, x0, y0);
      PE('pointermove', cropper.container, x1, y1);
      PE('pointerup', window, x1, y1, 0);
      await new Promise((r) => setTimeout(r, 200));

      const box = cropper.getCropBoxData();
      const badge = document.querySelector('#modeBadge');
      return {
        fullBox: { left: full.left, top: full.top, width: full.width, height: full.height },
        newBox: { left: box.left, top: box.top, width: box.width, height: box.height },
        badge: badge ? badge.textContent : null,
        ok: box.width > 100 && box.height > 60
      };
    })()`);

    console.log('[smoke] 框选结果:', JSON.stringify(selectProbe));
    const selectOk = !!(selectProbe && selectProbe.ok);

    // 回归探针：Ctrl 拖动画面之后，再左键框选，裁剪框必须与鼠标对齐
    const panSelectProbe = await getMainWindow().webContents.executeJavaScript(`(async () => {
      const cropper = window.__wb.getCropper();
      if (!cropper) return { skipped: 'no cropper' };
      const PE = (type, target, x, y, buttons, extra) => target.dispatchEvent(new PointerEvent(type, Object.assign({
        bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true,
        clientX: x, clientY: y, button: 0, buttons: buttons === undefined ? 1 : buttons
      }, extra || {})));

      cropper.reset();
      await new Promise((r) => setTimeout(r, 250));
      cropper.zoom(0.7);
      await new Promise((r) => setTimeout(r, 450));
      const rect = cropper.container.getBoundingClientRect();

      // 1) 按住 Ctrl 把画面往右拖（图片右侧移出容器，左侧留出空白）
      const px = rect.left + rect.width / 2;
      const py = rect.top + rect.height / 2;
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control', ctrlKey: true, bubbles: true }));
      PE('pointerdown', cropper.dragBox, px, py, 1, { ctrlKey: true });
      PE('pointermove', document, px + 150, py, 1, { ctrlKey: true });
      PE('pointerup', document, px + 150, py, 0, { ctrlKey: true });
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Control', ctrlKey: false, bubbles: true }));
      await new Promise((r) => setTimeout(r, 300));

      const canvas = cropper.getCanvasData();

      // 2) 松开 Ctrl 后，普通左键拖出一个新选区
      //    A) 起点落在图片上（常见操作）
      // 平移后 canvas.left 可能为负（图片左侧移出容器），起点必须夹在容器内，
      // 否则 PointerEvent 会落在容器外被 clamp，误报「选区不跟手」。
      const ax0 = Math.max(canvas.left + 20, 20);
      const ay0 = Math.max(canvas.top + 20, 20);
      const ax1 = ax0 + 200;
      const ay1 = ay0 + 140;
      PE('pointerdown', cropper.container, rect.left + ax0, rect.top + ay0);
      PE('pointermove', cropper.container, rect.left + ax1, rect.top + ay1);
      const duringA = cropper.getCropBoxData();
      PE('pointerup', window, rect.left + ax1, rect.top + ay1, 0);
      await new Promise((r) => setTimeout(r, 250));
      const afterA = cropper.getCropBoxData();

      //    B) 起点落在图片外的空白区（拖动后容器左侧会空出来）
      const bx0 = 20;
      const by0 = 20;
      const bx1 = 240;
      const by1 = 180;
      PE('pointerdown', cropper.container, rect.left + bx0, rect.top + by0);
      PE('pointermove', cropper.container, rect.left + bx1, rect.top + by1);
      const duringB = cropper.getCropBoxData();
      PE('pointerup', window, rect.left + bx1, rect.top + by1, 0);
      await new Promise((r) => setTimeout(r, 250));
      const afterB = cropper.getCropBoxData();

      const near = (a, b, tol) => Math.abs(a - b) <= tol;
      const offA = {
        left: Math.round((duringA.left - ax0) * 10) / 10,
        top: Math.round((duringA.top - ay0) * 10) / 10,
        width: Math.round((duringA.width - (ax1 - ax0)) * 10) / 10,
        height: Math.round((duringA.height - (ay1 - ay0)) * 10) / 10
      };
      const offB = {
        left: Math.round((duringB.left - bx0) * 10) / 10,
        top: Math.round((duringB.top - by0) * 10) / 10,
        width: Math.round((duringB.width - (bx1 - bx0)) * 10) / 10,
        height: Math.round((duringB.height - (by1 - by0)) * 10) / 10
      };

      // 收敛后必须落在画面可见区域内
      const visX0 = Math.max(0, canvas.left);
      const visX1 = Math.min(rect.width, canvas.left + canvas.width);
      const visY0 = Math.max(0, canvas.top);
      const visY1 = Math.min(rect.height, canvas.top + canvas.height);
      const inView = (b) =>
        b.left >= visX0 - 1 && b.top >= visY0 - 1 &&
        b.left + b.width <= visX1 + 1 && b.top + b.height <= visY1 + 1;

      return {
        container: { width: rect.width, height: rect.height },
        canvas: { left: canvas.left, top: canvas.top, width: canvas.width, height: canvas.height },
        visible: { x0: visX0, y0: visY0, x1: visX1, y1: visY1 },
        caseA: { during: duringA, after: afterA, offsetDuringDrag: offA },
        caseB: { during: duringB, after: afterB, offsetDuringDrag: offB },
        // 拖动过程中框必须严格跟随鼠标（两个用例都是）
        followOk: near(offA.left, 0, 1) && near(offA.top, 0, 1) && near(offA.width, 0, 1) && near(offA.height, 0, 1)
          && near(offB.left, 0, 1) && near(offB.top, 0, 1) && near(offB.width, 0, 1) && near(offB.height, 0, 1),
        // 松手后选区必须落在画面内
        inViewOk: inView(afterA) && inView(afterB)
      };
    })()`);

    console.log('[smoke] 拖动后框选:', JSON.stringify(panSelectProbe));
    const panSelectOk = !!(panSelectProbe && panSelectProbe.followOk && panSelectProbe.inViewOk);

    // 模式徽标点击切换：固定模式可点击切换/切回，Ctrl 临时反向后回到固定模式
    const modeToggleProbe = await getMainWindow().webContents.executeJavaScript(`(async () => {
      const badge = document.querySelector('#modeBadge');
      const text = () => badge.textContent;
      const dragMode = () => window.__wb.getCropper() ? window.__wb.getCropper().options.dragMode : null;
      const key = (type, down) => window.dispatchEvent(new KeyboardEvent(type, {
        key: 'Control', ctrlKey: down, bubbles: true
      }));
      const click = () => badge.click();
      const out = {};

      // 先复位到固定截取
      if (text().indexOf('拖动') >= 0) click();
      out.baseSelect = text().indexOf('截取') >= 0 && dragMode() === 'crop';

      click(); // → 固定拖动
      out.clickedPan = text().indexOf('拖动') >= 0 && dragMode() === 'move';

      key('keydown', true); // 固定 pan 下 Ctrl 临时反向 → 截取
      out.ctrlFromPan = text().indexOf('截取') >= 0 && dragMode() === 'crop';
      key('keyup', false);  // 松开回到固定 pan
      out.ctrlBackToPan = text().indexOf('拖动') >= 0 && dragMode() === 'move';

      click(); // → 固定截取
      out.clickedBackSelect = text().indexOf('截取') >= 0 && dragMode() === 'crop';

      key('keydown', true); // 固定 select 下 Ctrl 临时 → 拖动
      out.ctrlFromSelect = text().indexOf('拖动') >= 0 && dragMode() === 'move';
      key('keyup', false);
      out.ctrlBackToSelect = text().indexOf('截取') >= 0 && dragMode() === 'crop';

      // 回归：固定拖动模式下载入新图（截图/导入图片），固定模式须复位到截取，
      // 且徽标显示与实际模式一致（旧 bug：徽标显示截取但 state 仍是 pan）
      click(); // → 固定拖动
      const modeBeforeLoad = window.__wb.getInteractionMode();
      const c = document.createElement('canvas');
      c.width = 200; c.height = 120;
      const cx = c.getContext('2d');
      cx.fillStyle = '#3a7bd5'; cx.fillRect(0, 0, 200, 120);
      cx.fillStyle = '#fff'; cx.fillRect(20, 20, 60, 40);
      await window.__wb.loadImageIntoCropper(c.toDataURL('image/png'), NaN);
      out.reloadWasPan = modeBeforeLoad === 'pan';
      out.reloadResetMode = window.__wb.getInteractionMode() === 'select';
      out.reloadBadgeMatch = text().indexOf('截取') >= 0 && dragMode() === 'crop';

      return out;
    })()`);
    const modeToggleOk = !!(modeToggleProbe && Object.values(modeToggleProbe).every(Boolean));
    console.log('[smoke] 模式点击切换:', JSON.stringify({ ...modeToggleProbe, modeToggleOk }));

    // 白板模式验证：灰度化 + 对比度增强 + 二值化
    const whiteboardProbe = await getMainWindow().webContents.executeJavaScript(`(async () => {
      const stats = (canvas) => {
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let sum = 0;
        let sum2 = 0;
        let n = d.length / 4;
        let colored = 0;
        let binary = 0;
        for (let i = 0; i < d.length; i += 4) {
          const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
          sum += g;
          sum2 += g * g;
          if (d[i] !== d[i + 1] || d[i + 1] !== d[i + 2]) colored += 1;
          if (d[i] === 0 || d[i] === 255) binary += 1;
        }
        const mean = sum / n;
        return {
          mean: Math.round(mean),
          std: Math.round(Math.sqrt(Math.max(sum2 / n - mean * mean, 0))),
          coloredPixels: colored,
          binaryPixels: binary,
          total: n
        };
      };

      // 造一张有彩色、有明暗差异的测试图
      const src = document.createElement('canvas');
      src.width = 400; src.height = 300;
      const sctx = src.getContext('2d');
      const grad = sctx.createLinearGradient(0, 0, 400, 300);
      grad.addColorStop(0, '#3a7bd5');
      grad.addColorStop(1, '#f5f5f5');
      sctx.fillStyle = grad;
      sctx.fillRect(0, 0, 400, 300);
      sctx.fillStyle = '#ffcc00';
      sctx.fillRect(60, 60, 200, 120);
      sctx.fillStyle = '#202020';
      sctx.fillRect(120, 200, 160, 50);

      await window.__wb.loadImageIntoCropper(src.toDataURL('image/png'), NaN);
      const cropper = window.__wb.getCropper();   // 必须在换图之后再取实例
      const initialBox = cropper.getCropBoxData();   // 初始选区（autoCropArea）
      const original = cropper.getCroppedCanvas();
      const before = stats(original);

      const enhanced = cropper.getCroppedCanvas();
      window.__wb.applyWhiteboard(enhanced, { contrast: 2.0, binarize: false });
      const afterEnhance = stats(enhanced);

      const binary = cropper.getCroppedCanvas();
      window.__wb.applyWhiteboard(binary, { contrast: 1.0, binarize: true });
      const afterBinarize = stats(binary);

      return {
        initialBox: { left: initialBox.left, top: initialBox.top, width: initialBox.width, height: initialBox.height },
        croppedSize: { width: original.width, height: original.height },
        before,
        afterEnhance,
        afterBinarize,
        grayscaleOk: afterEnhance.coloredPixels === 0,
        contrastUp: afterEnhance.std > before.std,
        binaryOk: afterBinarize.binaryPixels === afterBinarize.total,
        // 二值化后必须还留有黑色内容，否则说明阈值把笔画抹掉了
        binaryKeptInk: afterBinarize.mean < 250
      };
    })()`);

    console.log('[smoke] 白板模式结果:', JSON.stringify(whiteboardProbe));
    const whiteboardOk = !!(whiteboardProbe
      && whiteboardProbe.grayscaleOk
      && whiteboardProbe.contrastUp
      && whiteboardProbe.binaryOk
      && whiteboardProbe.binaryKeptInk);

    // 回归探针：同一张图（完全相同的 dataURL）连续载入两次都必须建出 cropper。
    // 浏览器对「相同的 src 赋值」不会再触发 load 事件 —— 摄像头静止时连续拍照
    // 必然命中这个 case，表现为拍第二张就没法裁剪。
    const reloadProbe = await getMainWindow().webContents.executeJavaScript(`(async () => {
      const c = document.createElement('canvas');
      c.width = 320; c.height = 240;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 320, 240);
      ctx.fillStyle = '#101010'; ctx.fillRect(40, 40, 120, 90);
      const url = c.toDataURL('image/png');   // 两次用的是同一个字符串

      await window.__wb.loadImageIntoCropper(url, NaN);
      const firstCropper = window.__wb.getCropper();
      const firstCanvas = firstCropper ? firstCropper.getCroppedCanvas() : null;

      await window.__wb.loadImageIntoCropper(url, NaN);   // 关键：相同 dataURL 再来一次
      const secondCropper = window.__wb.getCropper();
      const secondCanvas = secondCropper ? secondCropper.getCroppedCanvas() : null;

      return {
        firstOk: !!firstCropper && !!firstCanvas && firstCanvas.width > 0,
        secondOk: !!secondCropper && !!secondCanvas && secondCanvas.width > 0,
        urlLength: url.length
      };
    })()`);

    console.log('[smoke] 同图重载结果:', JSON.stringify(reloadProbe));
    const reloadOk = !!(reloadProbe && reloadProbe.firstOk && reloadProbe.secondOk);

    // 回归探针：设置写回必须以**主进程的权威值**为准。
    // 主进程会把 exportScale:'2' 规范化成数字 2，渲染层必须跟着回写，
    // 否则 state.settings 与 settings.json 会长期漂移。
    const settingsProbe = await getMainWindow().webContents.executeJavaScript(`(async () => {
      const before = window.__wb.getSettings().exportScale;
      try {
        await window.__wb.patchSettings({ exportScale: '2' });
        const after = window.__wb.getSettings().exportScale;
        return {
          before,
          after,
          // 主进程规范化后的权威值应当回写到渲染层
          normalized: after === 2 || after === '2',
          isNumber: typeof after === 'number'
        };
      } finally {
        await window.__wb.patchSettings({ exportScale: before });
      }
    })()`);

    console.log('[smoke] 设置回写结果:', JSON.stringify(settingsProbe));
    const settingsOk = !!(settingsProbe && settingsProbe.normalized);

    // 回归探针：主进程**拒绝**的值不能进入渲染层状态，且必须返回 rejected 列表。
    // 保存设置已迁到独立窗口，界面回滚由设置页自己的探针验证。
    const rejectProbe = await getMainWindow().webContents.executeJavaScript(`(async () => {
      const before = window.__wb.getSettings().prefix;
      const tooLong = 'x'.repeat(200);   // 超过 60 字符上限，主进程必定拒绝
      try {
        const res = await window.api.patchSettings({ prefix: tooLong });
        const after = window.__wb.getSettings().prefix;
        return {
          stateKeptOld: after === before,
          rejected: !!(res && Array.isArray(res.rejected) && res.rejected.indexOf('prefix') >= 0)
        };
      } finally {
        await window.api.patchSettings({ prefix: before });
      }
    })()`);

    console.log('[smoke] 拒绝校验结果:', JSON.stringify(rejectProbe));
    const rejectOk = !!(rejectProbe && rejectProbe.stateKeptOld && rejectProbe.rejected);

    // 回归探针：UI 统计从渲染层 send 到主进程，并落到本地两个文件
    const usageProbe = await getMainWindow().webContents.executeJavaScript(`(async () => {
      const getCount = async () => {
        const u = await window.api.getUiUsage();
        return (u.items.probeUsage && u.items.probeUsage.count) || 0;
      };
      const before = await getCount();
      window.api.trackButton('probeUsage');
      let after = before;
      for (let i = 0; i < 20 && after === before; i += 1) {
        await new Promise((r) => setTimeout(r, 100));
        after = await getCount();
      }
      return { before, after, bumped: after === before + 1 };
    })()`);
    flushUsage();
    const usageFilesOk = fs.existsSync(usageFile()) && fs.existsSync(usageLogFile());
    const usageOk = !!(usageProbe && usageProbe.bumped && usageFilesOk);
    console.log('[smoke] UI 统计结果:', JSON.stringify({ ...usageProbe, usageFilesOk }));

    const savedFile = saveResult && saveResult.path;
    const fileOk = !!(savedFile && fs.existsSync(savedFile) && fs.statSync(savedFile).size > 0);
    const panOk = !!(panResult && panResult.moved);

    const img = await getMainWindow().webContents.capturePage();
    const shotPath = path.join(outDir, 'screenshot.png');
    fs.writeFileSync(shotPath, img.toPNG());

    // 回归探针：独立设置窗口能打开，控件齐全，且被拒绝的值会从控件回滚
    const settingsWindowProbe = await (async () => {
      try {
        const opened = await getMainWindow().webContents.executeJavaScript(`window.api.openSettings()`);
        const win = BrowserWindow.getAllWindows().find((w) => w !== getMainWindow() && !w.isDestroyed());
        if (!opened || !opened.ok || !win) return { ok: false, reason: '窗口未创建' };
        if (win.webContents.isLoading()) {
          await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
        }
        const result = await win.webContents.executeJavaScript(`(async () => {
          const input = document.querySelector('#prefixInput');
          if (!input) return { ok: false, reason: '缺少 prefixInput' };
          for (let i = 0; i < 30 && !input.value; i += 1) {
            await new Promise((r) => setTimeout(r, 100));
          }
          const before = input.value;
          const bad = 'x'.repeat(200);
          input.value = bad;
          input.dispatchEvent(new Event('change', { bubbles: true }));
          for (let i = 0; i < 30 && input.value === bad; i += 1) {
            await new Promise((r) => setTimeout(r, 100));
          }
          return {
            ok: true,
            cards: document.querySelectorAll('.settings-card').length,
            configDir: document.querySelector('#configDir') ? document.querySelector('#configDir').textContent : '',
            outputDir: document.querySelector('#outputDir') ? document.querySelector('#outputDir').textContent : '',
            hasPickFolder: !!document.querySelector('#btnPickFolder'),
            rolledBack: input.value === before,
            notBad: input.value !== bad
          };
        })()`);
        win.close();
        return result;
      } catch (err) {
        return { ok: false, reason: err.message };
      }
    })();
    const settingsWindowOk = !!(settingsWindowProbe && settingsWindowProbe.ok
      && settingsWindowProbe.cards === 6
      && (settingsWindowProbe.configDir || '').length > 3
      && settingsWindowProbe.configDir !== '（读取中…）' && settingsWindowProbe.configDir !== '（读取失败）'
      && settingsWindowProbe.hasPickFolder
      && (settingsWindowProbe.outputDir || '').length > 1
      && settingsWindowProbe.rolledBack && settingsWindowProbe.notBad);
    console.log('[smoke] 设置窗口结果:', JSON.stringify(settingsWindowProbe));

    // 回归探针：输出目录控件已迁走，「打开」按钮移到比例组右侧
    const outputLayoutProbe = await getMainWindow().webContents.executeJavaScript(`(() => {
      const aspectGroup = document.querySelector('#aspectSelect')?.closest('.group');
      const openBtn = document.querySelector('#btnOpenFolder');
      const saveBtn = document.querySelector('#btnSave');
      const recaptureBtn = document.querySelector('#btnRecapture');
      const openInAspect = !!(aspectGroup && openBtn && aspectGroup.contains(openBtn));
      const btnH = (el) => el ? Math.round(el.getBoundingClientRect().height) : -1;
      const ordered = !!(openBtn && saveBtn && recaptureBtn
        && openBtn.nextElementSibling === saveBtn && saveBtn.nextElementSibling === recaptureBtn);
      const sameSize = btnH(openBtn) === btnH(saveBtn) && btnH(openBtn) === btnH(recaptureBtn);
      return {
        mainHasPickFolder: !!document.querySelector('#btnPickFolder'),
        mainHasOutputDir: !!document.querySelector('#outputDir'),
        openInAspect,
        openIsSelectNextSibling: !!(openBtn && document.querySelector('#aspectSelect')?.nextElementSibling === openBtn),
        saveRecaptureInAspect: !!(aspectGroup && saveBtn && recaptureBtn
          && aspectGroup.contains(saveBtn) && aspectGroup.contains(recaptureBtn)),
        ordered,
        sameSize,
        heights: [btnH(openBtn), btnH(saveBtn), btnH(recaptureBtn)]
      };
    })()`);
    const outputLayoutOk = !outputLayoutProbe.mainHasPickFolder && !outputLayoutProbe.mainHasOutputDir
      && outputLayoutProbe.openInAspect && outputLayoutProbe.openIsSelectNextSibling
      && outputLayoutProbe.saveRecaptureInAspect && outputLayoutProbe.ordered && outputLayoutProbe.sameSize;
    console.log('[smoke] 输出目录布局结果:', JSON.stringify(outputLayoutProbe));

    // 回归探针：无边框窗口的三个自定义控制按钮存在，最大化/还原可往返
    const windowControlsProbe = await getMainWindow().webContents.executeJavaScript(`(async () => {
      const buttons = ['btnMinimize', 'btnMaximize', 'btnClose'].every((id) => !!document.getElementById(id));
      const before = await window.api.getWindowState();
      const first = await window.api.toggleMaximize();
      const second = await window.api.toggleMaximize();
      const after = await window.api.getWindowState();
      return {
        buttons,
        before: before.maximized,
        first: first.maximized,
        second: second.maximized,
        after: after.maximized
      };
    })()`);
    const windowControlsOk = !!(windowControlsProbe && windowControlsProbe.buttons
      && windowControlsProbe.before === false && windowControlsProbe.first === true
      && windowControlsProbe.second === false && windowControlsProbe.after === false);
    console.log('[smoke] 窗口控制结果:', JSON.stringify(windowControlsProbe));

    // 回归探针：拍照态（左主右栏）<-> 裁剪态（左栏右主）动态切换
    const workspaceProbe = await getMainWindow().webContents.executeJavaScript(`(async () => {
      const panes = document.getElementById('panes');
      const preview = document.getElementById('previewPane');
      const edit = document.getElementById('editPane');
      const width = (el) => Math.round(el.getBoundingClientRect().width);
      const snap = () => ({
        mode: window.__wb.getWorkspaceMode(),
        editing: panes.classList.contains('editing'),
        previewWidth: width(preview),
        editWidth: width(edit),
        // 无 src 的裁剪图应隐藏，否则 alt「待裁剪画面」会与占位提示重叠
        cropImgDisplay: getComputedStyle(document.getElementById('cropImage')).display
      });
      // 此时已载入测试图，应处于裁剪态
      const afterShot = snap();
      // 重新拍摄 → 回到拍照态
      document.getElementById('btnRecapture').click();
      await new Promise((r) => setTimeout(r, 100));
      const afterRecapture = snap();
      // 折叠侧栏手动切回裁剪态
      document.getElementById('btnRailEdit').click();
      await new Promise((r) => setTimeout(r, 100));
      const afterRail = snap();
      return { afterShot, afterRecapture, afterRail };
    })()`);
    const initialCaptureOk = !!(probe.workspace && probe.workspace.mode === 'capture'
      && !probe.workspace.editing && probe.workspace.previewWidth > probe.workspace.editWidth);
    const workspaceOk = !!(initialCaptureOk && workspaceProbe
      && workspaceProbe.afterShot.mode === 'edit' && workspaceProbe.afterShot.editing
      && workspaceProbe.afterShot.previewWidth < workspaceProbe.afterShot.editWidth
      && workspaceProbe.afterRecapture.mode === 'capture' && !workspaceProbe.afterRecapture.editing
      && workspaceProbe.afterRecapture.previewWidth > workspaceProbe.afterRecapture.editWidth
      && workspaceProbe.afterRail.mode === 'edit' && workspaceProbe.afterRail.editing
      && workspaceProbe.afterRail.cropImgDisplay === 'none');
    console.log('[smoke] 工作区切换结果:', JSON.stringify({ initial: probe.workspace, ...workspaceProbe, workspaceOk }));

    const report = {
      probe,
      saveResult,
      fileOk,
      panResult,
      panOk,
      boxProbe,
      selectProbe,
      selectOk,
      panSelectProbe,
      panSelectOk,
      modeToggleProbe,
      modeToggleOk,
      whiteboardProbe,
      whiteboardOk,
      reloadProbe,
      reloadOk,
      settingsProbe,
      settingsOk,
      rejectProbe,
      rejectOk,
      settingsWindowProbe,
      settingsWindowOk,
      outputLayoutProbe,
      outputLayoutOk,
      windowControlsProbe,
      windowControlsOk,
      workspaceProbe,
      workspaceOk,
      usageProbe,
      usageFilesOk,
      usageOk,
      savedBytes: savedFile && fs.existsSync(savedFile) ? fs.statSync(savedFile).size : 0,
      screenshot: shotPath
    };
    fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
    console.log('[smoke] 报告已写入:', path.join(outDir, 'report.json'));

    const allOk = probe.cropperLoaded && fileOk && panOk && selectOk && panSelectOk && modeToggleOk && whiteboardOk
      && reloadOk && settingsOk && rejectOk && usageOk && settingsWindowOk && outputLayoutOk && windowControlsOk && workspaceOk;
    console.log('[smoke] 汇总:', JSON.stringify({
      cropperLoaded: probe.cropperLoaded,
      fileOk, panOk, selectOk, panSelectOk, modeToggleOk, whiteboardOk, reloadOk, settingsOk, rejectOk, usageOk,
      settingsWindowOk, outputLayoutOk, windowControlsOk, workspaceOk, allOk
    }));
    app.exit(allOk ? 0 : 2);
  } catch (err) {
    console.error('[smoke] 失败:', err);
    app.exit(1);
  }
}


  return { runAbTest, runShapeTest, runAudit, runSmokeTest };
}

module.exports = { createProbes };
