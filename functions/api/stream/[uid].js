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

// 🌟 嵌入在底部的无边框纯净播放器模板（去除了所有多余文字和布局，完美支持 iframe 嵌入）
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
        <style>
            /* 彻底移除所有浏览器默认边距与滚动条 */
            html, body {
                margin: 0;
                padding: 0;
                width: 100%;
                height: 100%;
                background-color: #000000;
                overflow: hidden;
            }
            /* 让 Plyr 播放器容器绝对撑满整个屏幕 */
            .plyr {
                width: 100% !important;
                height: 100% !important;
                background-color: #000000;
            }
            /* 适配部分平台 iframe 比例拉伸问题 */
            .plyr__video-wrapper {
                height: 100% !important;
            }
            video {
                object-fit: contain !important;
            }
            /* 定制播放器主题色（极客蓝） */
            :root {
                --plyr-color-main: #3b82f6;
            }
        </style>
    </head>
    <body>

        <video id="player" playsinline controls preload="metadata">
            <source src="${rawStreamUrl}" type="video/mp4">
        </video>

        <script>
            document.addEventListener('DOMContentLoaded', () => {
                const player = new Plyr('#player', {
                    // 保留最核心、纯净的控制组件
                    controls: [
                        'play-large',    // 居中大播放按钮
                        'play',          // 播放/暂停
                        'progress',      // 进度条
                        'current-time',  // 当前时间
                        'duration',      // 总时长
                        'mute',          // 静音
                        'volume',        // 音量调节
                        'fullscreen'     // 全屏
                    ],
                    tooltips: { controls: true, seek: true },
                    clickToPlay: true // 点击视频区域切换播放/暂停
                });
                
                // 尝试自动播放（注意：部分浏览器为了防止打扰用户，会拦截带声音的自动播放）
                player.play().catch(err => {
                    console.log("浏览器限制了带声自动播放，等待用户点击交互");
                });
            });
        </script>
    </body>
    </html>
  `;
}