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