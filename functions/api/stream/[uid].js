const CHUNK_SIZE = 10 * 1024 * 1024; // 严格限制 10MB 分片大小

export async function onRequestGet(context) {
  const TELEGRAM_BOT_TOKEN = context.env.TELEGRAM_BOT_TOKEN;
  const kv = context.env.TG_STORAGE_KV;
  const { uid } = context.params;

  if (!TELEGRAM_BOT_TOKEN) return new Response('缺少 TELEGRAM_BOT_TOKEN 环境变量配置', { status: 500 });
  if (!kv) return new Response('未绑定 TG_STORAGE_KV 命名空间', { status: 500 });

  // 1. 从 KV 账本中提取视频的元数据信息
  const meta = await kv.get(`file:${uid}`, { type: 'json' });
  if (!meta) return new Response('该视频资产不存在或已被清理', { status: 404 });

  // 2. 🌟 智能判别核心：拦截浏览器的直接访问（或 Iframe 挂载行为）
  const acceptHeader = context.request.headers.get('accept') || '';
  const url = new URL(context.request.url);
  
  // 当检测到浏览器偏好 HTML，且当前请求不带有强制流媒体标签（?stream=true）时，渲染嵌入式网页播放器
  if (acceptHeader.includes('text/html') && !url.searchParams.has('stream')) {
    // 动态生成一个指向自身的纯视频流链接
    const rawStreamUrl = url.origin + url.pathname + '?stream=true';
    return new Response(getBeautifulPlayerHTML(meta.name, rawStreamUrl), {
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
  }

  // ----------------------------------------------------------------------
  // 3. 原生 HTTP Range 流媒体管道逻辑（供给外部播放器或内层网页播放器内核）
  // ----------------------------------------------------------------------
  const totalSize = meta.size;
  const rangeHeader = context.request.headers.get('range');

  let start = 0;
  let end = totalSize - 1;

  // 解析 Range 请求区间，实现流式快进拖动
  if (rangeHeader) {
    const parts = rangeHeader.replace(/bytes=/, "").split("-");
    start = parseInt(parts[0], 10);
    if (parts[1]) end = parseInt(parts[1], 10);
  }

  const startChunkIndex = Math.floor(start / CHUNK_SIZE);
  const endChunkIndex = Math.floor(end / CHUNK_SIZE);

  // 建立 Cloudflare 边缘高性能转换流
  const { readable, writable } = new TransformStream();

  (async () => {
    const writer = writable.getWriter();
    try {
      for (let i = startChunkIndex; i <= endChunkIndex; i++) {
        const fileId = meta.chunks[i];
        if (!fileId) continue;

        // 向 Telegram 服务器换取分片真实落地 URL
        const pathRes = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`);
        const pathData = await pathRes.json();
        if (!pathData.ok) break;

        const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${pathData.result.file_path}`;
        
        // 精准裁剪当前切片中所需的字节范围
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
          await writer.write(value); // 将电报二进制分片无缝泵入回传流
        }
      }
    } catch (e) {
      console.error('分片拼接中转发生异常:', e);
    } finally {
      await writer.close();
    }
  })();

  // 响应流媒体状态
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

// 🌟 核心：无边框纯净独立播放器 HTML 模块模板
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
            /* 抹平浏览器默认间距，防止 iframe 嵌入时出现双滚动条 */
            html, body {
                margin: 0;
                padding: 0;
                width: 100%;
                height: 100%;
                background-color: #000000;
                overflow: hidden;
            }
            /* 让播放器界面绝对撑满视窗 */
            .plyr {
                width: 100% !important;
                height: 100% !important;
                background-color: #000000;
            }
            .plyr__video-wrapper {
                height: 100% !important;
            }
            video {
                object-fit: contain !important;
            }
            /* 定制播放器主题颜色（极客蓝） */
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
                    controls: [
                        'play-large',    // 大居中播放键
                        'play',          // 播放/暂停
                        'progress',      // 进度条
                        'current-time',  // 当前时长
                        'duration',      // 总时长
                        'mute',          // 静音开关
                        'volume',        // 音量轴
                        'fullscreen'     // 全屏切换
                    ],
                    tooltips: { controls: true, seek: true },
                    clickToPlay: true
                });
                
                // 调度策略：静音尝试自动播放，若失败则常态挂起等待交互
                player.play().catch(() => {
                    console.log("核心提示: 受浏览器政策限制，已转为等待手动激活。");
                });
            });
        </script>
    </body>
    </html>
  `;
}