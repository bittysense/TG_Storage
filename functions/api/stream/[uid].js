const CHUNK_SIZE = 10 * 1024 * 1024; // 10MB 分片

export async function onRequestGet(context) {
  const TELEGRAM_BOT_TOKEN = context.env.TELEGRAM_BOT_TOKEN;
  const kv = context.env.TG_STORAGE_KV;
  const { uid } = context.params;

  if (!TELEGRAM_BOT_TOKEN) return new Response('缺少配置', { status: 500 });
  if (!kv) return new Response('未绑定 KV', { status: 500 });

  const url = new URL(context.request.url);
  const acceptHeader = context.request.headers.get('accept') || '';

  // ======================================================================
  // 1. 利用 Cloudflare Cache API 拦截对 KV 元数据的频繁读取 (保持原样)
  // ======================================================================
  const cache = caches.default;
  const metaCacheUrl = new URL(`${url.origin}/api/internal/meta/${uid}`);
  let cacheResponse = await cache.match(metaCacheUrl);
  
  let meta;
  if (cacheResponse) {
    meta = await cacheResponse.json();
  } else {
    meta = await kv.get(`file:${uid}`, { type: 'json' });
    if (!meta) return new Response('视频不存在', { status: 404 });

    const responseToCache = new Response(JSON.stringify(meta), {
      headers: { 'Cache-Control': 'public, max-age=604800' }
    });
    context.waitUntil(cache.put(metaCacheUrl, responseToCache));
  }

  // ======================================================================
  // 2. 智能来源判别（如果是浏览器直接打开/Iframe 嵌入，吐出带歌词解析的播放器页面）
  // ======================================================================
  if (acceptHeader.includes('text/html') && !url.searchParams.has('stream')) {
    const rawStreamUrl = url.origin + url.pathname + '?stream=true';
    return new Response(getBeautifulPlayerHTML(meta.name, rawStreamUrl), {
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
  }

  // ======================================================================
  // 3. 高性能原生态流媒体中转管道 (保持原样)
  // ======================================================================
  const totalSize = meta.size;
  const rangeHeader = context.request.headers.get('range');

  let start = 0;
  let end = totalSize - 1;

  if (rangeHeader) {
    const parts = rangeHeader.replace(/bytes=/, "").split("-");
    start = parseInt(parts[0], 10);
    if (parts[1]) end = parseInt(parts[1], 10);
  }

  const startChunkIndex = Math.floor(start / CHUNK_SIZE);
  const endChunkIndex = Math.floor(end / CHUNK_SIZE);

  const { readable, writable } = new TransformStream();

  (async () => {
    const writer = writable.getWriter();
    try {
      for (let i = startChunkIndex; i <= endChunkIndex; i++) {
        const fileId = meta.chunks[i];
        if (!fileId) continue;

        const pathRes = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`);
        const pathData = await pathRes.json();
        if (!pathData.ok) break;

        const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${pathData.result.file_path}`;
        
        const chunkStartBound = i * CHUNK_SIZE;
        const neededStartInChunk = Math.max(0, start - chunkStartBound);
        const neededEndInChunk = Math.min(CHUNK_SIZE - 1, end - chunkStartBound);

        const chunkResponse = await fetch(fileUrl, {
          headers: { 'Range': `bytes=${neededStartInChunk}-${neededEndInChunk}` }
        });

        const reader = chunkResponse.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          await writer.write(value);
        }
      }
    } catch (e) {
      console.error(e);
    } finally {
      await writer.close();
    }
  })();

  return new Response(readable, {
    status: rangeHeader ? 206 : 200,
    headers: {
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes',
      'Content-Range': `bytes ${start}-${end}/${totalSize}`,
      'Content-Length': String(end - start + 1),
      'Content-Disposition': `inline; filename="${encodeURIComponent(meta.name)}"`
    }
  });
}

// 🌟 纯净独立播放器 HTML 模板（引入 jsmediatags 实时解析音频文件内嵌歌词）
function getBeautifulPlayerHTML(videoName, rawStreamUrl) {
  return `
    <!DOCTYPE html>
    <html lang="zh-CN">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${videoName}</title>
        <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/plyr@3.7.8/dist/plyr.css" />
        <script src="https://cdn.jsdelivr.net/npm/plyr@3.7.8/dist/plyr.polyfilled.min.js"></script>
        
        <script src="https://cdn.jsdelivr.net/npm/jsmediatags@3.9.5/dist/jsmediatags.min.js"></script>
        
        <style>
            html, body { margin: 0; padding: 0; width: 100%; height: 100%; background-color: #000000; overflow: hidden; }
            .plyr { width: 100% !important; height: 100% !important; background-color: #000000; }
            .plyr__video-wrapper { height: 100% !important; }
            video { object-fit: contain !important; }
            :root { --plyr-color-main: #3b82f6; }
            
            /* 🌟 核心改动 2：美化歌词的显示样式，字号调大，居中清晰显示 */
            .plyr--captions .plyr__caption {
                font-size: 22px !important;
                background: rgba(0, 0, 0, 0.6) !important;
                padding: 8px 20px !important;
                border-radius: 6px !important;
                font-weight: bold;
                line-height: 1.4;
            }
        </style>
    </head>
    <body>
        <video id="player" playsinline controls preload="metadata">
            <source src="${rawStreamUrl}" type="video/mp4">
            <track kind="captions" label="内嵌同步歌词" srclang="zh" src="" id="lyric-track" default />
        </video>
        <script>
            // 🛠️ 辅助函数：将传统 LRC 歌词格式 [00:12.34] 实时转换为 Plyr 认识的标准 WebVTT 格式
            function parseLrcToVtt(lrcText) {
                if (!lrcText) return null;
                const lines = lrcText.split(/\\r?\\n/);
                let vttText = "WEBVTT\\n\\n";
                let count = 0;
                const timeLyricPairs = [];

                for (let line of lines) {
                    const matches = line.match(/\\[(\\d{2}):(\\d{2})\\.(\\d{2,3})\\](.*)/);
                    if (matches) {
                        const mins = parseInt(matches[1], 10);
                        const secs = parseInt(matches[2], 10);
                        let ms = matches[3];
                        if (ms.length === 2) ms += "0"; // 补齐三位毫秒
                        const text = matches[4].trim();
                        const totalSeconds = mins * 60 + secs + parseFloat("0." + ms);
                        timeLyricPairs.push({ time: totalSeconds, text: text });
                    }
                }

                // 排序时间轴
                timeLyricPairs.sort((a, b) => a.time - b.time);

                // 生成 VTT 区间
                for (let i = 0; i < timeLyricPairs.length; i++) {
                    const start = timeLyricPairs[i].time;
                    const end = (i < timeLyricPairs.length - 1) ? timeLyricPairs[i + 1].time : start + 5.0;
                    if (!timeLyricPairs[i].text) continue;

                    const formatTime = (t) => {
                        const m = Math.floor(t / 60).toString().padStart(2, '0');
                        const s = Math.floor(t % 60).toString().padStart(2, '0');
                        const ms = Math.floor((t % 1) * 1000).toString().padStart(3, '0');
                        return \`00:\${m}:\${s}.\${ms}\`;
                    };

                    vttText += \`\${formatTime(start)} --> \${formatTime(end)}\\n\${timeLyricPairs[i].text}\\n\\n\`;
                    count++;
                }
                return count > 0 ? vttText : null;
            }

            document.addEventListener('DOMContentLoaded', () => {
                const player = new Plyr('#player', {
                    // 🌟 核心改动 4：控制条工具里增加了 'captions'（字幕开关切换按钮）
                    controls: ['play-large', 'play', 'progress', 'current-time', 'duration', 'mute', 'volume', 'captions', 'fullscreen'],
                    tooltips: { controls: true, seek: true },
                    clickToPlay: true,
                    captions: { active: true, update: true, language: 'zh' } // 默认强制激活字幕展现
                });

                // 🌟 核心改动 5：流式解析音频文件的内嵌 ID3 标签（只请求头尾几张切片，不消耗多余流量）
                jsmediatags.read("${rawStreamUrl}", {
                    onSuccess: function(tag) {
                        // 寻找音频内嵌歌词（通常存放在 1D3v2 的 lyrics 或者是 USLT 帧中）
                        const rawLyrics = tag.tags.lyrics ? tag.tags.lyrics.lyrics : null;
                        
                        if (rawLyrics) {
                            console.log("🎉 成功探知到音频文件内部的内嵌歌词资产！");
                            const vttContent = parseLrcToVtt(rawLyrics);
                            
                            if (vttContent) {
                                // 本地把歌词字符串转为 Blob 虚拟直链，直接塞给 track 标签
                                const blob = new Blob([vttContent], { type: 'text/vtt' });
                                const trackUrl = URL.createObjectURL(blob);
                                const trackElement = document.getElementById('lyric-track');
                                trackElement.src = trackUrl;
                                
                                // 强制重新唤醒刷新 Plyr 的字幕渲染组件
                                setTimeout(() => { player.toggleCaptions(true); }, 300);
                            }
                        }
                    },
                    onError: function(error) {
                        console.log("元数据解析：该媒体文件未包含内嵌 LRC 歌词数据。");
                    }
                });

                player.play().catch(() => {});
            });
        </script>
    </body>
    </html>
  `;
}