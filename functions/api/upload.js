export async function onRequestPost(context) {
  const TELEGRAM_BOT_TOKEN = context.env.TELEGRAM_BOT_TOKEN;
  if (!TELEGRAM_BOT_TOKEN) return new Response(JSON.stringify({ success: false, error: '缺少配置' }), { status: 500 });

  try {
    const formData = await context.request.formData();
    const chunk = formData.get('chunk');
    const fileName = formData.get('fileName') || 'video.mp4';

    if (!chunk) return new Response(JSON.stringify({ success: false, error: '未接收到分片二进制数据' }), { status: 400 });

    // 1. 将分片封装，准备空投给 Telegram 服务器
    const tgFormData = new FormData();
    // 使用 Blob 确保 Telegram 正确识别为文档流，防止大文件被压缩
    const fileBlob = new Blob([chunk], { type: 'application/octet-stream' });
    tgFormData.append('document', fileBlob, fileName);
    tgFormData.append('chat_id', '@你的频道或你的ChatID'); // 👈 记得换成你自己的公开频道或私聊ID

    // 2. 扔给 TG 换取 file_id
    const tgRes = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendVideo`, {
      method: 'POST',
      body: tgFormData
    });

    const tgData = await tgRes.json();
    if (!tgData.ok) {
      return new Response(JSON.stringify({ success: false, error: 'Telegram 拒绝接收分片', detail: tgData }), { status: 500 });
    }

    // 3. 🌟 核心优化：直接把 file_id 吐给前端，不碰 KV，0 额度消耗！
    const fileId = tgData.result.video.file_id;
    return new Response(JSON.stringify({ success: true, fileId: fileId }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500 });
  }
}