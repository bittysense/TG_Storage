const CHUNK_SIZE = 10 * 1024 * 1024; // 10MB

export async function onRequestGet(context) {
  const TELEGRAM_BOT_TOKEN = context.env.TELEGRAM_BOT_TOKEN;
  const kv = context.env.TG_STORAGE_KV;
  const { uid } = context.params;

  if (!TELEGRAM_BOT_TOKEN) return new Response('缺少 TG_BOT_TOKEN 配置', { status: 500 });
  if (!kv) return new Response('未绑定 KV', { status: 500 });

  const meta = await kv.get(`file:${uid}`, { type: 'json' });
  if (!meta) return new Response('视频不存在', { status: 404 });

  // 🌟 核心优化：拦截浏览器直接打开直链的行为
  const acceptHeader = context.request.headers.get('accept') || '';
  const url = new URL(context.request.url);
  
  // 如果是浏览器直接访问（想要看 HTML 网页），且 URL 后面没有强制流媒体参数
  if (acceptHeader.includes('text/html') && !url.searchParams.has('stream')) {
    return new Response(getBeautifulPlayerHTML(meta.name, url.href + '?stream=true'), {
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
  }

  // -------------------------------------------------------------
  // 以下为你原本的纯视频流中转逻辑（供给播放器内核或第三方软件）
  // -------------------------------------------------------------
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

// 🌟 嵌入在底部的直链独立美化播放器模板
function getBeautifulPlayerHTML(videoName, rawStreamUrl) {
  return `
    <!DOCTYPE html>
    <html lang="zh-CN">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>正在播放: ${videoName}</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/plyr@3.7.8/dist/plyr.css" />
        <script src="https://cdn.jsdelivr.net/npm/plyr@3.7.8/dist/plyr.polyfilled.min.js"></script>
        <link rel="stylesheet" href="https://npm.elemecdn.com/lxgw-wenkai-webfont@1.1.0/lxgwwenkai-regular.css" />
        <style>
            body {
                font-family: 'LXGW WenKai', sans-serif;
                background: radial-gradient(circle at center, #1e1b4b 0%, #0f172a 100%);
            }
            :root { --plyr-color-main: #6366f1; }
            .plyr { border-radius: 16px; overflow: hidden; box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5); }
        </style>
    </head>
    <body class="text-slate-100 min-h-screen flex items-center justify-center p-4">
        <div class="w-full max-w-4xl space-y-4 animate-fadeIn">
            <div class="flex items-center justify-between px-2">
                <div class="space-y-0.5">
                    <h2 class="text-sm font-semibold text-indigo-400 tracking-wide uppercase">独占云端放映厅</h2>
                    <h1 class="text-lg md:text-xl font-bold text-white line-clamp-1">${videoName}</h1>
                </div>
                <div class="text-right">
                    <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
                        <span class="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-pulse"></span>
                        P2P 节点串流
                    </span>
                </div>
            </div>

            <div class="bg-slate-900/40 backdrop-blur-md p-2 rounded-2xl border border-slate-800/60">
                <video id="player" playsinline controls preload="metadata">
                    <source src="${rawStreamUrl}" type="video/mp4">
                </video>
            </div>

            <div class="flex items-center justify-between text-xs text-slate-500 px-2">
                <p>如遇卡顿，请尝试将下方原始流链接粘贴至 PotPlayer / VLC 播放</p>
                <button onclick="navigator.clipboard.writeText('${rawStreamUrl}'); alert('流媒体源地址已复制！')" class="hover:text-indigo-400 transition font-medium underline">复制原始流地址</button>
            </div>
        </div>

        <script>
            document.addEventListener('DOMContentLoaded', () => {
                const player = new Plyr('#player', {
                    controls: ['play-large', 'play', 'progress', 'current-time', 'duration', 'mute', 'volume', 'captions', 'settings', 'pip', 'airplay', 'fullscreen'],
                    tooltips: { controls: true, seek: true }
                });
                // 自动激活
                player.play();
            });
        </script>
    </body>
    </html>
  `;
}