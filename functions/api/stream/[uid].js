const CHUNK_SIZE = 10 * 1024 * 1024; // 10MB 历史兼容分片物理标尺

export async function onRequestGet(context) {
  const TELEGRAM_BOT_TOKEN = context.env.TELEGRAM_BOT_TOKEN;
  const kv = context.env.TG_STORAGE_KV;
  const { uid } = context.params;

  if (!TELEGRAM_BOT_TOKEN) return new Response('缺少配置', { status: 500 });
  if (!kv) return new Response('未绑定 KV', { status: 500 });

  const url = new URL(context.request.url);
  const acceptHeader = context.request.headers.get('accept') || '';

  // ======================================================================
  // 🌟 核心优化 1：Cache API 拦截 KV
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
  // 🌟 核心优化 2：智能来源判别（将修改后的无黑边弹性模板返回给浏览器/Obsidian）
  // ======================================================================
  if (acceptHeader.includes('text/html') && !url.searchParams.has('stream')) {
    const rawStreamUrl = url.origin + url.pathname + '?stream=true';
    return new Response(getBeautifulPlayerHTML(meta.name, rawStreamUrl), {
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
  }

  // ======================================================================
  // 3. 高性能原生态流媒体中转管道 (保持原样不动)
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
      'video/mp4': 'video/mp4',
      'Accept-Ranges': 'bytes',
      'Content-Range': `bytes ${start}-${end}/${totalSize}`,
      'Content-Length': String(end - start + 1),
      'Content-Disposition': `inline; filename="${encodeURIComponent(meta.name)}"`
    }
  });
}

// 🌟 重新校准：纯净独立播放器 HTML 弹性模板
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
            /* 💥 核心改动：放开全部高度限制，允许沙盒被视频等比例向下撑开 */
            html, body { 
                margin: 0; 
                padding: 0; 
                width: 100%; 
                height: auto; 
                background-color: transparent; 
                overflow: hidden; 
            }
            
            /* 让 Plyr 骨架打破默认的 16:9 硬编码硬塑性 */
            .plyr { 
                width: 100% !important; 
                height: auto !important; 
                background-color: transparent !important; 
            }
            
            /* 锁定视频实体自适应尺寸 */
            video { 
                display: block;
                width: 100% !important; 
                height: auto !important; 
                object-fit: contain !important; 
            }
            :root { --plyr-color-main: #3b82f6; }
        </style>
    </head>
    <body>
        <div id="player-container">
            <video id="player" playsinline controls preload="metadata">
                <source src="${rawStreamUrl}" type="video/mp4">
            </video>
        </div>
        <script>
            document.addEventListener('DOMContentLoaded', () => {
                const player = new Plyr('#player', {
                    controls: ['play-large', 'play', 'progress', 'current-time', 'duration', 'mute', 'volume', 'fullscreen'],
                    tooltips: { controls: true, seek: true },
                    clickToPlay: true
                });

                player.play().catch(() => {});

                // 🌟 核心魔法：尺寸监听，主动反向去顶开外部 Obsidian 的 iframe 外壳
                const container = document.getElementById('player-container');
                
                function sendHeightToParent() {
                    // 获取 Plyr 加载渲染完成后的精准物理高度
                    const currentHeight = container.offsetHeight;
                    if (currentHeight > 0) {
                        // 如果在同域（或者直接支持元素控制），直接暴力穿透改外层样式
                        if (window.frameElement) {
                            window.frameElement.style.height = currentHeight + 'px';
                        } else {
                            // 跨域沙盒兼容方案
                            window.parent.postMessage({ type: 'resize-video-iframe', height: currentHeight }, '*');
                        }
                    }
                }

                // 视频拿到长宽数据的瞬间、以及窗口缩放时，立刻计算尺寸
                player.on('ready', () => {
                    setTimeout(sendHeightToParent, 200); // 延时 200ms 等待 Plyr UI 渲染完毕
                });
                window.addEventListener('resize', sendHeightToParent);
            });
        </script>
    </body>
    </html>
  `;
}