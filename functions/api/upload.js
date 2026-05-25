export async function onRequestPost(context) {
  try {
    // 从环境变量中安全读取 TG 参数
    const TELEGRAM_BOT_TOKEN = context.env.TELEGRAM_BOT_TOKEN;
    const TELEGRAM_CHAT_ID = context.env.TELEGRAM_CHAT_ID;
    const kv = context.env.TG_STORAGE_KV;

    // 检查参数是否存在
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
      return new Response('缺少 Telegram 环境变量配置', { status: 500 });
    }
    if (!kv) return new Response('未绑定 KV 命名空间', { status: 500 });

    const formData = await context.request.formData();
    const fileUid = formData.get('uid');
    const chunkIndex = parseInt(formData.get('chunkIndex'));
    const totalChunks = parseInt(formData.get('totalChunks'));
    const fileName = formData.get('fileName');
    const fileSize = parseInt(formData.get('fileSize'));
    const chunkFile = formData.get('chunk');

    // 1. 转发分片到 Telegram
    const tgFormData = new FormData();
    tgFormData.append('chat_id', TELEGRAM_CHAT_ID);
    tgFormData.append('video', chunkFile, `${fileName}.part${chunkIndex}`);

    const tgRes = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendVideo`, {
      method: 'POST',
      body: tgFormData
    });

    const tgData = await tgRes.json();
    if (!tgData.ok) {
      return new Response(JSON.stringify({ error: 'TG上传失败', details: tgData }), { status: 500 });
    }

    const tgFileId = tgData.result.video.file_id;

    // 2. 写入 KV 账本
    const metaKey = `file:${fileUid}`;
    let meta = await kv.get(metaKey, { type: 'json' });
    if (!meta) {
      meta = { name: fileName, size: fileSize, totalChunks: totalChunks, chunks: [] };
    }
    meta.chunks[chunkIndex] = tgFileId;
    await kv.put(metaKey, JSON.stringify(meta));

    return new Response(JSON.stringify({ success: true, chunkIndex }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}