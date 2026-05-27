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
  // 🌟 核心优化 1：利用 Cloudflare Cache API 拦截对 KV 元数据的频繁读取
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
  // 2. 智能来源判别（如果是浏览器直接打开/Iframe 嵌入，吐出纯净播放器页面）
  // ======================================================================
  if (acceptHeader.includes('text/html') && !url.searchParams.has('stream')) { 
    const rawStreamUrl = url.origin + url.pathname + '?stream=true';

    // 1. 获取请求链接中的 type 参数
    const playType = url.searchParams.get('type'); 

    // 2. 判断：如果用户指定了 type=audio
    if (playType === 'audio') {
        // 🌟 修正点：将准确的 rawStreamUrl 传入，让音乐播放器能获取到真正的二进制流
        return new Response(getMusicCardHTML(meta.name, rawStreamUrl, url), {
            headers: { 'Content-Type': 'text/html;charset=UTF-8' }
        });
    } else {
        // 默认依然渲染成你之前的 16:9 纯净大视频播放器
        return new Response(getBeautifulPlayerHTML(meta.name, rawStreamUrl), {
            headers: { 'Content-Type': 'text/html;charset=UTF-8' }
        });
    }
  }

  // ======================================================================
  // 3. 高性能原生态流媒体中转管道 (无论用户怎么拖动进度条，都不再消耗 KV 额度)
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

// 纯净独立播放器 HTML 模板
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
            html, body { margin: 0; padding: 0; width: 100%; height: 100%; background-color: #000000; overflow: hidden; }
            .plyr { width: 100% !important; height: 100% !important; background-color: #000000; }
            .plyr__video-wrapper { height: 100% !important; }
            video { object-fit: contain !important; }
            :root { --plyr-color-main: #3b82f6; }
        </style>
    </head>
    <body>
        <video id="player" playsinline controls preload="metadata">
            <source src="${rawStreamUrl}" type="video/mp4">
        </video>
        <script>
            document.addEventListener('DOMContentLoaded', () => {
                const player = new Plyr('#player', {
                    controls: ['play-large', 'play', 'progress', 'current-time', 'duration', 'mute', 'volume', 'fullscreen'],
                    tooltips: { controls: true, seek: true },
                    clickToPlay: true
                });
            });
        </script>
    </body>
    </html>
  `;
}

// 🌟 修正升级后的音频卡片模板
function getMusicCardHTML(audioName, rawStreamUrl, url) {
  return `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${audioName}</title>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/plyr@3.7.8/dist/plyr.css" />
    <style>
      body { margin: 0; padding: 0; background: transparent; display: flex; justify-content: center; align-items: center; height: 100vh; overflow: hidden; }
      .music-card { width: 100%; max-width: 580px; height: 130px; background: rgba(35, 35, 35, 0.92); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); border-radius: 12px; display: flex; align-items: center; box-shadow: 0 8px 32px rgba(0,0,0,0.35); overflow: hidden; border: 1px solid rgba(255,255,255,0.08); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; box-sizing: border-box; }
      
      .cover-area { width: 130px; height: 130px; position: relative; flex-shrink: 0; background: linear-gradient(135deg, #282828 0%, #121212 100%); display: flex; align-items: center; justify-content: center; }
      .cover-img { width: 100%; height: 100%; object-fit: cover; filter: brightness(0.65); transition: all 0.5s ease; opacity: 0; position: absolute; top: 0; left: 0; }
      .cover-img.loaded { opacity: 1; }
      
      .default-note { position: absolute; width: 34px; height: 34px; fill: rgba(255,255,255,0.18); transition: all 0.3s ease; }
      .playing .default-note { fill: rgba(59, 130, 246, 0.4); transform: rotate(360deg); transition: all 12px linear infinite; }
      
      .play-btn-overlay { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 44px; height: 44px; border: 2.5px solid rgba(255,255,255,0.75); border-radius: 50%; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,0.2); cursor: pointer; transition: all 0.2s ease; z-index: 10; }
      .play-btn-overlay:hover { background: rgba(0,0,0,0.4); transform: translate(-50%, -50%) scale(1.05); }
      .play-icon { width: 0; height: 0; border-style: solid; border-width: 7px 0 7px 12px; border-color: transparent transparent transparent #ffffff; margin-left: 3px; }
      
      .playing .play-icon { width: 10px; height: 12px; border-style: double; border-width: 0px 0px 0px 10px; border-color: #ffffff; margin-left: 0; }
      .playing .cover-img { filter: brightness(0.75); }
      
      .info-area { flex-grow: 1; padding: 16px 20px; display: flex; flex-direction: column; justify-content: space-between; height: 100%; box-sizing: border-box; overflow: hidden; }
      
      /* 🌟 滚动歌名核心容器：限制最大宽度，隐藏溢出部分 */
      .title-row { display: flex; align-items: center; justify-content: space-between; width: 100%; overflow: hidden; }
      .title-container { flex-grow: 1; overflow: hidden; position: relative; height: 24px; margin-right: 10px; }
      
      /* 🌟 滚动的文字实体：默认靠左静止 */
      .title-text { 
        color: #f5f5f7; 
        font-size: 16px; 
        font-weight: 500; 
        white-space: nowrap; 
        position: absolute;
        left: 0;
        top: 0;
        display: inline-block;
      }
      
      /* 🌟 跑马灯动画效果（字数多时通过 JS 激活该 Class） */
      .marquee {
        animation: scroll-title 8s linear infinite;
        padding-right: 50px; /* 留出空白，防止循环首尾相撞 */
      }
      
      @keyframes scroll-title {
        0% { transform: translate3d(0, 0, 0); }
        10% { transform: translate3d(0, 0, 0); } /* 开头稍微停顿下，方便阅读 */
        90% { transform: translate3d(-50%, 0, 0); } /* 滚动到一半（因为双份拼接） */
        100% { transform: translate3d(-50%, 0, 0); }
      }
      
      .brand-icon { width: 20px; height: 20px; fill: #ea4335; flex-shrink: 0; }
      
      .plyr--audio .plyr__controls { background: transparent !important; padding: 0 !important; color: #b3b3b3 !important; }
      .plyr__controls .plyr__time { font-size: 13px; font-variant-numeric: tabular-nums; }
      .plyr__progress__container { margin-right: 6px !important; }
      .plyr--full-ui input[type=range] { color: #3b82f6 !important; }
    </style>
  </head>
  <body>
    <div class="music-card" id="card-wrapper">
      <div class="cover-area">
        <svg class="default-note" id="fallback-icon" viewBox="0 0 24 24"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>
        <img class="cover-img" id="netease-cover" alt="Cover">
        <div class="play-btn-overlay" onclick="togglePlay()"><div class="play-icon" id="state-icon"></div></div>
      </div>
      <div class="info-area">
        <div class="title-row">
          <div class="title-container" id="t-container">
            <span class="title-text" id="display-title">${audioName}</span>
          </div>
          <svg class="brand-icon" viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14H9v-2h2v2zm0-4H9V7h2v5z"/></svg>
        </div>
        <audio id="audio-player" src="${rawStreamUrl}"></audio>
      </div>
    </div>

    <script src="https://cdn.jsdelivr.net/npm/plyr@3.7.8/dist/plyr.polyfilled.min.js"></script>
    <script>
      const player = new Plyr('#audio-player', { controls: ['progress', 'current-time'], clickToPlay: false });
      const wrapper = document.getElementById('card-wrapper');
      function togglePlay() { player.togglePlay(); }
      player.on('play', () => wrapper.classList.add('playing'));
      player.on('pause', () => wrapper.classList.remove('playing'));

      window.addEventListener('DOMContentLoaded', () => {
        const rawTitle = "${audioName}";
        const cleanQuery = rawTitle.replace(/\\.[^/.]+$/, "").trim();
        
        // 🌟 1. 智能检测文字宽度是否超出了容器
        const container = document.getElementById('t-container');
        const titleEl = document.getElementById('display-title');
        
        if (titleEl.offsetWidth > container.offsetWidth) {
          // 如果字数太多放不下，把文字复制一份拼在后面，并开启动画
          titleEl.innerHTML = cleanQuery + "&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;" + cleanQuery;
          titleEl.classList.add('marquee');
          // 根据歌名长度动态计算滚动时间，长歌名滚慢点，短歌名滚快点
          titleEl.style.animationDuration = Math.max(6, Math.floor(cleanQuery.length * 0.4)) + 's';
        } else {
          // 放得下就只显示清洗后的歌名，静止不动
          titleEl.innerHTML = cleanQuery;
        }

        // 2. 正常请求网易云封面
        const searchUrl = \`https://music.163.com/api/search/get/web?s=\${encodeURIComponent(cleanQuery)}&type=1&limit=1\`;
        fetch(searchUrl)
          .then(res => res.json())
          .then(data => {
            if (data && data.result && data.result.songs && data.result.songs.length > 0) {
              const targetSong = data.result.songs[0];
              if (targetSong.album && targetSong.album.picUrl) {
                const imgElement = document.getElementById('netease-cover');
                const hdCoverUrl = targetSong.album.picUrl.replace("http://", "https://") + "?param=130y130";
                imgElement.src = hdCoverUrl;
                imgElement.onload = () => {
                  imgElement.classList.add('loaded');
                  document.getElementById('fallback-icon').style.display = 'none';
                };
              }
            }
          }).catch(err => console.log('网易云封面未命中:', err));
      });
    </script>
  </body>
  </html>
  `;
}